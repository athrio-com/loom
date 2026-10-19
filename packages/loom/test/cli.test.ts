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

const loomVersion = '0.0.12'

const workspace = (configYaml: string): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'loom-proj-')))
  mkdirSync(join(dir, '.loom'), { recursive: true })
  writeFileSync(join(dir, '.loom', 'config.yaml'), configYaml)
  return dir
}

const configText = (dir: string): string => readFileSync(join(dir, '.loom', 'config.yaml'), 'utf8')

const userStore = (): string => realpathSync(mkdtempSync(join(tmpdir(), 'loom-home-')))

const installFake = (home: string, id: string, version: string = loomVersion): void => {
  const pkg = join(home, 'services', 'node_modules', '@athrio', `loom-service-${id}`)
  mkdirSync(pkg, { recursive: true })
  writeFileSync(
    join(pkg, 'package.json'),
    `${JSON.stringify({ name: `@athrio/loom-service-${id}`, version })}\n`,
  )
}

const storedVersion = (home: string, id: string): string =>
  (
    JSON.parse(
      readFileSync(
        join(home, 'services', 'node_modules', '@athrio', `loom-service-${id}`, 'package.json'),
        'utf8',
      ),
    ) as { readonly version: string }
  ).version

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
  it(
    'tangles a file through the `tangle` command',
    () => {
      const { dir, doc } = tempDoc()
      loom(['tangle', doc])
      expect(readFileSync(join(dir, 'out.ts'), 'utf8')).toContain('export const hi = "hello"')
      rmSync(dir, { recursive: true, force: true })
    },
    SPAWN_TIMEOUT,
  )

  it(
    'prints help listing its commands given no arguments',
    () => {
      const { stdout } = loom([])
      expect(stdout).toContain('tangle')
      expect(stdout).toContain('init')
      expect(stdout).toContain('add')
      expect(stdout).toContain('status')
    },
    SPAWN_TIMEOUT,
  )
})

describe('loom cli — init', () => {
  it(
    'creates the corpus folder the configuration names, and keeps it on a rerun',
    () => {
      const dir = workspace('corpus: chapters\nlanguages:\n  typescript: {}\nprimary: typescript\n')
      expect(existsSync(join(dir, 'chapters'))).toBe(false)
      loom(['init'], { cwd: dir })
      expect(existsSync(join(dir, 'chapters'))).toBe(true)
      writeFileSync(join(dir, 'chapters', 'hello.loom'), lines('# Hello'))
      loom(['init'], { cwd: dir })
      expect(readFileSync(join(dir, 'chapters', 'hello.loom'), 'utf8')).toBe(lines('# Hello'))
      rmSync(dir, { recursive: true, force: true })
    },
    SPAWN_TIMEOUT,
  )

  it(
    'falls back to a folder named corpus when the configuration names none',
    () => {
      const dir = workspace('languages:\n  typescript: {}\nprimary: typescript\n')
      loom(['init'], { cwd: dir })
      expect(existsSync(join(dir, 'corpus'))).toBe(true)
      rmSync(dir, { recursive: true, force: true })
    },
    SPAWN_TIMEOUT,
  )
})

describe('loom cli — init, the width of a loom', () => {
  const configured = 'languages:\n  typescript: {}\nprimary: typescript\n'
  const editorconfigText = (dir: string): string => readFileSync(join(dir, '.editorconfig'), 'utf8')

  it(
    'adds a [*.loom] section at the default width, once, beside the lines already there',
    () => {
      const dir = workspace(configured)
      writeFileSync(join(dir, '.editorconfig'), lines('root = true', '', '[*]', 'indent_size = 2'))
      loom(['init'], { cwd: dir })
      loom(['init'], { cwd: dir })
      const text = editorconfigText(dir)
      expect(text).toStartWith(lines('root = true', '', '[*]', 'indent_size = 2'))
      expect(text.match(/\[\*\.loom\]/g)?.length).toBe(1)
      expect(text).toContain('max_line_length = 100')
      rmSync(dir, { recursive: true, force: true })
    },
    SPAWN_TIMEOUT,
  )

  it(
    "follows the configuration's width from run to run",
    () => {
      const dir = workspace(`${configured}width: 80\n`)
      loom(['init'], { cwd: dir })
      expect(editorconfigText(dir)).toContain('max_line_length = 80')
      writeFileSync(join(dir, '.loom', 'config.yaml'), `${configured}width: 120\n`)
      loom(['init'], { cwd: dir })
      const text = editorconfigText(dir)
      expect(text).toContain('max_line_length = 120')
      expect(text).not.toContain('max_line_length = 80')
      rmSync(dir, { recursive: true, force: true })
    },
    SPAWN_TIMEOUT,
  )

  it(
    "keeps a [*.loom] section of the owner's own as it was",
    () => {
      const dir = workspace(configured)
      writeFileSync(join(dir, '.editorconfig'), lines('[*.loom]', 'max_line_length = 72'))
      const { status, stdout } = loom(['init'], { cwd: dir })
      expect(status).toBe(0)
      expect(stdout).toContain('kept the [*.loom] section')
      expect(editorconfigText(dir)).toBe(lines('[*.loom]', 'max_line_length = 72'))
      rmSync(dir, { recursive: true, force: true })
    },
    SPAWN_TIMEOUT,
  )
})

describe('loom cli — languages', () => {
  it(
    'status reports the store, the primary language, and what is activated',
    () => {
      const home = userStore()
      const dir = workspace('corpus: corpus\nlanguages:\n  typescript: {}\nprimary: typescript\n')
      installFake(home, 'typescript')
      const { stdout } = loom(['status'], { cwd: dir, env: { LOOM_HOME: home } })
      expect(stdout).toContain('typescript')
      expect(stdout).toContain(join(home, 'services'))
      rmSync(home, { recursive: true, force: true })
      rmSync(dir, { recursive: true, force: true })
    },
    SPAWN_TIMEOUT,
  )

  it(
    'add records the language and skips install when the service is present',
    () => {
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
    },
    SPAWN_TIMEOUT,
  )

  it(
    'remove drops the language and deletes its package from the store',
    () => {
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
    },
    SPAWN_TIMEOUT,
  )

  it(
    'status uses the workspace .loom/services store when LOOM_HOME is unset',
    () => {
      const dir = workspace('corpus: corpus\nlanguages:\n  typescript: {}\nprimary: typescript\n')
      mkdirSync(
        join(dir, '.loom', 'services', 'node_modules', '@athrio', 'loom-service-typescript'),
        { recursive: true },
      )
      const { stdout } = loom(['status'], { cwd: dir })
      expect(stdout).toContain(join(dir, '.loom', 'services'))
      rmSync(dir, { recursive: true, force: true })
    },
    SPAWN_TIMEOUT,
  )
})

const handWritten = lines(
  '# written by hand',
  'corpus: corpus',
  'future: kept',
  'primary: typescript',
  'variables:',
  '  version: 0.0.1',
)

describe('loom cli — changing one value', () => {
  it(
    'set changes the one variable and keeps the rest of the file as written',
    () => {
      const dir = workspace(handWritten)
      mkdirSync(join(dir, 'corpus'))
      const { status } = loom(['set', 'version', '0.0.2'], { cwd: dir })
      expect(status).toBe(0)
      expect(configText(dir)).toBe(handWritten.replace('0.0.1', '0.0.2'))
      rmSync(dir, { recursive: true, force: true })
    },
    SPAWN_TIMEOUT,
  )

  it(
    'add records the language and keeps a key it does not know',
    () => {
      const home = userStore()
      const dir = workspace(handWritten)
      installFake(home, 'typescript')
      loom(['add', 'typescript'], { cwd: dir, env: { LOOM_HOME: home } })
      const text = configText(dir)
      expect(text).toContain('# written by hand')
      expect(text).toContain('future: kept')
      expect(text).toContain('typescript: {}')
      rmSync(home, { recursive: true, force: true })
      rmSync(dir, { recursive: true, force: true })
    },
    SPAWN_TIMEOUT,
  )
})

const fakeNpm = (): { readonly bin: string; readonly calls: string; readonly path: string } => {
  const bin = realpathSync(mkdtempSync(join(tmpdir(), 'loom-npm-')))
  const calls = join(bin, 'calls.log')
  writeFileSync(
    join(bin, 'npm'),
    `${[
      '#!/bin/sh',
      `echo "$*" >> '${calls}'`,
      'spec="$2"',
      'prefix=""',
      'while [ "$#" -gt 0 ]; do',
      '  if [ "$1" = "--prefix" ]; then prefix="$2"; fi',
      '  shift',
      'done',
      'name="${spec%@*}"',
      'version="${spec##*@}"',
      'mkdir -p "$prefix/node_modules/$name"',
      `printf '{"name":"%s","version":"%s"}\\n' "$name" "$version" > "$prefix/node_modules/$name/package.json"`,
    ].join('\n')}\n`,
    { mode: 0o755 },
  )
  return { bin, calls, path: `${bin}:${process.env.PATH ?? ''}` }
}

describe('loom cli — keeping a service current', () => {
  it(
    'add replaces a service an older release installed',
    () => {
      const home = userStore()
      const npm = fakeNpm()
      const dir = workspace('corpus: corpus\nlanguages: {}\nprimary: typescript\n')
      installFake(home, 'typescript', '0.0.1')
      const { status, stdout } = loom(['add', 'typescript'], {
        cwd: dir,
        env: { LOOM_HOME: home, PATH: npm.path },
      })
      expect(status).toBe(0)
      expect(stdout).toContain(
        `updated @athrio/loom-service-typescript from 0.0.1 to ${loomVersion}`,
      )
      expect(readFileSync(npm.calls, 'utf8')).toContain(
        `@athrio/loom-service-typescript@${loomVersion}`,
      )
      expect(storedVersion(home, 'typescript')).toBe(loomVersion)
      rmSync(home, { recursive: true, force: true })
      rmSync(npm.bin, { recursive: true, force: true })
      rmSync(dir, { recursive: true, force: true })
    },
    SPAWN_TIMEOUT,
  )

  it(
    'add leaves a current service alone and never calls the package manager',
    () => {
      const home = userStore()
      const npm = fakeNpm()
      const dir = workspace('corpus: corpus\nlanguages: {}\nprimary: typescript\n')
      installFake(home, 'typescript')
      const { status, stdout } = loom(['add', 'typescript'], {
        cwd: dir,
        env: { LOOM_HOME: home, PATH: npm.path },
      })
      expect(status).toBe(0)
      expect(stdout).toContain('is already in the store')
      expect(existsSync(npm.calls)).toBe(false)
      rmSync(home, { recursive: true, force: true })
      rmSync(npm.bin, { recursive: true, force: true })
      rmSync(dir, { recursive: true, force: true })
    },
    SPAWN_TIMEOUT,
  )

  it(
    'add installs a service the store lacks',
    () => {
      const home = userStore()
      const npm = fakeNpm()
      const dir = workspace('corpus: corpus\nlanguages: {}\nprimary: typescript\n')
      const { status, stdout } = loom(['add', 'typescript'], {
        cwd: dir,
        env: { LOOM_HOME: home, PATH: npm.path },
      })
      expect(status).toBe(0)
      expect(stdout).toContain(`installed @athrio/loom-service-typescript ${loomVersion}`)
      expect(storedVersion(home, 'typescript')).toBe(loomVersion)
      rmSync(home, { recursive: true, force: true })
      rmSync(npm.bin, { recursive: true, force: true })
      rmSync(dir, { recursive: true, force: true })
    },
    SPAWN_TIMEOUT,
  )

  it(
    'status marks a service an older release installed',
    () => {
      const home = userStore()
      const dir = workspace('corpus: corpus\nlanguages:\n  typescript: {}\nprimary: typescript\n')
      installFake(home, 'typescript', '0.0.1')
      const { stdout } = loom(['status'], { cwd: dir, env: { LOOM_HOME: home } })
      expect(stdout).toContain('0.0.1 is installed')
      expect(stdout).toContain('loom add typescript')
      rmSync(home, { recursive: true, force: true })
      rmSync(dir, { recursive: true, force: true })
    },
    SPAWN_TIMEOUT,
  )
})

const explicitWorkspace = (chapter: string): string => {
  const dir = workspace('corpus: corpus\nlanguages:\n  typescript: {}\nprimary: typescript\n')
  mkdirSync(join(dir, 'corpus'), { recursive: true })
  writeFileSync(
    join(dir, 'corpus', 'book.loom'),
    lines('---', 'Part I: Probe', '---', '', '# Probe'),
  )
  writeFileSync(join(dir, 'corpus', '01-chapter.loom'), chapter)
  return dir
}

describe('loom cli — explicit blocks', () => {
  it(
    'tangles a Markdown file whose headings and fences stay inside the block',
    () => {
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
    },
    SPAWN_TIMEOUT,
  )

  it(
    'refuses an explicit block no tilde closes, and writes nothing',
    () => {
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
    },
    SPAWN_TIMEOUT,
  )

  it(
    'keeps a line that starts with a tilde as code in a plain block',
    () => {
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
    },
    SPAWN_TIMEOUT,
  )
})

const projectConfig = 'corpus: corpus\nprimary: typescript\n'

const projectWith = (looms: Record<string, string>, config: string = projectConfig): string => {
  const dir = workspace(config)
  Object.entries(looms).forEach(([path, text]) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), text)
  })
  return dir
}

const fileLoom = (file: string): string =>
  lines(`# Writing ${file} {Tangle}[${file}]`, '', '=>', '', `export const file = '${file}'`)

const brokenLoom = lines('# A broken file {Tangle}[broken.ts]', '', '=>', '', anchor('Nowhere'))

const lockOf = (dir: string): ReadonlyArray<string> =>
  JSON.parse(readFileSync(join(dir, '.loom', 'loom.lock'), 'utf8')).tangled

const orphanedProject = (): string => {
  const dir = projectWith({
    'corpus/one.loom': fileLoom('one.ts'),
    'corpus/two.loom': fileLoom('two.ts'),
    'test/broken.fixture.loom': brokenLoom,
  })
  const { status, stderr } = loom(['tangle', '.'], { cwd: dir })
  expect(stderr).not.toContain('refusing')
  expect(status).toBe(0)
  expect(lockOf(dir)).toEqual(['one.ts', 'two.ts'])
  rmSync(join(dir, 'corpus', 'two.loom'))
  return dir
}

describe('loom cli — orphans', () => {
  it(
    'lists the file whose loom is gone, past a broken fixture',
    () => {
      const dir = orphanedProject()
      const { status, stdout, stderr } = loom(['orphans'], { cwd: dir })
      expect(stderr).not.toContain('refusing')
      expect(status).toBe(0)
      expect(stdout).toBe(`${join(dir, 'two.ts')}\n`)
      rmSync(dir, { recursive: true, force: true })
    },
    SPAWN_TIMEOUT,
  )

  it(
    'prunes that file and rewrites the lock to what the project produces',
    () => {
      const dir = orphanedProject()
      const { status } = loom(['orphans', '--prune'], { cwd: dir })
      expect(status).toBe(0)
      expect(existsSync(join(dir, 'two.ts'))).toBe(false)
      expect(existsSync(join(dir, 'one.ts'))).toBe(true)
      expect(lockOf(dir)).toEqual(['one.ts'])
      rmSync(dir, { recursive: true, force: true })
    },
    SPAWN_TIMEOUT,
  )

  it(
    'refuses, and lists nothing, when a loom the project holds is broken',
    () => {
      const dir = orphanedProject()
      writeFileSync(join(dir, 'corpus', 'broken.loom'), brokenLoom)
      const { status, stdout, stderr } = loom(['orphans'], { cwd: dir })
      expect(status).not.toBe(0)
      expect(stdout).toBe('')
      expect(stderr).toContain('refusing')
      rmSync(dir, { recursive: true, force: true })
    },
    SPAWN_TIMEOUT,
  )
})

const cleanOrphans = (dir: string): void => {
  const { status, stderr } = loom(['orphans'], { cwd: dir })
  expect(stderr).not.toContain('refusing')
  expect(status).toBe(0)
}

const git = (dir: string, ...args: ReadonlyArray<string>) =>
  spawnSync(
    'git',
    [
      '-c',
      'user.name=Loom',
      '-c',
      'user.email=loom@example.com',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=/dev/null',
      ...args,
    ],
    { cwd: dir, encoding: 'utf8' },
  )

describe('loom cli — the looms a project leaves out', () => {
  it(
    'leaves out what Git ignores, through .gitignore and info/exclude',
    () => {
      const dir = projectWith({
        'corpus/one.loom': fileLoom('one.ts'),
        'scratch/broken.loom': brokenLoom,
        'checkouts/copy/broken.loom': brokenLoom,
      })
      git(dir, 'init', '-q')
      writeFileSync(join(dir, '.gitignore'), 'scratch/\n')
      mkdirSync(join(dir, '.git', 'info'), { recursive: true })
      writeFileSync(join(dir, '.git', 'info', 'exclude'), 'checkouts/\n')
      cleanOrphans(dir)
      rmSync(dir, { recursive: true, force: true })
    },
    SPAWN_TIMEOUT,
  )

  it(
    'reads the info/exclude a worktree shares with its main checkout',
    () => {
      const repo = realpathSync(mkdtempSync(join(tmpdir(), 'loom-repo-')))
      git(repo, 'init', '-q')
      git(repo, 'commit', '-q', '--allow-empty', '-m', 'start')
      mkdirSync(join(repo, '.git', 'info'), { recursive: true })
      writeFileSync(join(repo, '.git', 'info', 'exclude'), 'scratch/\n')
      const checkout = `${repo}-checkout`
      git(repo, 'worktree', 'add', '-q', '--detach', checkout)
      mkdirSync(join(checkout, '.loom'), { recursive: true })
      writeFileSync(join(checkout, '.loom', 'config.yaml'), projectConfig)
      mkdirSync(join(checkout, 'corpus'), { recursive: true })
      writeFileSync(join(checkout, 'corpus', 'one.loom'), fileLoom('one.ts'))
      mkdirSync(join(checkout, 'scratch'), { recursive: true })
      writeFileSync(join(checkout, 'scratch', 'broken.loom'), brokenLoom)
      cleanOrphans(checkout)
      rmSync(checkout, { recursive: true, force: true })
      rmSync(repo, { recursive: true, force: true })
    },
    SPAWN_TIMEOUT,
  )

  it(
    'leaves out a folder the configuration lists under ignore',
    () => {
      const dir = projectWith(
        {
          'corpus/one.loom': fileLoom('one.ts'),
          'drafts/broken.loom': brokenLoom,
        },
        `${projectConfig}ignore:\n  - drafts/\n`,
      )
      cleanOrphans(dir)
      rmSync(dir, { recursive: true, force: true })
    },
    SPAWN_TIMEOUT,
  )

  it(
    'brings fixtures back with a ! pattern, and then refuses a broken one',
    () => {
      const dir = projectWith(
        {
          'corpus/one.loom': fileLoom('one.ts'),
          'test/broken.fixture.loom': brokenLoom,
        },
        `${projectConfig}ignore:\n  - '!*.fixture.loom'\n`,
      )
      const { status, stderr } = loom(['orphans'], { cwd: dir })
      expect(status).not.toBe(0)
      expect(stderr).toContain('broken.fixture.loom')
      rmSync(dir, { recursive: true, force: true })
    },
    SPAWN_TIMEOUT,
  )

  it(
    'leaves a nested project to itself',
    () => {
      const dir = projectWith({
        'corpus/one.loom': fileLoom('one.ts'),
        'inner/.loom/config.yaml': projectConfig,
        'inner/broken.loom': brokenLoom,
      })
      cleanOrphans(dir)
      rmSync(dir, { recursive: true, force: true })
    },
    SPAWN_TIMEOUT,
  )

  it(
    'weaves a book without the chapters the project leaves out',
    () => {
      const dir = projectWith({
        'corpus/book.loom': lines('---', 'Part I: Probe', '---', '', '# Probe'),
        'corpus/01-kept.loom': lines(
          '---',
          'Part I, Chapter 1: A kept chapter',
          'Language: Prose',
          '---',
          '',
          '# A kept chapter',
          '',
          'Kept.',
        ),
        'corpus/02-draft.fixture.loom': lines(
          '---',
          'Part I, Chapter 2: A left-out chapter',
          'Language: Prose',
          '---',
          '',
          '# A left-out chapter',
          '',
          'Left out.',
        ),
      })
      const { status } = loom(['weave', 'corpus/book.loom', 'woven.json'], { cwd: dir })
      expect(status).toBe(0)
      const woven = readFileSync(join(dir, 'woven.json'), 'utf8')
      expect(woven).toContain('A kept chapter')
      expect(woven).not.toContain('A left-out chapter')
      rmSync(dir, { recursive: true, force: true })
    },
    SPAWN_TIMEOUT,
  )
})

describe('loom cli — an ignored loom named directly', () => {
  it(
    'tangles it, and keeps its files out of the lock',
    () => {
      const dir = projectWith({
        'corpus/one.loom': fileLoom('one.ts'),
        'test/sample.fixture.loom': fileLoom('sample.ts'),
      })
      loom(['tangle', 'corpus'], { cwd: dir })
      const { status } = loom(['tangle', 'test/sample.fixture.loom'], { cwd: dir })
      expect(status).toBe(0)
      expect(readFileSync(join(dir, 'test', 'sample.ts'), 'utf8')).toContain("'sample.ts'")
      expect(lockOf(dir)).toEqual(['one.ts'])
      expect(loom(['orphans'], { cwd: dir }).stdout).toBe('')
      rmSync(dir, { recursive: true, force: true })
    },
    SPAWN_TIMEOUT,
  )
})

describe('loom cli — format', () => {
  const wrapped = lines('# Notes', '', 'A paragraph that', 'runs over two lines.')

  it(
    'names a loom that would change, and leaves it as it was',
    () => {
      const dir = workspace('corpus: corpus\n')
      mkdirSync(join(dir, 'corpus'), { recursive: true })
      writeFileSync(join(dir, 'corpus', 'notes.loom'), wrapped)
      const { status, stdout } = loom(['format', '--check', 'corpus'], { cwd: dir })
      expect(status).toBe(1)
      expect(stdout).toContain('would format')
      expect(readFileSync(join(dir, 'corpus', 'notes.loom'), 'utf8')).toBe(wrapped)
      rmSync(dir, { recursive: true, force: true })
    },
    SPAWN_TIMEOUT,
  )

  it(
    'joins the paragraph, and finds nothing to do the second time',
    () => {
      const dir = workspace('corpus: corpus\n')
      mkdirSync(join(dir, 'corpus'), { recursive: true })
      writeFileSync(join(dir, 'corpus', 'notes.loom'), wrapped)
      const first = loom(['format', 'corpus'], { cwd: dir })
      expect(first.status).toBe(0)
      expect(first.stdout).toContain('formatted')
      expect(readFileSync(join(dir, 'corpus', 'notes.loom'), 'utf8')).toBe(
        lines('# Notes', '', 'A paragraph that runs over two lines.'),
      )
      expect(loom(['format', 'corpus'], { cwd: dir }).stdout).toContain('every loom is formatted')
      rmSync(dir, { recursive: true, force: true })
    },
    SPAWN_TIMEOUT,
  )
})

const helixHome = (
  ...rows: ReadonlyArray<string>
): { readonly config: string; readonly helix: string; readonly env: Record<string, string> } => {
  const config = realpathSync(mkdtempSync(join(tmpdir(), 'loom-helix-')))
  const helix = join(config, 'helix')
  mkdirSync(helix, { recursive: true })
  writeFileSync(join(helix, 'languages.toml'), lines(...rows))
  return { config, helix, env: { XDG_CONFIG_HOME: config, APPDATA: config } }
}

describe('loom cli — helix', () => {
  it(
    'builds the grammar, copies the queries, and adds Loom to languages.toml once',
    () => {
      const { config, helix, env } = helixHome('[[language]]', 'name = "rust"')
      expect(loom(['helix'], { env }).status).toBe(0)
      expect(loom(['helix'], { env }).status).toBe(0)
      const languages = readFileSync(join(helix, 'languages.toml'), 'utf8')
      expect(languages).toContain('name = "rust"')
      expect(languages.match(/name = "loom"/g)?.length).toBe(1)
      expect(languages).toContain('soft-wrap = { enable = true, wrap-at-text-width = true }')
      expect(languages).toContain('text-width = 100')
      const library = process.platform === 'win32' ? 'loom.dll' : 'loom.so'
      expect(existsSync(join(helix, 'runtime', 'grammars', library))).toBe(true)
      expect(existsSync(join(helix, 'runtime', 'queries', 'loom', 'highlights.scm'))).toBe(true)
      rmSync(config, { recursive: true, force: true })
    },
    SPAWN_TIMEOUT,
  )

  it(
    'leaves a languages.toml that sets Loom up by hand as it was',
    () => {
      const { config, helix, env } = helixHome('[[language]]', 'name = "loom"')
      const { status, stderr } = loom(['helix'], { env })
      expect(status).toBe(1)
      expect(stderr).toContain('already sets up Loom')
      expect(readFileSync(join(helix, 'languages.toml'), 'utf8')).toBe(
        lines('[[language]]', 'name = "loom"'),
      )
      rmSync(config, { recursive: true, force: true })
    },
    SPAWN_TIMEOUT,
  )
})

const nvimHome = (): {
  readonly data: string
  readonly site: string
  readonly env: Record<string, string>
} => {
  const data = realpathSync(mkdtempSync(join(tmpdir(), 'loom-nvim-')))
  const site = join(data, process.platform === 'win32' ? 'nvim-data' : 'nvim', 'site')
  return { data, site, env: { XDG_DATA_HOME: data, LOCALAPPDATA: data, NVIM_APPNAME: 'nvim' } }
}

describe('loom cli — nvim', () => {
  it(
    'builds the parser, copies the queries, and writes the plugin, run after run',
    () => {
      const { data, site, env } = nvimHome()
      expect(loom(['nvim'], { env }).status).toBe(0)
      expect(loom(['nvim'], { env }).status).toBe(0)
      expect(existsSync(join(site, 'parser', 'loom.so'))).toBe(true)
      expect(existsSync(join(site, 'queries', 'loom', 'highlights.scm'))).toBe(true)
      const plugin = readFileSync(join(site, 'plugin', 'loom.lua'), 'utf8')
      expect(plugin).toStartWith('-- Loom: written by `loom nvim`')
      expect(plugin).toContain("vim.lsp.enable('loom')")
      expect(plugin).toContain("vim.opt_local.formatoptions:remove({ 't', 'c' })")
      rmSync(data, { recursive: true, force: true })
    },
    SPAWN_TIMEOUT,
  )

  it(
    "leaves a plugin/loom.lua of the person's own as it was",
    () => {
      const { data, site, env } = nvimHome()
      mkdirSync(join(site, 'plugin'), { recursive: true })
      writeFileSync(join(site, 'plugin', 'loom.lua'), lines("print('mine')"))
      const { status, stderr } = loom(['nvim'], { env })
      expect(status).toBe(1)
      expect(stderr).toContain('was not written by `loom nvim`')
      expect(readFileSync(join(site, 'plugin', 'loom.lua'), 'utf8')).toBe(lines("print('mine')"))
      expect(existsSync(join(site, 'parser', 'loom.so'))).toBe(false)
      rmSync(data, { recursive: true, force: true })
    },
    SPAWN_TIMEOUT,
  )
})
