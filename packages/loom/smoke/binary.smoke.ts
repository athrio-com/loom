import { describe, expect, it } from 'bun:test'
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type TextEdit,
} from '@volar/language-server/node'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { servicePackage, serviceVersion } from '@athrio/loom-lang-services/LoomStore'
import { runtimeKey } from '@athrio/loom-lang-services/Runtime'

const cli = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const binary = resolve(cli, 'build', process.platform === 'win32' ? 'loom.exe' : 'loom')

const scratch = (name: string): string =>
  realpathSync(mkdtempSync(join(tmpdir(), `loom-smoke-${name}-`)))

const emptyPath = scratch('path')

const nowhere = 'http://127.0.0.1:9/'

const bareEnv = (extra: Record<string, string> = {}): Record<string, string> => ({
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && entry[0].toUpperCase() !== 'PATH',
    ),
  ),
  PATH: emptyPath,
  NPM_CONFIG_REGISTRY: nowhere,
  ...extra,
})

const run = async (
  args: ReadonlyArray<string>,
  options: {
    readonly cwd: string
    readonly env: Record<string, string>
    readonly executable?: string
  },
) => {
  const child = Bun.spawn([options.executable ?? binary, ...args], {
    cwd: options.cwd,
    env: options.env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { status, stdout, stderr }
}

const SMOKE_TIMEOUT = 60_000

const lines = (...rows: ReadonlyArray<string>): string => `${rows.join('\n')}\n`

const anchor = (name: string): string => `::${'['}${name}]`

const workspace = (...config: ReadonlyArray<string>): string => {
  const dir = scratch('workspace')
  mkdirSync(join(dir, '.loom'), { recursive: true })
  writeFileSync(join(dir, '.loom', 'config.yaml'), lines(...config))
  return dir
}

const helloLoom = lines(
  '---',
  'Language: TypeScript',
  '---',
  '',
  '# Hello [hello.ts]',
  '',
  '=>',
  '',
  anchor('Greeting'),
  '',
  "console.log(greet('world'))",
  '',
  '# Greeting',
  '',
  '=>',
  '',
  "const greet = (name: string): string => 'Hello, ' + name",
)

describe('the executable — tangling', () => {
  it(
    'reports its version',
    async () => {
      const { status, stdout, stderr } = await run(['--version'], { cwd: scratch('version'), env: bareEnv() })
      expect({ status, stderr }).toMatchObject({ status: 0 })
      expect(stdout).toContain(`loom v${serviceVersion}`)
    },
    SMOKE_TIMEOUT,
  )

  it(
    'tangles a loom in a folder with no node_modules',
    async () => {
      const dir = workspace('corpus: .', 'primary: typescript')
      writeFileSync(join(dir, 'hello.loom'), helloLoom)
      const { status, stderr } = await run(['tangle', 'hello.loom'], { cwd: dir, env: bareEnv() })
      expect({ status, stderr }).toMatchObject({ status: 0 })
      const tangled = readFileSync(join(dir, 'hello.ts'), 'utf8')
      expect(tangled).toContain("const greet = (name: string): string => 'Hello, ' + name")
      expect(tangled).toContain("console.log(greet('world'))")
      rmSync(dir, { recursive: true, force: true })
    },
    SMOKE_TIMEOUT,
  )
})

const standIn = lines(
  `const { Effect } = globalThis.${runtimeKey}.modules.effect`,
  'export default {',
  "  id: 'typescript',",
  "  displayName: 'TypeScript',",
  "  extensions: ['.ts'],",
  '  plugins: () => Effect.succeed([]),',
  "  format: (request) => Effect.succeed(request.code.replaceAll('  ', ' ')),",
  '}',
)

const writeStandIn = (folder: string): void => {
  mkdirSync(join(folder, 'dist'), { recursive: true })
  writeFileSync(
    join(folder, 'package.json'),
    JSON.stringify({
      name: servicePackage('typescript'),
      version: serviceVersion,
      type: 'module',
      exports: { '.': './dist/index.js' },
    }),
  )
  writeFileSync(join(folder, 'dist', 'index.js'), standIn)
}

const installStandIn = (root: string): void =>
  writeStandIn(join(root, '.loom', 'services', 'node_modules', servicePackage('typescript')))

const standInTarball = (): Uint8Array => {
  const dir = scratch('tarball')
  writeStandIn(join(dir, 'package'))
  Bun.spawnSync(['tar', '-czf', 'service.tgz', 'package'], { cwd: dir })
  const packed = new Uint8Array(readFileSync(join(dir, 'service.tgz')))
  rmSync(dir, { recursive: true, force: true })
  return packed
}

const registryServer = (tarball: Uint8Array) =>
  Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request) => {
      const name = servicePackage('typescript')
      const path = decodeURIComponent(new URL(request.url).pathname)
      if (path === `/${name}`)
        return Response.json({
          name,
          'dist-tags': { latest: serviceVersion },
          versions: {
            [serviceVersion]: {
              name,
              version: serviceVersion,
              dist: {
                tarball: new URL('/service.tgz', request.url).href,
                integrity: `sha512-${createHash('sha512').update(tarball).digest('base64')}`,
              },
            },
          },
        })
      if (path === '/service.tgz') return new Response(tarball)
      return new Response('not found', { status: 404 })
    },
  })


describe('the executable — languages', () => {
  it(
    'finds a current service in the store and leaves it alone',
    async () => {
      const dir = workspace('corpus: .', 'languages:', '  typescript: {}', 'primary: typescript')
      installStandIn(dir)
      const { status, stdout, stderr } = await run(['update', 'typescript'], { cwd: dir, env: bareEnv() })
      expect({ status, stderr }).toMatchObject({ status: 0 })
      expect(stdout).toContain('is already in the store')
      rmSync(dir, { recursive: true, force: true })
    },
    SMOKE_TIMEOUT,
  )

  it(
    'installs a service the store lacks, acting as its own package manager',
    async () => {
      const dir = workspace('corpus: .', 'languages:', '  typescript: {}', 'primary: typescript')
      const registry = registryServer(standInTarball())
      const { status, stdout, stderr } = await run(['update', 'typescript'], {
        cwd: dir,
        env: bareEnv({ NPM_CONFIG_REGISTRY: registry.url.href }),
      })
      registry.stop()
      expect({ status, stderr }).toMatchObject({ status: 0 })
      expect(stdout).toContain(`installed ${servicePackage('typescript')} ${serviceVersion}`)
      const manifest = join(
        dir,
        '.loom',
        'services',
        'node_modules',
        servicePackage('typescript'),
        'package.json',
      )
      expect(JSON.parse(readFileSync(manifest, 'utf8')).version).toBe(serviceVersion)
      rmSync(dir, { recursive: true, force: true })
    },
    SMOKE_TIMEOUT,
  )
})

const loomOf = (code: string): string =>
  lines('---', 'Language: TypeScript', '---', '', '# Answer', '', '=>', '', code)

const editorAt = async (folder: string) => {
  const child = spawn(binary, ['lsp', '--stdio'], {
    cwd: folder,
    env: bareEnv(),
    stdio: ['pipe', 'pipe', 'ignore'],
  })
  const connection = createMessageConnection(
    new StreamMessageReader(child.stdout),
    new StreamMessageWriter(child.stdin),
  )
  connection.onRequest(() => null)
  connection.listen()
  const close = (): void => {
    connection.dispose()
    child.kill()
  }
  return { connection, close }
}

describe('the executable — language server', () => {
  it(
    'unpacks the TypeScript it carries and formats with a service from the store',
    async () => {
      const dir = workspace('corpus: .', 'languages:', '  typescript: {}', 'primary: typescript')
      installStandIn(dir)
      const loom = join(dir, 'answer.loom')
      writeFileSync(loom, loomOf('const  answer  =  42'))
      const { connection, close } = await editorAt(dir)
      try {
        await connection.sendRequest('initialize', {
          processId: process.pid,
          rootUri: pathToFileURL(dir).href,
          workspaceFolders: [{ uri: pathToFileURL(dir).href, name: 'smoke' }],
          capabilities: {},
        })
        await connection.sendNotification('initialized', {})
        expect(
          existsSync(
            join(dir, '.loom', 'services', 'node_modules', 'typescript', 'lib', 'lib.es5.d.ts'),
          ),
        ).toBe(true)
        await connection.sendNotification('textDocument/didOpen', {
          textDocument: {
            uri: pathToFileURL(loom).href,
            languageId: 'loom',
            version: 1,
            text: readFileSync(loom, 'utf8'),
          },
        })
        const edits =
          (await connection.sendRequest<TextEdit[] | null>('textDocument/formatting', {
            textDocument: { uri: pathToFileURL(loom).href },
            options: { tabSize: 2, insertSpaces: true },
          })) ?? []
        expect(edits.map((edit) => edit.newText)).toEqual([loomOf('const answer = 42')])
      } finally {
        close()
        rmSync(dir, { recursive: true, force: true })
      }
    },
    SMOKE_TIMEOUT,
  )
})

describe('the executable — editors', () => {
  it(
    'gives Helix the grammar it carries, with no compiler',
    async () => {
      const config = scratch('helix')
      const { status, stderr } = await run(['helix'], {
        cwd: config,
        env: bareEnv({ XDG_CONFIG_HOME: config, APPDATA: config }),
      })
      expect({ status, stderr }).toMatchObject({ status: 0 })
      const library = process.platform === 'win32' ? 'loom.dll' : 'loom.so'
      expect(existsSync(join(config, 'helix', 'runtime', 'grammars', library))).toBe(true)
      expect(existsSync(join(config, 'helix', 'runtime', 'queries', 'loom', 'highlights.scm'))).toBe(
        true,
      )
      rmSync(config, { recursive: true, force: true })
    },
    SMOKE_TIMEOUT,
  )

  it(
    'gives Neovim the grammar it carries, with no compiler',
    async () => {
      const data = scratch('nvim')
      const { status, stderr } = await run(['nvim'], {
        cwd: data,
        env: bareEnv({ XDG_DATA_HOME: data, LOCALAPPDATA: data, NVIM_APPNAME: 'nvim' }),
      })
      expect({ status, stderr }).toMatchObject({ status: 0 })
      const site = join(data, process.platform === 'win32' ? 'nvim-data' : 'nvim', 'site')
      expect(existsSync(join(site, 'parser', 'loom.so'))).toBe(true)
      expect(existsSync(join(site, 'queries', 'loom', 'highlights.scm'))).toBe(true)
      rmSync(data, { recursive: true, force: true })
    },
    SMOKE_TIMEOUT,
  )
})

const assetName =
  process.platform === 'win32'
    ? `loom-windows-${process.arch}.exe.gz`
    : `loom-${process.platform}-${process.arch}.gz`

const replacement = new TextEncoder().encode(lines('#!/bin/sh', 'echo upgraded'))

const archive = Bun.gzipSync(replacement)

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

const releaseServer = (tag: string, listed: string) =>
  Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request) => {
      const base = new URL('/', request.url).href
      const path = new URL(request.url).pathname
      if (path === '/releases/latest')
        return Response.json({
          tag_name: tag,
          assets: [
            { name: assetName, browser_download_url: `${base}executable` },
            { name: 'SHA256SUMS', browser_download_url: `${base}sums` },
          ],
        })
      if (path === '/executable') return new Response(archive)
      if (path === '/sums') return new Response(`${listed}  ${assetName}\n`)
      return new Response('not found', { status: 404 })
    },
  })

const upgradeCopy = async (tag: string, listed: string) => {
  const server = releaseServer(tag, listed)
  const dir = scratch('upgrade')
  const copy = join(dir, process.platform === 'win32' ? 'loom.exe' : 'loom')
  copyFileSync(binary, copy)
  chmodSync(copy, 0o755)
  const result = await run(['upgrade'], {
    cwd: dir,
    env: bareEnv({ LOOM_RELEASES: new URL('/releases', server.url).href }),
    executable: copy,
  })
  server.stop()
  return { ...result, dir, copy }
}

describe('the executable — upgrade', () => {
  it(
    'replaces itself with a newer release whose checksum matches',
    async () => {
      const { status, stderr, dir, copy } = await upgradeCopy('v99.0.0', sha256(archive))
      expect({ status, stderr }).toMatchObject({ status: 0 })
      expect(sha256(new Uint8Array(readFileSync(copy)))).toBe(sha256(replacement))
      if (process.platform === 'win32') expect(existsSync(`${copy}.old`)).toBe(true)
      else expect((await run([], { cwd: dir, env: bareEnv(), executable: copy })).stdout).toContain('upgraded')
      rmSync(dir, { recursive: true, force: true })
    },
    SMOKE_TIMEOUT,
  )

  it(
    'refuses a download whose checksum does not match the list',
    async () => {
      const { status, stderr, dir, copy } = await upgradeCopy('v99.0.0', sha256(new Uint8Array()))
      expect({ status, stderr }).toMatchObject({ status: 1 })
      expect(stderr).toContain('does not match')
      const after = await run(['--version'], { cwd: dir, env: bareEnv(), executable: copy })
      expect(after.stdout).toContain(`loom v${serviceVersion}`)
      rmSync(dir, { recursive: true, force: true })
    },
    SMOKE_TIMEOUT,
  )

  it(
    'leaves itself alone when the latest release is no newer',
    async () => {
      const { status, stdout, stderr, dir, copy } = await upgradeCopy('v0.0.1', sha256(archive))
      expect({ status, stderr }).toMatchObject({ status: 0 })
      expect(stdout).toContain('is up to date')
      const after = await run(['--version'], { cwd: dir, env: bareEnv(), executable: copy })
      expect(after.stdout).toContain(`loom v${serviceVersion}`)
      rmSync(dir, { recursive: true, force: true })
    },
    SMOKE_TIMEOUT,
  )
})
