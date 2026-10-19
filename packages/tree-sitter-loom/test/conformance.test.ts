import { afterAll, beforeAll, describe, expect, it as it_ } from 'bun:test'
import { effectify } from '@athrio/effect-test'
import { Array, Effect, Stream, pipe } from 'effect'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { LoomWeft } from '@athrio/loom-ast/Weft'
import { LoomSourceRanges } from '@athrio/loom-lang/ast/LineRanges'
import { WeftClassifier } from '@athrio/loom-lang/ast/WeftClassifier'

const it = effectify(it_)

type LineKind = 'frontmatter' | 'heading' | 'toc' | 'arrow' | 'code' | 'tilde' | 'text' | 'none'

const kindOfWeft: Record<LoomWeft['type'], LineKind> = {
  FrontmatterWeft: 'frontmatter',
  HeadingWeft: 'heading',
  TocWeft: 'toc',
  ArrowWeft: 'arrow',
  CodeWeft: 'code',
  TildeWeft: 'tilde',
  PreambleWeft: 'text',
  ProseWeft: 'text',
}

const classifierKinds = (text: string): Effect.Effect<ReadonlyArray<LineKind>> =>
  Effect.gen(function* () {
    const sources = yield* LoomSourceRanges
    const classifier = yield* WeftClassifier
    const ranges = yield* sources.stream(text)
    const wefts = yield* Stream.runCollect(classifier.classifyWefts(text)(ranges))
    return Array.map(wefts, (weft) => kindOfWeft[weft.type])
  }).pipe(
    Effect.provide(LoomSourceRanges.layer),
    Effect.provide(WeftClassifier.layer),
    Effect.orDie,
  )

const lineBreak = /\r\n|\r|\n/

const lineCount = (text: string): number =>
  text.length === 0 ? 0 : text.split(lineBreak).length - (/(\r\n|\r|\n)$/.test(text) ? 1 : 0)

const grammarDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const treeSitterBinary = join(
  dirname(createRequire(import.meta.url).resolve('tree-sitter-cli/package.json')),
  process.platform === 'win32' ? 'tree-sitter.exe' : 'tree-sitter',
)

const treeSitter = (args: ReadonlyArray<string>): Effect.Effect<string> =>
  Effect.sync(
    () =>
      spawnSync(treeSitterBinary, args, {
        cwd: grammarDir,
        encoding: 'utf8',
        maxBuffer: 1 << 28,
      }).stdout,
  )

const scratch = mkdtempSync(join(tmpdir(), 'tree-sitter-loom-'))
const library = join(scratch, 'loom.so')

beforeAll(() => Effect.runPromise(treeSitter(['build', '--output', library])))

const parseTree = (file: string): Effect.Effect<string> =>
  treeSitter(['parse', '--lib-path', library, '--lang-name', 'loom', file])

type Block = 'frontmatter' | 'heading' | 'toc' | 'preamble' | 'code' | 'prose'

const blockKind: Record<Block, (offset: number) => LineKind> = {
  frontmatter: () => 'frontmatter',
  heading: () => 'heading',
  toc: () => 'toc',
  preamble: () => 'text',
  code: (offset) => (offset === 0 ? 'arrow' : 'code'),
  prose: (offset) => (offset === 0 ? 'tilde' : 'text'),
}

const blockPattern =
  /\((frontmatter|heading|toc|preamble|code|prose) \[(\d+), \d+\] - \[(\d+), (\d+)\]/g

const rowsOf = (match: RegExpMatchArray): ReadonlyArray<readonly [number, LineKind]> => {
  const [, block, startRow, endRow, endColumn] = match
  const start = Number(startRow)
  const end = Number(endColumn) === 0 ? Number(endRow) - 1 : Number(endRow)
  return Array.map(
    Array.range(start, end),
    (row) => [row, blockKind[block as Block](row - start)] as const,
  )
}

const grammarKinds = (tree: string, count: number): ReadonlyArray<LineKind> => {
  const rows = new Map(Array.flatMap(Array.fromIterable(tree.matchAll(blockPattern)), rowsOf))
  return count === 0 ? [] : Array.map(Array.range(0, count - 1), (row) => rows.get(row) ?? 'none')
}

type Disagreement = {
  readonly line: number
  readonly classifier: LineKind
  readonly grammar: LineKind
}

const disagreements = (
  classifier: ReadonlyArray<LineKind>,
  grammar: ReadonlyArray<LineKind>,
): ReadonlyArray<Disagreement> =>
  pipe(
    Array.zip(classifier, grammar),
    Array.map(([c, g], i) => ({ line: i + 1, classifier: c, grammar: g })),
    Array.filter((d) => d.classifier !== d.grammar),
  )

const checkLoom = (file: string): Effect.Effect<void> =>
  Effect.gen(function* () {
    const text = readFileSync(file, 'utf8')
    const tree = yield* parseTree(file)
    expect(tree).not.toMatch(/\((ERROR|MISSING)/)
    const count = lineCount(text)
    const classifier = Array.take(yield* classifierKinds(text), count)
    expect(disagreements(classifier, grammarKinds(tree, count))).toEqual([])
  })

describe('the generated parser', () => {
  it.effect(
    'matches what grammar.js generates',
    () =>
      Effect.gen(function* () {
        yield* treeSitter(['generate', '--output', join(scratch, 'generated')])
        expect(readFileSync(join(scratch, 'generated', 'parser.c'), 'utf8')).toBe(
          readFileSync(join(grammarDir, 'src', 'parser.c'), 'utf8'),
        )
      }),
    60_000,
  )
})

const repository = resolve(grammarDir, '..', '..')

const repositoryLooms: ReadonlyArray<string> = pipe(
  ['corpus', 'docs', 'examples'],
  Array.flatMap((folder) =>
    Array.map(
      readdirSync(join(repository, folder), { recursive: true, encoding: 'utf8' }),
      (path) => join(folder, path),
    ),
  ),
  Array.filter(
    (path) =>
      path.endsWith('.loom') &&
      path.split(/[\\/]/).every((part) => part !== 'node_modules' && !part.startsWith('.')),
  ),
)

describe('the grammar agrees with the classifier', () => {
  Array.forEach(repositoryLooms, (path) =>
    it.effect(path, () => checkLoom(join(repository, path)), 30_000),
  )
})

const anchor = (name: string): string => `::${'['}${name}]`

const fixture = (name: string, rows: ReadonlyArray<string>, ending: string = '\n'): string => {
  const file = join(scratch, `${name}.loom`)
  writeFileSync(file, rows.map((row) => `${row}${ending}`).join(''))
  return file
}

const explicitBlock = [
  '---',
  'Language: Markdown',
  '---',
  '',
  '# A README [README.md]',
  '',
  '~>',
  '# Title',
  '',
  '=> not an arrow here',
  '## Usage',
  '~',
  '',
  'Back in prose.',
  '',
  '=>',
  '',
  anchor('Usage'),
  '# The next section',
]

const fenceAndNote = [
  '# Quoting a loom',
  '',
  '```loom',
  '# Not a heading',
  '=>',
  '```',
  '~ still prose',
  '',
  `:${anchor('Note')} {}`,
  '# Also not a heading',
  ':::',
  '',
  '=>',
  '',
  'code()',
]

describe('the corners', () => {
  it.effect('an explicit block holds headings and arrows as code', () =>
    checkLoom(fixture('explicit', explicitBlock)),
  )
  it.effect('Windows line endings read as Unix ones do', () =>
    checkLoom(fixture('crlf', explicitBlock, '\r\n')),
  )
  it.effect('a fence and a note keep their marks inert', () =>
    checkLoom(fixture('fence-and-note', fenceAndNote)),
  )
  it.effect('a last line needs no line break', () =>
    Effect.gen(function* () {
      const file = join(scratch, 'unterminated.loom')
      writeFileSync(file, fenceAndNote.join('\n'))
      yield* checkLoom(file)
    }),
  )
})

afterAll(() => rmSync(scratch, { recursive: true, force: true }))
