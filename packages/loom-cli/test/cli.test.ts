import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// The CLI is an Effect program over the tangler, the config, and the service
// store; this exercises it as a real process. The `tsx` loader is passed by its
// resolved path rather than by name, so a case can run the CLI from a temp
// workspace — `add`, `remove`, and `status` read `process.cwd()` — while tsx
// still resolves from this package. The interactive `init` prompts need a real
// terminal, so they are verified by hand; here we cover the command surface a
// subprocess can reach.
const cli = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const main = resolve(cli, 'src/main.ts')
const tsx = pathToFileURL(
  createRequire(import.meta.url).resolve('tsx', { paths: [cli] }),
).href

const loom = (
  args: ReadonlyArray<string>,
  opts: { readonly cwd?: string; readonly env?: Record<string, string> } = {},
) =>
  spawnSync('node', ['--import', tsx, main, ...args], {
    cwd: opts.cwd ?? cli,
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
    encoding: 'utf8',
  })

const fixture = `---
Language: TypeScript
Package: out.ts
---

# Greeting

=>

export const hi = "hello"

# Out {Tangle}

=>

::[Greeting]
`

const tempDoc = (): { readonly dir: string; readonly doc: string } => {
  const dir = mkdtempSync(join(tmpdir(), 'loom-cli-'))
  const doc = join(dir, 'doc.loom')
  writeFileSync(doc, fixture)
  return { dir, doc }
}

// A workspace under a temp dir, with a committed .loom/config.yaml the
// activation commands read and write. realpathSync resolves the macOS
// /var → /private/var symlink so the path the child prints (from its resolved
// cwd) matches what the test compares against.
const workspace = (configYaml: string): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'loom-proj-')))
  mkdirSync(join(dir, '.loom'), { recursive: true })
  writeFileSync(join(dir, '.loom', 'config.yaml'), configYaml)
  return dir
}

const configText = (dir: string): string =>
  readFileSync(join(dir, '.loom', 'config.yaml'), 'utf8')

const userStore = (): string =>
  realpathSync(mkdtempSync(join(tmpdir(), 'loom-home-')))

// Stand a service in the store without installing it. `add` finds the package
// already present and skips the package manager, so the activation path runs
// offline; `status` and `removeService` work over the same store layout.
const installFake = (home: string, id: string): void => {
  const pkg = join(
    home,
    'services',
    'node_modules',
    '@athrio',
    `loom-service-${id}`,
  )
  mkdirSync(pkg, { recursive: true })
  writeFileSync(
    join(pkg, 'package.json'),
    `${JSON.stringify({ name: `@athrio/loom-service-${id}`, version: '0.0.0' })}\n`,
  )
}

// Each case spawns `node --import tsx src/main.ts` cold — transpiling the whole
// tangler path on the fly takes seconds, and the 5s default flakes when the
// first cold spawn runs under full-suite load. Give these subprocess tests headroom.
const SPAWN_TIMEOUT = 30_000

describe('loom cli', () => {
  it('tangles a file through the `tangle` command', () => {
    const { dir, doc } = tempDoc()
    loom(['tangle', doc])
    expect(readFileSync(join(dir, 'out.ts'), 'utf8')).toContain(
      'export const hi = "hello"',
    )
    rmSync(dir, { recursive: true, force: true })
  }, SPAWN_TIMEOUT)

  it('prints help listing its commands given no arguments', () => {
    const { stdout } = loom([])
    expect(stdout).toContain('tangle')
    expect(stdout).toContain('init')
    expect(stdout).toContain('add')
    expect(stdout).toContain('status')
  }, SPAWN_TIMEOUT)

  it('status reports the store, the primary language, and what is activated', () => {
    const home = userStore()
    const dir = workspace(
      'corpus: corpus\nlanguages:\n  typescript: {}\nprimary: typescript\n',
    )
    installFake(home, 'typescript')
    const { stdout } = loom(['status'], { cwd: dir, env: { LOOM_HOME: home } })
    expect(stdout).toContain('typescript')
    expect(stdout).toContain(join(home, 'services'))
    rmSync(home, { recursive: true, force: true })
    rmSync(dir, { recursive: true, force: true })
  }, SPAWN_TIMEOUT)

  it('add records the language and skips install when the service is present', () => {
    const home = userStore()
    const dir = workspace('corpus: corpus\nlanguages: {}\nprimary: typescript\n')
    installFake(home, 'typescript')
    const { status, stdout } = loom(['add', 'typescript'], {
      cwd: dir,
      env: { LOOM_HOME: home },
    })
    expect(status).toBe(0)
    expect(stdout).toContain('activated typescript')
    expect(configText(dir)).toContain('typescript')
    rmSync(home, { recursive: true, force: true })
    rmSync(dir, { recursive: true, force: true })
  }, SPAWN_TIMEOUT)

  it('remove drops the language and deletes its package from the store', () => {
    const home = userStore()
    const dir = workspace(
      'corpus: corpus\nlanguages:\n  typescript: {}\n  python: {}\nprimary: python\n',
    )
    installFake(home, 'typescript')
    loom(['remove', 'typescript'], { cwd: dir, env: { LOOM_HOME: home } })
    const text = configText(dir)
    expect(text).toContain('python')
    expect(text).not.toContain('typescript')
    expect(
      existsSync(
        join(home, 'services', 'node_modules', '@athrio', 'loom-service-typescript'),
      ),
    ).toBe(false)
    rmSync(home, { recursive: true, force: true })
    rmSync(dir, { recursive: true, force: true })
  }, SPAWN_TIMEOUT)

  it('status uses the workspace .loom/services store when LOOM_HOME is unset', () => {
    const dir = workspace(
      'corpus: corpus\nlanguages:\n  typescript: {}\nprimary: typescript\n',
    )
    mkdirSync(
      join(dir, '.loom', 'services', 'node_modules', '@athrio', 'loom-service-typescript'),
      { recursive: true },
    )
    const { stdout } = loom(['status'], { cwd: dir })
    expect(stdout).toContain(join(dir, '.loom', 'services'))
    rmSync(dir, { recursive: true, force: true })
  }, SPAWN_TIMEOUT)
})
