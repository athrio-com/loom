import { describe, expect, it } from '@effect/vitest'
import { Effect, Layer, Option } from 'effect'
import { parseDocument, ParseLayer } from './parse'
import { symbolsOf } from '@athrio/loom-ast/LoomSymbol'
import { DocumentSource, LoomCompiler } from '../src/LoomCompiler'
import { LoomMemo } from '../src/LoomMemo'
import { PackageConfig } from '../src/PackageConfig'
import { defaultAnchorDelims } from '@athrio/loom-ast/LoomTokens'

// A `{TOC}` heading opens a table-of-contents section. Every heading H2–H6 and
// every list line inside it is a toc weft — never a section, never prose — until
// the next top-level `#`. `####` is a part, and a numbered item is a chapter whose
// list number is its `Chapter N` and whose text is its title.
const fixture = `# Contents {TOC}

#### Part III — The shape of a loom

1. The node foundation
2. The leaf tokens

#### Part IV — Reading the text

1. Line ranges

# Afterword

Ordinary prose after the contents.
`

const parse = (src: string) =>
  Effect.runSync(parseDocument(src).pipe(Effect.provide(ParseLayer)))

describe('the table-of-contents section', () => {
  it('keeps the whole listing in one section, exiting at the next H1', () => {
    const doc = parse(fixture)
    // Two sections only: the {TOC} section and the Afterword — the `####` part
    // headings never open sections of their own.
    expect(doc.sections.map((s) => s.heading.title?.source)).toEqual([
      'Contents',
      'Afterword',
    ])
  })

  it('collects the parts and chapters into the section entries', () => {
    const doc = parse(fixture)
    const entries = doc.sections[0].entries ?? []

    const parts = entries.flatMap((e) => (e.part ? [e.part.value] : []))
    expect(parts).toEqual([
      'Part III — The shape of a loom',
      'Part IV — Reading the text',
    ])

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

// A two-file corpus: a book whose contents lists one chapter that exists and one
// that does not, and the chapter itself. The compiler resolves the entry the same
// way it resolves an anchor — go-to-definition follows it to the chapter, and an
// entry that names no chapter is a diagnostic.
const book = `# Contents {TOC}

#### Part III — The shape of a loom

1. The node foundation
2. A chapter that is missing
`

const chapter = `---
Part III, Chapter 1: The node foundation
Package: pkg/LoomNode.ts
Language: TypeScript
---

# The node foundation

=>

export const x = 1
`

const corpus: Record<string, string> = {
  '/book.loom': book,
  '/node.loom': chapter,
}

const makeCompilerLayer = (files: Record<string, string>) =>
  Layer.provide(
    Layer.merge(LoomCompiler.Default, LoomMemo.Default),
    Layer.merge(
      Layer.succeed(
        DocumentSource,
        new DocumentSource({
          read: (path: string) => Effect.succeed(files[path] ?? ''),
          list: Option.some(() => Effect.succeed(Object.keys(files))),
        }),
      ),
      Layer.succeed(
        PackageConfig,
        new PackageConfig({
          resolve: () =>
            Effect.succeed({
              delims: defaultAnchorDelims,
              primaryLanguage: undefined,
              packageRoot: undefined,
              workspaceRoot: undefined,
              corpusDir: undefined,
            }),
        }),
      ),
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
      // the chapter's frontmatter title — line 1 (0-based), not the heading
      expect(target?.range.start.line).toBe(1)
    }).pipe(Effect.provide(compilerLayer)),
  )

  it.effect('an entry that names no chapter reports a diagnostic', () =>
    Effect.gen(function* () {
      const c = yield* LoomCompiler
      const messages = (yield* c.diagnose('/book.loom')).map((d) => d.message)
      expect(messages.some((m) => m.includes('no chapter titled'))).toBe(true)
      expect(messages.join('\n')).toContain('A chapter that is missing')
      // the entry that does resolve raises nothing
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
      expect(at('/book.loom', 4)).toBe(true) // the entry itself
      expect(at('/node.loom', 1)).toBe(true) // the frontmatter title — the identity
      expect(at('/node.loom', 6)).toBe(false) // not the heading
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

// A part is announced in its opening chapter's frontmatter — the standalone
// `Part I: Using Loom`. A contents part heading and every later chapter's
// `Part I` reference it, keyed by the part number, and resolve to the opener.
const partBook = `# Contents {TOC}

### Part I — Using Loom

1. A first loom
2. A workspace
`

const opener = `---
Part I: Using Loom
Chapter 1: A first loom
Language: Prose
---

# A first loom

The opening chapter.
`

const workspace = `---
Part I, Chapter 2: A workspace
Language: Prose
---

# A workspace

The second chapter.
`

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
      // the `Part I: Using Loom` announcement — line 1 (0-based)
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
      expect(has('/opener.loom', 1)).toBe(true) // the announcement
      expect(has('/workspace.loom', 1)).toBe(true) // the chapter's `Part I`
      expect(has('/book.loom', 2)).toBe(true) // the contents part heading
    }).pipe(Effect.provide(partLayer)),
  )

  it.effect('a part underlines its whole span but offers no rename', () =>
    Effect.gen(function* () {
      const c = yield* LoomCompiler
      const offset = partBook.indexOf('Part I — Using Loom') + 2
      const nav = yield* c.navigationRange('/book.loom', offset)
      const ren = yield* c.renameRange('/book.loom', offset)
      const width =
        (nav?.range.end.character ?? 0) - (nav?.range.start.character ?? 0)
      expect(nav).not.toBeUndefined()
      expect(width).toBeGreaterThan('Part I'.length) // the whole label, not a word
      expect(ren).toBeUndefined() // navigable, but not yet renameable
    }).pipe(Effect.provide(partLayer)),
  )
})
