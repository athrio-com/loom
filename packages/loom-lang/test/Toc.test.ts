import { describe, expect, it as it_ } from 'bun:test'
import { effectify } from '@athrio/effect-test'
import { Effect, Layer, Option } from 'effect'
import { parseDocument, ParseLayer } from './parse'
import { symbolsOf } from '@athrio/loom-ast/LoomSymbol'
import { DocumentSource, LoomCompiler } from '../src/LoomCompiler'
import { LoomMemo } from '../src/LoomMemo'
import { WorkspaceSettings } from '../src/WorkspaceSettings'
import { LoomDiskCache } from '../src/LoomDiskCache'
import { FileSystemSource } from '../src/WorkspaceSource'
import { defaultAnchorDelims } from '@athrio/loom-ast/LoomTokens'

const it = effectify(it_)

const lines = (...rows: ReadonlyArray<string>): string => `${rows.join('\n')}\n`

const fixture = lines(
  '# Contents {TOC}',
  '',
  '#### Part III — The shape of a loom',
  '',
  '1. The node foundation',
  '2. The leaf tokens',
  '',
  '#### Part IV — Reading the text',
  '',
  '1. Line ranges',
  '',
  '# Afterword',
  '',
  'Ordinary prose after the contents.',
)

const parse = (src: string) => Effect.runSync(parseDocument(src).pipe(Effect.provide(ParseLayer)))

describe('the table-of-contents section', () => {
  it('keeps the whole listing in one section, exiting at the next H1', () => {
    const doc = parse(fixture)
    expect(doc.sections.map((s) => s.heading.title?.source)).toEqual(['Contents', 'Afterword'])
  })

  it('collects the parts and chapters into the section entries', () => {
    const doc = parse(fixture)
    const entries = doc.sections[0].entries ?? []

    const parts = entries.flatMap((e) => (e.part ? [e.part.value] : []))
    expect(parts).toEqual(['Part III — The shape of a loom', 'Part IV — Reading the text'])

    const chapters = entries.flatMap((e) =>
      e.chapter && e.title ? [[e.chapter.value, e.title.value]] : [],
    )
    expect(chapters).toEqual([
      ['1', 'The node foundation'],
      ['2', 'The leaf tokens'],
      ['1', 'Line ranges'],
    ])
  })

  it('leaves an ordinary section with no entries', () => {
    const doc = parse(fixture)
    expect(doc.sections[1].entries).toBeUndefined()
  })

  it('emits a tocPart and a tocEntry symbol for each part and chapter', () => {
    const kinds = symbolsOf(parse(fixture)).map((s) => s.kind)
    expect(kinds.filter((k) => k === 'tocPart')).toHaveLength(2)
    expect(kinds.filter((k) => k === 'tocEntry')).toHaveLength(3)
  })
})

const book = lines(
  '# Contents {TOC}',
  '',
  '#### Part III — The shape of a loom',
  '',
  '1. The node foundation',
  '2. A chapter that is missing',
)

const chapter = lines(
  '---',
  'Part III, Chapter 1: The node foundation',
  'Package: pkg/LoomNode.ts',
  'Language: TypeScript',
  '---',
  '',
  '# The node foundation',
  '',
  '=>',
  '',
  'export const x = 1',
)

const corpus: Record<string, string> = {
  '/book.loom': book,
  '/node.loom': chapter,
}

const makeCompilerLayer = (files: Record<string, string>) =>
  Layer.provide(
    Layer.merge(LoomCompiler.layer, LoomMemo.layer),
    Layer.mergeAll(
      FileSystemSource,
      LoomDiskCache.none,
      Layer.succeed(DocumentSource, {
        read: (path: string) => Effect.succeed(files[path] ?? ''),
        list: Option.some(() => Effect.succeed(Object.keys(files))),
        hold: () => Effect.void,
        forget: () => Effect.void,
      }),
      Layer.succeed(WorkspaceSettings, {
        manifest: () => Effect.succeed(Option.none()),
        resolve: () =>
          Effect.succeed({
            delims: defaultAnchorDelims,
            primaryLanguage: undefined,
            variables: {},
            width: 100,
          }),
      }),
    ),
  )

const compilerLayer = makeCompilerLayer(corpus)

describe('the table of contents in the editor', () => {
  it.effect('a chapter entry navigates to the chapter it names', () =>
    Effect.gen(function* () {
      const c = yield* LoomCompiler
      const offset = book.indexOf('The node foundation') + 2
      const target = yield* c.definition('/book.loom', offset)
      expect(target?.path).toBe('/node.loom')
      expect(target?.range.start.line).toBe(1)
    }).pipe(Effect.provide(compilerLayer)),
  )

  it.effect('an entry that names no chapter reports a diagnostic', () =>
    Effect.gen(function* () {
      const c = yield* LoomCompiler
      const messages = (yield* c.diagnose('/book.loom')).map((d) => d.message)
      expect(messages.some((m) => m.includes('No chapter is titled'))).toBe(true)
      expect(messages.join('\n')).toContain('A chapter that is missing')
      expect(messages.some((m) => m.includes('The node foundation'))).toBe(false)
    }).pipe(Effect.provide(compilerLayer)),
  )

  it.effect('references gathers the chapter and the entry that names it', () =>
    Effect.gen(function* () {
      const c = yield* LoomCompiler
      const offset = book.indexOf('The node foundation') + 2
      const refs = yield* c.references('/book.loom', offset)
      const at = (path: string, line: number) =>
        refs.some((r) => r.path === path && r.range.start.line === line)
      expect(at('/book.loom', 4)).toBe(true)
      expect(at('/node.loom', 1)).toBe(true)
      expect(at('/node.loom', 6)).toBe(false)
    }).pipe(Effect.provide(compilerLayer)),
  )

  it.effect('rename rewrites the chapter title and the entry together', () =>
    Effect.gen(function* () {
      const c = yield* LoomCompiler
      const offset = book.indexOf('The node foundation') + 2
      const edits = yield* c.rename('/book.loom', offset)
      const paths = edits.map((e) => e.path).sort()
      expect(paths).toEqual(['/book.loom', '/node.loom'])
    }).pipe(Effect.provide(compilerLayer)),
  )
})

const twoParts = lines(
  '# Contents {TOC}',
  '',
  '#### Part I — Saying things',
  '',
  '1. Setup',
  '',
  '#### Part II — Doing things',
  '',
  '1. Setup',
  '',
  '#### Part III — Leaving',
  '',
  '1. Setup',
)

const setupIn = (part: string): string =>
  lines('---', `Part ${part}, Chapter 1: Setup`, '---', '', '# Setup', '', '=>', '', 'const x = 1')

const partsLayer = makeCompilerLayer({
  '/book.loom': twoParts,
  '/setup-one.loom': setupIn('I'),
  '/setup-two.loom': setupIn('II'),
})

const entryUnder = (part: string): number =>
  twoParts.indexOf('1. Setup', twoParts.indexOf(`Part ${part} —`)) + 4

describe('the contents resolve an entry within its part', () => {
  it.effect('an entry navigates to the chapter of its own part', () =>
    Effect.gen(function* () {
      const c = yield* LoomCompiler
      expect((yield* c.definition('/book.loom', entryUnder('I')))?.path).toBe('/setup-one.loom')
      expect((yield* c.definition('/book.loom', entryUnder('II')))?.path).toBe('/setup-two.loom')
    }).pipe(Effect.provide(partsLayer)),
  )

  it.effect('a rename moves one chapter and its own entry', () =>
    Effect.gen(function* () {
      const c = yield* LoomCompiler
      const titleOffset = setupIn('I').indexOf('Setup')
      const edits = yield* c.rename('/setup-one.loom', titleOffset)
      expect(edits.map((e) => `${e.path}:${e.range.start.line}`).sort()).toEqual([
        '/book.loom:4',
        '/setup-one.loom:1',
      ])
    }).pipe(Effect.provide(partsLayer)),
  )

  it.effect('an entry under a part that holds no such chapter is unresolved', () =>
    Effect.gen(function* () {
      const c = yield* LoomCompiler
      const diagnostics = yield* c.diagnose('/book.loom')
      expect(diagnostics.map((d) => [d.position.start.line, d.message])).toEqual([
        [13, 'No chapter is titled `Setup`. Run `loom toc` to bring the contents up to date.'],
      ])
    }).pipe(Effect.provide(partsLayer)),
  )
})

const partBook = lines(
  '# Contents {TOC}',
  '',
  '### Part I — Using Loom',
  '',
  '1. A first loom',
  '2. A workspace',
)

const opener = lines(
  '---',
  'Part I: Using Loom',
  'Chapter 1: A first loom',
  'Language: Prose',
  '---',
  '',
  '# A first loom',
  '',
  'The opening chapter.',
)

const workspace = lines(
  '---',
  'Part I, Chapter 2: A workspace',
  'Language: Prose',
  '---',
  '',
  '# A workspace',
  '',
  'The second chapter.',
)

const partCorpus: Record<string, string> = {
  '/book.loom': partBook,
  '/opener.loom': opener,
  '/workspace.loom': workspace,
}

const partLayer = makeCompilerLayer(partCorpus)

describe('parts navigate to where they are announced', () => {
  it.effect('a contents part heading goes to the opening frontmatter', () =>
    Effect.gen(function* () {
      const c = yield* LoomCompiler
      const offset = partBook.indexOf('Part I — Using Loom') + 2
      const target = yield* c.definition('/book.loom', offset)
      expect(target?.path).toBe('/opener.loom')
      expect(target?.range.start.line).toBe(1)
    }).pipe(Effect.provide(partLayer)),
  )

  it.effect("a chapter's `Part I` goes to the opening frontmatter", () =>
    Effect.gen(function* () {
      const c = yield* LoomCompiler
      const offset = workspace.indexOf('Part I,') + 2
      const target = yield* c.definition('/workspace.loom', offset)
      expect(target?.path).toBe('/opener.loom')
      expect(target?.range.start.line).toBe(1)
    }).pipe(Effect.provide(partLayer)),
  )

  it.effect('references gather the announcement, the parts, and the heading', () =>
    Effect.gen(function* () {
      const c = yield* LoomCompiler
      const offset = opener.indexOf('Using Loom') + 2
      const refs = yield* c.references('/opener.loom', offset)
      const has = (path: string, line: number) =>
        refs.some((r) => r.path === path && r.range.start.line === line)
      expect(has('/opener.loom', 1)).toBe(true)
      expect(has('/workspace.loom', 1)).toBe(true)
      expect(has('/book.loom', 2)).toBe(true)
    }).pipe(Effect.provide(partLayer)),
  )

  it.effect('a part underlines its whole span but offers no rename', () =>
    Effect.gen(function* () {
      const c = yield* LoomCompiler
      const offset = partBook.indexOf('Part I — Using Loom') + 2
      const nav = yield* c.navigationRange('/book.loom', offset)
      const ren = yield* c.renameRange('/book.loom', offset)
      const width = (nav?.range.end.character ?? 0) - (nav?.range.start.character ?? 0)
      expect(nav).not.toBeUndefined()
      expect(width).toBeGreaterThan('Part I'.length)
      expect(ren).toBeUndefined()
    }).pipe(Effect.provide(partLayer)),
  )
})

describe('regenerating the contents', () => {
  const described = lines(
    '# Contents {TOC}',
    '',
    '### Part I — Rooms',
    '',
    'Rooms hold the world.',
    '',
    'Each room is a grid.',
    '',
    '1. Walls',
  )
  const walls = lines('---', 'Part I: Rooms', 'Chapter 1: Walls', '---', '', '# Walls')
  const contentsOf = (book: string) =>
    LoomCompiler.pipe(
      Effect.flatMap((compiler) => compiler.contents('/book.loom')),
      Effect.provide(makeCompilerLayer({ '/book.loom': book, '/walls.loom': walls })),
    )

  it.effect('keeps a description of several paragraphs as written', () =>
    Effect.gen(function* () {
      expect(yield* contentsOf(described)).toBe(described)
    }),
  )

  it.effect('closes up the blank lines an older run left between paragraphs', () =>
    Effect.gen(function* () {
      const padded = described.replace('world.\n\n', 'world.\n\n\n\n\n\n\n')
      expect(yield* contentsOf(padded)).toBe(described)
    }),
  )
})
