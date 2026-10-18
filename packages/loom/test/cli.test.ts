import { describe, expect, it as it_ } from 'bun:test'
import { effectify } from '@athrio/effect-test'
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
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const it = effectify(it_)

const cli = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const main = resolve(cli, 'src/main.ts')

const loom = (
  args: ReadonlyArray<string>,
  opts: { readonly cwd?: string; readonly env?: Record<string, string> } = {},
) =>
  spawnSync('bun', [main, ...args], {
    cwd: opts.cwd ?? cli,
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
    encoding: 'utf8',
  })

const SPAWN_TIMEOUT = 30_000

const lines = (...rows: ReadonlyArray<string>): string => `${rows.join('\n')}\n`

const anchor = (name: string): string => `::${'['}${name}]`

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

const installFake = (home: string, id: string): void => {
  const pkg = join(home, 'services', 'node_modules', '@athrio', `loom-service-${id}`)
  mkdirSync(pkg, { recursive: true })
  writeFileSync(
    join(pkg, 'package.json'),
    `${JSON.stringify({ name: `@athrio/loom-service-${id}`, version: '0.0.0' })}\n`,
  )
}

const fixture = lines(
  '---',
  'Language: TypeScript',
  'Package: out.ts',
  '---',
  '',
  '# Greeting',
  '',
  '=>',
  '',
  'export const hi = "hello"',
  '',
  '# Out {Tangle}',
  '',
  '=>',
  '',
  anchor('Greeting'),
)

const tempDoc = (): { readonly dir: string; readonly doc: string } => {
  const dir = mkdtempSync(join(tmpdir(), 'loom-cli-'))
  const doc = join(dir, 'doc.loom')
  writeFileSync(doc, fixture)
  return { dir, doc }
}

describe('loom cli', () => {
  it('tangles a file through the `tangle` command', () => {
    const { dir, doc } = tempDoc()
    loom(['tangle', doc])
    expect(readFileSync(join(dir, 'out.ts'), 'utf8')).toContain('export const hi = "hello"')
    rmSync(dir, { recursive: true, force: true })
  }, SPAWN_TIMEOUT)

  it('prints help listing its commands given no arguments', () => {
    const { stdout } = loom([])
    expect(stdout).toContain('tangle')
    expect(stdout).toContain('init')
    expect(stdout).toContain('add')
    expect(stdout).toContain('status')
  }, SPAWN_TIMEOUT)
})

describe('loom cli — init', () => {
  it('creates the corpus folder the configuration names, and keeps it on a rerun', () => {
    const dir = workspace('corpus: chapters\nlanguages:\n  typescript: {}\nprimary: typescript\n')
    expect(existsSync(join(dir, 'chapters'))).toBe(false)
    loom(['init'], { cwd: dir })
    expect(existsSync(join(dir, 'chapters'))).toBe(true)
    writeFileSync(join(dir, 'chapters', 'hello.loom'), lines('# Hello'))
    loom(['init'], { cwd: dir })
    expect(readFileSync(join(dir, 'chapters', 'hello.loom'), 'utf8')).toBe(lines('# Hello'))
    rmSync(dir, { recursive: true, force: true })
  }, SPAWN_TIMEOUT)

  it('falls back to a folder named corpus when the configuration names none', () => {
    const dir = workspace('languages:\n  typescript: {}\nprimary: typescript\n')
    loom(['init'], { cwd: dir })
    expect(existsSync(join(dir, 'corpus'))).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  }, SPAWN_TIMEOUT)
})

describe('loom cli — languages', () => {
  it('status reports the store, the primary language, and what is activated', () => {
    const home = userStore()
    const dir = workspace('corpus: corpus\nlanguages:\n  typescript: {}\nprimary: typescript\n')
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
      existsSync(join(home, 'services', 'node_modules', '@athrio', 'loom-service-typescript')),
    ).toBe(false)
    rmSync(home, { recursive: true, force: true })
    rmSync(dir, { recursive: true, force: true })
  }, SPAWN_TIMEOUT)

  it('status uses the workspace .loom/services store when LOOM_HOME is unset', () => {
    const dir = workspace('corpus: corpus\nlanguages:\n  typescript: {}\nprimary: typescript\n')
    mkdirSync(
      join(dir, '.loom', 'services', 'node_modules', '@athrio', 'loom-service-typescript'),
      { recursive: true },
    )
    const { stdout } = loom(['status'], { cwd: dir })
    expect(stdout).toContain(join(dir, '.loom', 'services'))
    rmSync(dir, { recursive: true, force: true })
  }, SPAWN_TIMEOUT)
})

const explicitWorkspace = (chapter: string): string => {
  const dir = workspace('corpus: corpus\nlanguages:\n  typescript: {}\nprimary: typescript\n')
  mkdirSync(join(dir, 'corpus'), { recursive: true })
  writeFileSync(join(dir, 'corpus', 'book.loom'), lines('---', 'Part I: Probe', '---', '', '# Probe'))
  writeFileSync(join(dir, 'corpus', '01-chapter.loom'), chapter)
  return dir
}

describe('loom cli — explicit blocks', () => {
  it('tangles a Markdown file whose headings and fences stay inside the block', () => {
    const dir = explicitWorkspace(
      lines(
        '---',
        'Part I, Chapter 1: A skill',
        'Package: ./',
        'Language: Markdown',
        '---',
        '',
        '# A skill',
        '',
        '## The rule',
        '',
        '=>',
        '',
        'Write for the reader.',
        '',
        '## The skill {Tangle}[SKILL.md]',
        '',
        '~>',
        '',
        '---',
        'name: probe',
        '---',
        '',
        '# Probe',
        '',
        '## The rule',
        '',
        anchor('The rule'),
        '',
        '```bash',
        '# a shell comment',
        'ls ~/bin',
        '```',
        '',
        '~',
        '',
        '## After the block',
        '',
        'Prose that follows the closed block is prose again.',
      ),
    )
    const { status, stderr } = loom(['tangle', 'corpus'], { cwd: dir })
    expect(stderr).not.toContain('refusing')
    expect(status).toBe(0)
    const written = readFileSync(join(dir, 'SKILL.md'), 'utf8')
    expect(written).toContain('name: probe')
    expect(written).toContain('# Probe')
    expect(written).toContain('## The rule')
    expect(written).toContain('Write for the reader.')
    expect(written).toContain('# a shell comment')
    expect(written).toContain('ls ~/bin')
    expect(written).not.toContain('Prose that follows')
    rmSync(dir, { recursive: true, force: true })
  }, SPAWN_TIMEOUT)

  it('refuses an explicit block no tilde closes, and writes nothing', () => {
    const dir = explicitWorkspace(
      lines(
        '---',
        'Part I, Chapter 1: Open',
        'Package: ./',
        'Language: Markdown',
        '---',
        '',
        '# Open',
        '',
        '## The file {Tangle}[OPEN.md]',
        '',
        '~>',
        '',
        '# swallowed heading',
      ),
    )
    const { status, stderr } = loom(['tangle', 'corpus'], { cwd: dir })
    expect(status).not.toBe(0)
    expect(stderr).toContain('Unclosed explicit block')
    expect(existsSync(join(dir, 'OPEN.md'))).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  }, SPAWN_TIMEOUT)

  it('keeps a line that starts with a tilde as code in a plain block', () => {
    const dir = explicitWorkspace(
      lines(
        '---',
        'Part I, Chapter 1: Paths',
        'Package: ./',
        'Language: TypeScript',
        '---',
        '',
        '# Paths',
        '',
        '## The paths {Tangle}[paths.ts]',
        '',
        '=>',
        '',
        'export const home =',
        '~/bin',
        'export const done = true',
      ),
    )
    const { status } = loom(['tangle', 'corpus'], { cwd: dir })
    expect(status).toBe(0)
    const written = readFileSync(join(dir, 'paths.ts'), 'utf8')
    expect(written).toContain('~/bin')
    expect(written).toContain('export const done = true')
    rmSync(dir, { recursive: true, force: true })
  }, SPAWN_TIMEOUT)
})
