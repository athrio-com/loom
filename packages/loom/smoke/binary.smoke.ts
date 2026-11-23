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
import { basename, dirname, join, resolve } from 'node:path'
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
  LOOM_DEV_REGISTRY: nowhere,
  ...extra,
})

const devBuild = serviceVersion.includes('-dev.')

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

describe.skipIf(process.platform !== 'darwin')('the executable — signature', () => {
  it('carries a signature that codesign accepts', () => {
    const check = Bun.spawnSync(['codesign', '--verify', '--strict', binary], { stderr: 'pipe' })
    expect({ status: check.exitCode, stderr: check.stderr.toString() }).toMatchObject({
      status: 0,
    })
  })
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

const installedThrough = async (env: Record<string, string>) => {
  const dir = workspace('corpus: .', 'languages:', '  typescript: {}', 'primary: typescript')
  const result = await run(['update', 'typescript'], { cwd: dir, env })
  const manifest = join(
    dir,
    '.loom',
    'services',
    'node_modules',
    servicePackage('typescript'),
    'package.json',
  )
  const version: unknown = existsSync(manifest)
    ? JSON.parse(readFileSync(manifest, 'utf8')).version
    : undefined
  rmSync(dir, { recursive: true, force: true })
  return { ...result, version }
}

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
      const registry = registryServer(standInTarball())
      const { status, stdout, stderr, version } = await installedThrough(
        bareEnv({ NPM_CONFIG_REGISTRY: registry.url.href }),
      )
      registry.stop()
      expect({ status, stderr }).toMatchObject({ status: 0 })
      expect(stdout).toContain(`installed ${servicePackage('typescript')} ${serviceVersion}`)
      expect(version).toBe(serviceVersion)
    },
    SMOKE_TIMEOUT,
  )

  it.skipIf(!devBuild)(
    "installs a dev build's service from the dev registry when no registry is named",
    async () => {
      const registry = registryServer(standInTarball())
      const env = Object.fromEntries(
        Object.entries(bareEnv({ LOOM_DEV_REGISTRY: registry.url.href })).filter(
          ([name]) => name !== 'NPM_CONFIG_REGISTRY',
        ),
      )
      const { status, stdout, stderr, version } = await installedThrough(env)
      registry.stop()
      expect({ status, stderr }).toMatchObject({ status: 0 })
      expect(stdout).toContain(`installed ${servicePackage('typescript')} ${serviceVersion}`)
      expect(version).toBe(serviceVersion)
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
    'starts with no TypeScript and formats with a service from the store',
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
        expect(existsSync(join(dir, '.loom', 'services', 'node_modules', 'typescript'))).toBe(false)
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

const runCopy = async (args: ReadonlyArray<string>, env: Record<string, string>) => {
  const dir = scratch('upgrade')
  const copy = join(dir, process.platform === 'win32' ? 'loom.exe' : 'loom')
  copyFileSync(binary, copy)
  chmodSync(copy, 0o755)
  const result = await run(args, { cwd: dir, env: bareEnv(env), executable: copy })
  return { ...result, dir, copy }
}

const upgradeCopy = async (tag: string, listed: string) => {
  const server = releaseServer(tag, listed)
  const result = await runCopy(['upgrade'], {
    LOOM_RELEASES: new URL('/releases', server.url).href,
  })
  server.stop()
  return result
}

describe('the executable — upgrade', () => {
  it.skipIf(devBuild)(
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

  it.skipIf(devBuild)(
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

  it.skipIf(devBuild)(
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

  it(
    'leaves an executable Homebrew installed to Homebrew',
    async () => {
      const dir = scratch('homebrew')
      const copy = join(dir, 'Cellar', 'loom', '9.9.9', 'bin', basename(binary))
      mkdirSync(dirname(copy), { recursive: true })
      copyFileSync(binary, copy)
      chmodSync(copy, 0o755)
      const { status, stdout, stderr } = await run(['upgrade'], {
        cwd: dir,
        env: bareEnv({ LOOM_RELEASES: nowhere }),
        executable: copy,
      })
      expect({ status, stderr }).toMatchObject({ status: 0 })
      expect(stdout).toContain('brew upgrade loom')
      expect(sha256(new Uint8Array(readFileSync(copy)))).toBe(
        sha256(new Uint8Array(readFileSync(binary))),
      )
      rmSync(dir, { recursive: true, force: true })
    },
    SMOKE_TIMEOUT,
  )
})

const executablePackage = `@athrio/loom-${process.platform}-${process.arch}`

const packageTarball = (): Promise<Uint8Array> =>
  new Bun.Archive({ 'package/loom': replacement }, { compress: 'gzip' }).bytes()

const devRegistryServer = (tag: string, tarball: Uint8Array) =>
  Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request) => {
      const path = decodeURIComponent(new URL(request.url).pathname)
      if (path === `/${executablePackage}`)
        return Response.json({
          name: executablePackage,
          'dist-tags': { dev: tag },
          versions: {
            [tag]: {
              name: executablePackage,
              version: tag,
              dist: {
                tarball: new URL('/package.tgz', request.url).href,
                integrity: `sha512-${createHash('sha512').update(tarball).digest('base64')}`,
              },
            },
          },
        })
      if (path === '/package.tgz') return new Response(tarball)
      return new Response('not found', { status: 404 })
    },
  })

const devUpgradeCopy = async (args: ReadonlyArray<string>, tag: string) => {
  const server = devRegistryServer(tag, await packageTarball())
  const result = await runCopy(args, {
    LOOM_RELEASES: nowhere,
    LOOM_DEV_REGISTRY: server.url.href,
  })
  server.stop()
  return result
}

const olderDev = `${serviceVersion.split('-')[0]}-dev.0`

describe.skipIf(process.platform === 'win32')('the executable — dev releases', () => {
  it(
    'takes a newer dev release from the dev registry with --dev',
    async () => {
      const { status, stderr, dir, copy } = await devUpgradeCopy(
        ['upgrade', '--dev'],
        '99.0.0-dev.1',
      )
      expect({ status, stderr }).toMatchObject({ status: 0 })
      expect(sha256(new Uint8Array(readFileSync(copy)))).toBe(sha256(replacement))
      expect((await run([], { cwd: dir, env: bareEnv(), executable: copy })).stdout).toContain(
        'upgraded',
      )
      rmSync(dir, { recursive: true, force: true })
    },
    SMOKE_TIMEOUT,
  )

  it(
    'never moves to a dev release older than itself',
    async () => {
      const { status, stdout, stderr, dir, copy } = await devUpgradeCopy(
        ['upgrade', '--dev'],
        olderDev,
      )
      expect({ status, stderr }).toMatchObject({ status: 0 })
      expect(stdout).toContain('is up to date')
      const after = await run(['--version'], { cwd: dir, env: bareEnv(), executable: copy })
      expect(after.stdout).toContain(`loom v${serviceVersion}`)
      rmSync(dir, { recursive: true, force: true })
    },
    SMOKE_TIMEOUT,
  )

  it(
    'names the command that starts a dev registry when none answers',
    async () => {
      const { status, stderr, dir } = await runCopy(['upgrade', '--dev'], {
        LOOM_RELEASES: nowhere,
      })
      expect(status).toBe(1)
      expect(stderr).toContain('bun run registry')
      rmSync(dir, { recursive: true, force: true })
    },
    SMOKE_TIMEOUT,
  )

  it.skipIf(!devBuild)(
    'takes dev releases on a dev build with no flag, and never asks GitHub',
    async () => {
      const { status, stderr, dir, copy } = await devUpgradeCopy(['upgrade'], '99.0.0-dev.1')
      expect({ status, stderr }).toMatchObject({ status: 0 })
      expect(sha256(new Uint8Array(readFileSync(copy)))).toBe(sha256(replacement))
      rmSync(dir, { recursive: true, force: true })
    },
    SMOKE_TIMEOUT,
  )
})

const doctorIn = async (dir: string, latestDev: string) => {
  const registry = devRegistryServer(latestDev, await packageTarball())
  const result = await run(['doctor'], {
    cwd: dir,
    env: bareEnv({ PATH: dirname(binary), LOOM_DEV_REGISTRY: registry.url.href }),
  })
  registry.stop()
  return result
}

describe('the executable — doctor', () => {
  it(
    'knows itself as the standalone executable a terminal runs',
    async () => {
      const dir = scratch('doctor')
      const { status, stdout, stderr } = await doctorIn(dir, serviceVersion)
      expect({ status, stderr }).toMatchObject({ status: 0 })
      expect(stdout).toContain(`runs from ${binary}, a standalone executable`)
      expect(stdout).toContain('a terminal runs this loom')
      expect(stdout).toContain('no problems found')
      rmSync(dir, { recursive: true, force: true })
    },
    SMOKE_TIMEOUT,
  )

  it.skipIf(!devBuild)(
    'reports a dev build that a newer dev release has passed, with the upgrade that fixes it',
    async () => {
      const dir = scratch('doctor')
      const { status, stdout } = await doctorIn(dir, '99.0.0-dev.1')
      expect(status).toBe(1)
      expect(stdout).toContain(
        `dev release 99.0.0-dev.1 is out, newer than this loom's ${serviceVersion}`,
      )
      expect(stdout).toContain('loom upgrade')
      expect(stdout).toContain('1 problem found')
      rmSync(dir, { recursive: true, force: true })
    },
    SMOKE_TIMEOUT,
  )
})

describe.skipIf(!devBuild)('the executable — notice of a newer dev release', () => {
  it(
    'tells a dev build that a newer dev release is out',
    async () => {
      const registry = devRegistryServer('99.0.0-dev.1', await packageTarball())
      const { status, stdout, stderr } = await run(['--version'], {
        cwd: scratch('notice'),
        env: bareEnv({ LOOM_DEV_REGISTRY: registry.url.href }),
      })
      registry.stop()
      expect({ status, stderr }).toMatchObject({ status: 0 })
      expect(stdout).toContain(`loom v${serviceVersion}`)
      expect(stderr).toContain('dev release 99.0.0-dev.1 is out')
    },
    SMOKE_TIMEOUT,
  )

  it(
    'says nothing when no dev registry answers',
    async () => {
      const { status, stderr } = await run(['--version'], {
        cwd: scratch('notice'),
        env: bareEnv(),
      })
      expect(status).toBe(0)
      expect(stderr).not.toContain('dev release')
    },
    SMOKE_TIMEOUT,
  )
})
