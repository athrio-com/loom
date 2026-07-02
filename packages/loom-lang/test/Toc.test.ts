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

const compilerLayer = Layer.provide(
  Layer.merge(LoomCompiler.Default, LoomMemo.Default),
  Layer.merge(
    Layer.succeed(
      DocumentSource,
      new DocumentSource({
        read: (path: string) => Effect.succeed(corpus[path] ?? ''),
        list: Option.some(() => Effect.succeed(Object.keys(corpus))),
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

describe('the table of contents in the editor', () => {
  it.effect('a chapter entry navigates to the chapter it names', () =>
    Effect.gen(function* () {
      const c = yield* LoomCompiler
      const offset = book.indexOf('The node foundation') + 2
      const target = yield* c.definition('/book.loom', offset)
      expect(target?.path).toBe('/node.loom')
      // the chapter's `# The node foundation` heading — line 6 (0-based)
      expect(target?.range.start.line).toBe(6)
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
      expect(at('/node.loom', 6)).toBe(true) // the `# The node foundation` heading
      expect(at('/node.loom', 1)).toBe(true) // the frontmatter title
    }).pipe(Effect.provide(compilerLayer)),
  )

  it.effect('rename rewrites the chapter title and the entry together', () =>
    Effect.gen(function* () {
      const c = yield* LoomCompiler
      const offset = book.indexOf('The node foundation') + 2
      const edits = yield* c.rename('/book.loom', offset)
      const paths = edits.map((e) => e.path).sort()
      expect(paths).toEqual(['/book.loom', '/node.loom', '/node.loom'])
    }).pipe(Effect.provide(compilerLayer)),
  )
})
