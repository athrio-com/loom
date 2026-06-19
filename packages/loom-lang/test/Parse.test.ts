import { describe, expect, it } from '@effect/vitest'
import { Chunk, Effect, Schema, Stream, pipe } from 'effect'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { LoomSourceRanges } from '#ast/LineRanges'
import {
  LoomDocumentSchema,
  type LoomDocument,
  type LoomHeading,
} from '#ast/LoomAst'
import { parseDocument, ParseLayer } from './parse'
import { WeftClassifier } from '#ast/WeftClassifier'
import { WeftTokeniser } from '#ast/WeftTokeniser'
import { LoomWeftSchema, type LoomWeft } from '#ast/Weft'

// =============================================================================
// Loom AST — integration tests against `corpus/Fun.loom`.
//
// Three layers exercise the Effect-DI composition of the pipeline stages
// against the real-world example fixture:
//
//   Classifier Stage — LoomSourceRanges → WeftClassifier
//   Tokeniser Stage  — Classifier output → WeftTokeniser
//   AST Stage        — full parse chain via parseDocument(text) → LoomDocument
//
// The model is flat: a Document Preamble (the lines before the first heading,
// carrying the `{{lang: Scala}}` Warp) plus a list of Sections, one per
// heading at any level. Assertions target stage invariants rather than
// per-weft snapshots, so cosmetic changes to the fixture don't ripple through.
// =============================================================================

const fixturePath = resolve(__dirname, 'fixtures/Fun.loom')
const sampleLoom = readFileSync(fixturePath, 'utf8')

// The heading's title token source — the human-facing title, used to
// find tagless Sections (whose tag is named after the title). The token is
// already trimmed by the Tokeniser; absent titles read as "".
const headingText = (_text: string, heading: LoomHeading): string =>
  heading.title?.source ?? ''

const classifyText = (text: string): ReadonlyArray<LoomWeft> =>
  Effect.runSync(
    Effect.gen(function* () {
      const sources = yield* LoomSourceRanges
      const classifier = yield* WeftClassifier
      const ranges = yield* sources.stream(text)
      const stream = classifier.classifyWefts(text)(ranges)
      return Chunk.toReadonlyArray(yield* Stream.runCollect(stream))
    }).pipe(
      Effect.provide(LoomSourceRanges.Default),
      Effect.provide(WeftClassifier.Default),
      Effect.orDie,
    ),
  )

const tokeniseText = (text: string): ReadonlyArray<LoomWeft> =>
  Effect.runSync(
    Effect.gen(function* () {
      const sources = yield* LoomSourceRanges
      const classifier = yield* WeftClassifier
      const tokeniser = yield* WeftTokeniser
      const ranges = yield* sources.stream(text)
      const stream = pipe(
        ranges,
        classifier.classifyWefts(text),
        tokeniser.tokeniseWefts(text),
      )
      return Chunk.toReadonlyArray(yield* Stream.runCollect(stream))
    }).pipe(
      Effect.provide(LoomSourceRanges.Default),
      Effect.provide(WeftClassifier.Default),
      Effect.provide(WeftTokeniser.Default),
      Effect.orDie,
    ),
  )

const buildDocument = (text: string): LoomDocument =>
  Effect.runSync(parseDocument(text).pipe(Effect.provide(ParseLayer)))

// =============================================================================
// Classifier Stage — coverage of every probe kind, line accounting, schema
// validity per emitted weft.
// =============================================================================

describe('Classifier Stage — integration against corpus/Fun.loom', () => {
  const wefts = classifyText(sampleLoom)

  it('emits one weft per source line', () => {
    expect(wefts.length).toBe(sampleLoom.split('\n').length)
  })

  it('fires every Classifier-Stage probe at least once', () => {
    const seen = new Set(wefts.map((w) => w.type))
    expect(seen.has('HeadingWeft')).toBe(true)
    expect(seen.has('PreambleWeft')).toBe(true)
    expect(seen.has('ArrowWeft')).toBe(true)
    expect(seen.has('CodeWeft')).toBe(true)
    expect(seen.has('TildeWeft')).toBe(true)
    expect(seen.has('ProseWeft')).toBe(true)
  })

  it('every weft is a valid LoomWeft per schema', () => {
    for (const w of wefts) {
      expect(Schema.is(LoomWeftSchema)(w)).toBe(true)
    }
  })

  it('classifies one HeadingWeft per `#{1,6}` heading line (fourteen in the fixture)', () => {
    expect(wefts.filter((w) => w.type === 'HeadingWeft')).toHaveLength(14)
  })

  it('the lines before the first heading are all PreambleWefts (the Document Preamble)', () => {
    const firstHeading = wefts.findIndex((w) => w.type === 'HeadingWeft')
    for (const w of wefts.slice(0, firstHeading)) {
      expect(w.type).toBe('PreambleWeft')
    }
  })
})

// =============================================================================
// Tokeniser Stage — heading subtokens, specifier kinds, Warp/Anchor expansion,
// name-tag synthesis, post-Tokeniser health invariant.
// =============================================================================

describe('Tokeniser Stage — integration against corpus/Fun.loom', () => {
  const wefts = tokeniseText(sampleLoom)

  const filterByType = <K extends LoomWeft['type']>(
    type: K,
  ): ReadonlyArray<Extract<LoomWeft, { type: K }>> =>
    wefts.filter((w): w is Extract<LoomWeft, { type: K }> => w.type === type)

  const headings = () => filterByType('HeadingWeft')
  const headingTitled = (title: string) =>
    headings().find(
      (h) => headingText(sampleLoom, h as unknown as LoomHeading) === title,
    )

  it('emits one weft per source line', () => {
    expect(wefts.length).toBe(sampleLoom.split('\n').length)
  })

  it('every weft is a valid LoomWeft per schema', () => {
    for (const w of wefts) {
      expect(Schema.is(LoomWeftSchema)(w)).toBe(true)
    }
  })

  it('post-Tokeniser invariant: no weft is `incomplete`', () => {
    for (const w of wefts) {
      expect(w.health.status).not.toBe('incomplete')
    }
  })

  it('the fixture parses cleanly — every weft is okHealth', () => {
    for (const w of wefts) {
      expect(w.health.status).toBe('ok')
    }
  })

  it('a tagged heading carries its source tag', () => {
    const add = headings().find((h) => h.tag?.label.value === 'Add')
    expect(add).toBeDefined()
    expect(add!.tag?.health.status).toBe('ok')
  })

  it('a tagless heading is named after its title (ok health)', () => {
    const glossary = headingTitled('Glossary')
    expect(glossary).toBeDefined()
    expect(glossary!.tag).toBeDefined()
    expect(glossary!.tag?.health.status).toBe('ok')
    expect(glossary!.tag?.label.value).toBe('Glossary')
  })

  it('`# Build script [Build]{Bash}` carries a label Specifier (not a path)', () => {
    const build = headings().find((h) => h.tag?.label.value === 'Build')
    expect(build?.specifier?.type).toBe('Specifier')
    expect(build?.specifier?.label.value).toBe('Bash')
  })

  it('a tangle heading carries a PathSpecifier (path separators present)', () => {
    const tangle = headingTitled('Tangling the library')
    expect(tangle?.specifier?.type).toBe('PathSpecifier')
    expect(tangle?.specifier?.label.value).toBe(
      'src/main/scala/Arithmetic.scala',
    )
  })

  it('a PreambleWeft with `{{m: Mul}}` populates warps with the Mul reference', () => {
    const preamble = filterByType('PreambleWeft').find((w) =>
      w.warps.some((wp) => wp.name.value === 'm'),
    )
    if (!preamble) throw new Error('expected a PreambleWeft binding `m`')
    const warp = preamble.warps.find((wp) => wp.name.value === 'm')!
    expect(warp.annotation.value).toBe('Mul')
    expect(warp.default).toBeUndefined()
    expect(warp.health.status).toBe('ok')
  })

  it('the Document Preamble declares the `{{lang: Scala}}` Warp', () => {
    const lang = filterByType('PreambleWeft')
      .flatMap((w) => w.warps)
      .find((wp) => wp.name.value === 'lang')
    expect(lang).toBeDefined()
    expect(lang!.annotation.value).toBe('Scala')
  })

  it('the entry-point preamble declares three warps in one line (a, s, p)', () => {
    const preamble = filterByType('PreambleWeft').find(
      (w) => w.warps.length >= 3,
    )
    if (!preamble) throw new Error('expected a PreambleWeft with three warps')
    const names = preamble.warps.map((wp) => wp.name.value)
    expect(names).toEqual(['a', 's', 'p'])
  })

  it('a CodeWeft with `::[m]` populates anchors with the Mul reference', () => {
    const code = filterByType('CodeWeft').find((c) =>
      c.anchors.some((a) => a.name.value === 'm'),
    )
    if (!code) throw new Error('expected a CodeWeft referencing `m`')
    const anchor = code.anchors.find((a) => a.name.value === 'm')!
    expect(anchor.health.status).toBe('ok')
  })

  it('recognises a multi-word heading-name anchor `::[Entry point]` (ok health)', () => {
    const anchor = filterByType('CodeWeft')
      .flatMap((c) => c.anchors)
      .find((a) => a.name.value === 'Entry point')
    expect(anchor).toBeDefined()
    expect(anchor!.health.status).toBe('ok')
  })

  it('the entry-point body emits anchors for each top-level dependency', () => {
    const referenced = new Set(
      filterByType('CodeWeft').flatMap((c) =>
        c.anchors.map((a) => a.name.value),
      ),
    )
    expect(referenced.has('a')).toBe(true)
    expect(referenced.has('s')).toBe(true)
    expect(referenced.has('p')).toBe(true)
  })

  it("the fixture's `=>` lines carry no inline code or anchors", () => {
    for (const arrow of filterByType('ArrowWeft')) {
      expect(arrow.code).toBeUndefined()
      expect(arrow.anchors).toHaveLength(0)
    }
  })

  it('no heading title token contains the line terminator', () => {
    for (const h of headings()) {
      if (h.title) {
        expect(h.title.source).not.toMatch(/[\r\n]/)
      }
    }
  })
})

// =============================================================================
// AST Stage — end-to-end via parseDocument(text). Asserts the flat document-level
// structure: the Document Preamble on `document.preamble`, every heading as a
// flat Section on `document.sections`, and the `{{lang: Scala}}` declaration
// keeping the document's health `ok`.
// =============================================================================

describe('AST Stage — integration against corpus/Fun.loom', () => {
  const doc = buildDocument(sampleLoom)

  it('packages the fixture as a schema-valid LoomDocument', () => {
    expect(doc.type).toBe('LoomDocument')
    expect(Schema.is(LoomDocumentSchema)(doc)).toBe(true)
  })

  it('the `{{lang: Scala}}` declaration keeps document health `ok`', () => {
    expect(doc.health.status).toBe('ok')
  })

  it('collects the pre-heading lines on `document.preamble` (all PreambleWefts)', () => {
    expect(doc.preamble.length).toBeGreaterThan(0)
    for (const w of doc.preamble) {
      expect(w.type).toBe('PreambleWeft')
    }
    const lang = doc.preamble
      .flatMap((w) => w.warps)
      .find((wp) => wp.name.value === 'lang')
    expect(lang).toBeDefined()
  })

  it('collects every heading as a flat Section on `document.sections`', () => {
    expect(doc.sections).toHaveLength(14)
    const tags = doc.sections.map((s) => s.heading.tag?.label.value)
    expect(tags).toContain('Notes')
    expect(tags).toContain('Add')
    expect(tags).toContain('Mul')
    expect(tags).toContain('Sq')
    expect(tags).toContain('Pow')
    expect(tags).toContain('Main')
    expect(tags).toContain('Build')
  })

  it('tagless Sections still carry an identifier (named after the title)', () => {
    const glossary = doc.sections.find(
      (s) => headingText(sampleLoom, s.heading) === 'Glossary',
    )
    expect(glossary).toBeDefined()
    expect(glossary!.heading.tag?.label.value).toBe('Glossary')
  })

  it('the `Notes` Section carries its body wefts in order', () => {
    const notes = doc.sections.find(
      (s) => s.heading.tag?.label.value === 'Notes',
    )!
    expect(notes.preamble.length).toBeGreaterThan(0)
    expect(notes.code.length).toBeGreaterThan(0)
    const codeKinds = new Set(notes.code.map((w) => w.type))
    expect(codeKinds.has('ArrowWeft')).toBe(true)
    expect(codeKinds.has('CodeWeft')).toBe(true)
    expect(codeKinds.has('TildeWeft')).toBe(true)
    expect(codeKinds.has('ProseWeft')).toBe(true)
  })

  it('a tangle Section keeps its PathSpecifier on the heading', () => {
    const tangle = doc.sections.find(
      (s) => headingText(sampleLoom, s.heading) === 'Tangling the library',
    )!
    expect(tangle.heading.specifier?.type).toBe('PathSpecifier')
  })

  it('Sections appear in document order', () => {
    const offsets = doc.sections.map((s) => s.position.start.offset)
    const sorted = [...offsets].sort((a, b) => a - b)
    expect(offsets).toEqual(sorted)
  })
})

// =============================================================================
// parseDocument — parse-chain behaviour. The chain wires the four parse stages
// and catches `MixedEOL` at the boundary, converting it to a minimal empty
// document with NOK root health. Edge cases (empty source, single-line source
// without terminator) flow through normally.
// =============================================================================

describe('parseDocument — parse-chain behaviour', () => {
  it('recovers MixedEOL as an empty document with NOK root health and a positioned diagnostic', () => {
    // CRLF on line 1, bare LF on line 2 — primary convention is CRLF, the
    // stray LF triggers MixedEOL.
    const text = 'Line one\r\nLine two\nLine three'
    const doc = buildDocument(text)
    expect(doc.health.status).toBe('error')
    expect(doc.health.diagnostics).toHaveLength(1)
    expect(doc.health.diagnostics[0].message).toMatch(/mixed line terminators/i)
    expect(doc.preamble).toEqual([])
    expect(doc.sections).toEqual([])
    expect(doc.position.start.offset).toBe(0)
    expect(doc.position.end.offset).toBe(text.length)
  })

  it('MixedEOL recovery produces a schema-valid LoomDocument', () => {
    const doc = buildDocument('a\r\nb\nc')
    expect(Schema.is(LoomDocumentSchema)(doc)).toBe(true)
  })

  it('handles empty source — one Document-Preamble weft, no Sections', () => {
    // LoomSourceRanges emits a single `[0, 0]` range for input with no
    // terminators; the Classifier emits one Document-Preamble PreambleWeft.
    const doc = buildDocument('')
    expect(doc.preamble).toHaveLength(1)
    expect(doc.preamble[0].type).toBe('PreambleWeft')
    expect(doc.sections).toEqual([])
    // No `{{lang: …}}` Warp → the document health is a warning.
    expect(doc.health.status).toBe('warning')
  })

  it('handles single-line source without trailing newline', () => {
    const doc = buildDocument('just a single line')
    expect(doc.preamble).toHaveLength(1)
    expect(doc.preamble[0].position.end.offset).toBe(
      'just a single line'.length,
    )
    expect(doc.sections).toEqual([])
  })

  it('ParseLayer provides the whole parse chain — all four stage services', () => {
    // ParseLayer merges the four stage Defaults (LoomSourceRanges, Classifier,
    // Tokeniser, AstBuilder); the chain needs nothing else.
    const doc = buildDocument('# T [T]{L}\n')
    expect(doc.sections).toHaveLength(1)
    expect(doc.sections[0].heading.tag?.label.value).toBe('T')
  })

  it('a document with no `{{lang: …}}` Warp carries a warning on its health', () => {
    const doc = buildDocument('# Solo [Solo]\n')
    expect(doc.health.status).toBe('warning')
    expect(doc.health.diagnostics[0].message).toMatch(/lang/i)
  })
})

// =============================================================================
// parseDocument — NOK preservation end-to-end. Malformed source flows through
// the chain; the Tokeniser keeps rejected bytes in `unexpected[]` and flips the
// affected leaf to error health, the AstBuilder forwards them onto the
// resulting `LoomHeading`. Container nodes stay `okHealth`. A tagless heading
// is NOT an error — it is named after its title.
// =============================================================================

describe('parseDocument — NOK preservation end-to-end', () => {
  it('a tagless heading is named after its title with ok health (not an error)', () => {
    const doc = buildDocument('{{lang: Scala}}\n\n# JustATitle\n')
    const heading = doc.sections[0].heading
    expect(heading.tag).toBeDefined()
    expect(heading.tag?.health.status).toBe('ok')
    expect(heading.tag?.label.value).toBe('JustATitle')
  })

  it('section tag label with spaces — bytes preserved in unexpected[], empty value, error health', () => {
    const doc = buildDocument('{{lang: Scala}}\n\n# Heading [bad label name]\n')
    const label = doc.sections[0].heading.tag!.label
    expect(label.value).toBe('')
    expect(label.health.status).toBe('error')
    expect(label.unexpected?.[0].value).toBe('bad label name')
  })

  it('unclosed `[` — synthetic TagClose at EOL with `expected closing` diagnostic', () => {
    const doc = buildDocument('{{lang: Scala}}\n\n# Heading [Unclosed\n')
    const close = doc.sections[0].heading.tag!.close
    expect(close.health.status).toBe('error')
    expect(close.health.diagnostics[0].message).toMatch(/expected closing/i)
  })

  it('container LoomDocument / LoomSection carry okHealth despite leaf errors', () => {
    const doc = buildDocument('{{lang: Scala}}\n\n# Section [bad label name]\n')
    expect(doc.health.status).toBe('ok')
    expect(doc.sections[0].health.status).toBe('ok')
  })

  it('malformed sections still appear structurally with full body wefts attached', () => {
    const text =
      '{{lang: Scala}}\n\n# Bad [bad label name]\n\nA preamble line.\n\n=>\n\nval x = 42\n'
    const doc = buildDocument(text)
    const section = doc.sections[0]
    expect(section).toBeDefined()
    expect(section.preamble.length).toBeGreaterThan(0)
    expect(section.code.length).toBeGreaterThan(0)
  })

  it('schema validity holds across every NOK input variant', () => {
    const malformed = [
      '# JustATitle\n',
      '# Title [Tag]\n',
      '# OnlyTitle {Lang}\n',
      '# Heading [bad label name]\n',
      '# Heading [Unclosed\n',
      '# Heading [Tag]{Unclosed\n',
    ]
    for (const text of malformed) {
      const doc = buildDocument(text)
      expect(Schema.is(LoomDocumentSchema)(doc)).toBe(true)
    }
  })
})
