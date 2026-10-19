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

const bareEnv = (extra: Record<string, string> = {}): Record<string, string> => ({
  HOME: process.env.HOME ?? tmpdir(),
  PATH: emptyPath,
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
      const { status, stdout } = await run(['--version'], { cwd: scratch('version'), env: bareEnv() })
      expect(status).toBe(0)
      expect(stdout).toContain(`loom v${serviceVersion}`)
    },
    SMOKE_TIMEOUT,
  )

  it(
    'tangles a loom in a folder with no node_modules',
    async () => {
      const dir = workspace('corpus: .', 'primary: typescript')
      writeFileSync(join(dir, 'hello.loom'), helloLoom)
      const { status } = await run(['tangle', 'hello.loom'], { cwd: dir, env: bareEnv() })
      expect(status).toBe(0)
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

const installStandIn = (root: string): void => {
  const service = join(root, '.loom', 'services', 'node_modules', servicePackage('typescript'))
  mkdirSync(join(service, 'dist'), { recursive: true })
  writeFileSync(
    join(service, 'package.json'),
    JSON.stringify({
      name: servicePackage('typescript'),
      version: serviceVersion,
      type: 'module',
      exports: { '.': './dist/index.js' },
    }),
  )
  writeFileSync(join(service, 'dist', 'index.js'), standIn)
}

describe('the executable — languages', () => {
  it(
    'finds a current service in the store and leaves it alone',
    async () => {
      const dir = workspace('corpus: .', 'languages:', '  typescript: {}', 'primary: typescript')
      installStandIn(dir)
      const { status, stdout } = await run(['update', 'typescript'], { cwd: dir, env: bareEnv() })
      expect(status).toBe(0)
      expect(stdout).toContain('is already in the store')
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
    'installs TypeScript into the store and formats with a service from the store',
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
          existsSync(join(dir, '.loom', 'services', 'node_modules', 'typescript', 'lib')),
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
    'builds the grammar it carries for Helix',
    async () => {
      const config = scratch('helix')
      const { status } = await run(['helix'], {
        cwd: config,
        env: { ...bareEnv({ XDG_CONFIG_HOME: config }), PATH: process.env.PATH ?? '' },
      })
      expect(status).toBe(0)
      const library = process.platform === 'win32' ? 'loom.dll' : 'loom.so'
      expect(existsSync(join(config, 'helix', 'runtime', 'grammars', library))).toBe(true)
      expect(existsSync(join(config, 'helix', 'runtime', 'queries', 'loom', 'highlights.scm'))).toBe(
        true,
      )
      rmSync(config, { recursive: true, force: true })
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
      const { status, dir, copy } = await upgradeCopy('v99.0.0', sha256(archive))
      expect(status).toBe(0)
      expect(new Uint8Array(readFileSync(copy))).toEqual(replacement)
      const after = await run([], { cwd: dir, env: bareEnv(), executable: copy })
      expect(after.stdout).toContain('upgraded')
      rmSync(dir, { recursive: true, force: true })
    },
    SMOKE_TIMEOUT,
  )

  it(
    'refuses a download whose checksum does not match the list',
    async () => {
      const { status, stderr, dir, copy } = await upgradeCopy('v99.0.0', sha256(new Uint8Array()))
      expect(status).toBe(1)
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
      const { status, stdout, dir, copy } = await upgradeCopy('v0.0.1', sha256(archive))
      expect(status).toBe(0)
      expect(stdout).toContain('is up to date')
      const after = await run(['--version'], { cwd: dir, env: bareEnv(), executable: copy })
      expect(after.stdout).toContain(`loom v${serviceVersion}`)
      rmSync(dir, { recursive: true, force: true })
    },
    SMOKE_TIMEOUT,
  )
})
