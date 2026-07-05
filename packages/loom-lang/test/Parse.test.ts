import { describe, expect, it as it_ } from 'bun:test'
import { effectify } from '@athrio/effect-test'
const it = effectify(it_)
import { Effect, Schema, Stream, pipe } from 'effect'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { LoomSourceRanges } from '#ast/LineRanges'
import {
  LoomDocumentSchema,
  type LoomDocument,
  type LoomHeading,
} from '@athrio/loom-ast/LoomAst'
import { parseDocument, ParseLayer } from './parse'
import { WeftClassifier } from '#ast/WeftClassifier'
import { WeftTokeniser } from '#ast/WeftTokeniser'
import { LoomWeftSchema, type LoomWeft } from '@athrio/loom-ast/Weft'

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
// The model is flat: a frontmatter block (declaring `Scala` as the primary
// language), a Document Preamble (the prose before the first heading), and a
// list of Sections, one per heading at any level. Assertions target stage
// invariants rather than per-weft snapshots, so cosmetic changes to the fixture
// don't ripple through.
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
      return yield* Stream.runCollect(stream)
    }).pipe(
      Effect.provide(LoomSourceRanges.layer),
      Effect.provide(WeftClassifier.layer),
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
      return yield* Stream.runCollect(stream)
    }).pipe(
      Effect.provide(LoomSourceRanges.layer),
      Effect.provide(WeftClassifier.layer),
      Effect.provide(WeftTokeniser.layer),
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
    expect(seen.has('FrontmatterWeft')).toBe(true)
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

  it('classifies one HeadingWeft per `#{1,6}` heading line (thirteen in the fixture)', () => {
    expect(wefts.filter((w) => w.type === 'HeadingWeft')).toHaveLength(13)
  })

  it('the lines before the first heading are the frontmatter then the Document Preamble', () => {
    const firstHeading = wefts.findIndex((w) => w.type === 'HeadingWeft')
    for (const w of wefts.slice(0, firstHeading)) {
      expect(['FrontmatterWeft', 'PreambleWeft']).toContain(w.type)
    }
  })
})

// =============================================================================
// Tokeniser Stage — heading subtokens, specifier kinds, Warp/Anchor expansion,
// title-named sections, post-Tokeniser health invariant.
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

  it('a heading is named by its title (ok health)', () => {
    const glossary = headingTitled('Glossary')
    expect(glossary).toBeDefined()
    expect(glossary!.title).toBeDefined()
    expect(glossary!.health.status).toBe('ok')
    expect(glossary!.title?.source).toBe('Glossary')
  })

  it('`# Build script {Bash}` carries a language Specifier (not a sink)', () => {
    const build = headingTitled('Build script')
    expect(build?.specifier?.type).toBe('Specifier')
    expect(build?.specifier?.label.value).toBe('Bash')
    expect(build?.sink).toBeUndefined()
  })

  it('a tangle heading carries a `{Tangle}` specifier and a file Sink', () => {
    const tangle = headingTitled('Tangling the library')
    expect(tangle?.sink?.type).toBe('Sink')
    expect(tangle?.sink?.file.value).toBe('Arithmetic.scala')
    expect(tangle?.specifier?.label.value).toBe('Tangle')
  })

  it('a PreambleWeft with `{{rounds = 3}}` populates warps with the value binding', () => {
    const preamble = filterByType('PreambleWeft').find((w) =>
      w.warps.some((wp) => wp.name.value === 'rounds'),
    )
    if (!preamble) throw new Error('expected a PreambleWeft binding `rounds`')
    const warp = preamble.warps.find((wp) => wp.name.value === 'rounds')!
    expect(warp.default?.value).toBe('3')
    expect(warp.annotation).toBeUndefined()
    expect(warp.health.status).toBe('ok')
  })

  it('the frontmatter declares `Language: Scala`', () => {
    const language = filterByType('FrontmatterWeft').find(
      (w) => w.key?.value === 'Language',
    )
    expect(language).toBeDefined()
    expect(language!.value?.value).toBe('Scala')
  })

  it('a CodeWeft with `::[rounds]` populates anchors with the value reference', () => {
    const code = filterByType('CodeWeft').find((c) =>
      c.anchors.some((a) => a.name.value === 'rounds'),
    )
    if (!code) throw new Error('expected a CodeWeft referencing `rounds`')
    const anchor = code.anchors.find((a) => a.name.value === 'rounds')!
    expect(anchor.health.status).toBe('ok')
  })

  it('recognises a multi-word heading-name anchor `::[Entry point]` (ok health)', () => {
    const anchor = filterByType('CodeWeft')
      .flatMap((c) => c.anchors)
      .find((a) => a.name.value === 'Entry point')
    expect(anchor).toBeDefined()
    expect(anchor!.health.status).toBe('ok')
  })

  it('the entry-point body emits a name anchor for each top-level dependency', () => {
    const referenced = new Set(
      filterByType('CodeWeft').flatMap((c) =>
        c.anchors.map((a) => a.name.value),
      ),
    )
    expect(referenced.has('Adder')).toBe(true)
    expect(referenced.has('Square')).toBe(true)
    expect(referenced.has('Power')).toBe(true)
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
// structure: the frontmatter on `document.frontmatter`, the Document Preamble on
// `document.preamble`, every heading as a flat Section on `document.sections`,
// and the `Language: Scala` frontmatter keeping the document's health `ok`.
// =============================================================================

describe('AST Stage — integration against corpus/Fun.loom', () => {
  const doc = buildDocument(sampleLoom)

  it('packages the fixture as a schema-valid LoomDocument', () => {
    expect(doc.type).toBe('LoomDocument')
    expect(Schema.is(LoomDocumentSchema)(doc)).toBe(true)
  })

  it('the `Language: Scala` frontmatter keeps document health `ok`', () => {
    expect(doc.health.status).toBe('ok')
    expect(doc.frontmatter?.language?.value).toBe('Scala')
  })

  it('collects the pre-heading prose on `document.preamble` (all PreambleWefts)', () => {
    expect(doc.preamble.length).toBeGreaterThan(0)
    for (const w of doc.preamble) {
      expect(w.type).toBe('PreambleWeft')
    }
  })

  it('collects every heading as a flat Section on `document.sections`', () => {
    expect(doc.sections).toHaveLength(13)
    const titles = doc.sections.map((s) => s.heading.title?.source)
    expect(titles).toContain('Reading notes')
    expect(titles).toContain('Adder')
    expect(titles).toContain('Multiplier')
    expect(titles).toContain('Square')
    expect(titles).toContain('Power')
    expect(titles).toContain('Entry point')
    expect(titles).toContain('Build script')
  })

  it('every Section carries an identifier (named after the title)', () => {
    const glossary = doc.sections.find(
      (s) => headingText(sampleLoom, s.heading) === 'Glossary',
    )
    expect(glossary).toBeDefined()
    expect(glossary!.heading.title?.source).toBe('Glossary')
  })

  it('the `Reading notes` Section carries its body wefts in order', () => {
    const notes = doc.sections.find(
      (s) => s.heading.title?.source === 'Reading notes',
    )!
    expect(notes.preamble.length).toBeGreaterThan(0)
    expect(notes.code.length).toBeGreaterThan(0)
    const codeKinds = new Set(notes.code.map((w) => w.type))
    expect(codeKinds.has('ArrowWeft')).toBe(true)
    expect(codeKinds.has('CodeWeft')).toBe(true)
    expect(codeKinds.has('TildeWeft')).toBe(true)
    expect(codeKinds.has('ProseWeft')).toBe(true)
  })

  it('a tangle Section keeps its Sink on the heading', () => {
    const tangle = doc.sections.find(
      (s) => headingText(sampleLoom, s.heading) === 'Tangling the library',
    )!
    expect(tangle.heading.sink?.type).toBe('Sink')
    expect(tangle.heading.sink?.file.value).toBe('Arithmetic.scala')
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
    // The parse layer reports structural health only: an empty, well-formed
    // document is `ok`. A missing `Language` is a later-pass concern, not a
    // parse-level one, so the LoomDocument carries no diagnostic.
    expect(doc.health.status).toBe('ok')
    expect(doc.health.diagnostics).toEqual([])
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
    const doc = buildDocument('# T {L}\n')
    expect(doc.sections).toHaveLength(1)
    expect(doc.sections[0].heading.title?.source).toBe('T')
    expect(doc.sections[0].heading.specifier?.label.value).toBe('L')
  })

  it('a document with no `Language` frontmatter still parses with ok health', () => {
    // The parse layer does not flag a missing primary language — that is a
    // later-pass concern. The language-less document is structurally well-formed,
    // so its health is `ok` and it carries its one Section. The trailing
    // `[Solo]` is a file Sink, not title text.
    const doc = buildDocument('# Solo [Solo]\n')
    expect(doc.health.status).toBe('ok')
    expect(doc.health.diagnostics).toEqual([])
    expect(doc.sections).toHaveLength(1)
    expect(doc.sections[0].heading.title?.source).toBe('Solo')
    expect(doc.sections[0].heading.sink?.file.value).toBe('Solo')
  })
})

// =============================================================================
// parseDocument — NOK preservation end-to-end. Malformed source flows through
// the chain; the Tokeniser keeps rejected bytes in `unexpected[]` and flips the
// affected leaf to error health, the AstBuilder forwards them onto the
// resulting `LoomHeading`. Container nodes stay `okHealth`. A heading with no
// specifier is NOT an error — it is named after its title.
// =============================================================================

describe('parseDocument — NOK preservation end-to-end', () => {
  it('a heading is named after its title with ok health (not an error)', () => {
    const doc = buildDocument('---\nLanguage: Scala\n---\n\n# JustATitle\n')
    const heading = doc.sections[0].heading
    expect(heading.title).toBeDefined()
    expect(heading.health.status).toBe('ok')
    expect(heading.title?.source).toBe('JustATitle')
  })

  it('specifier label with spaces — bytes preserved in unexpected[], empty value, error health', () => {
    const doc = buildDocument('---\nLanguage: Scala\n---\n\n# Heading {bad label name}\n')
    const label = doc.sections[0].heading.specifier!.label
    expect(label.value).toBe('')
    expect(label.health.status).toBe('error')
    expect(label.unexpected?.[0].value).toBe('bad label name')
  })

  it('unclosed `{` — synthetic SpecifierClose at EOL with `expected closing` diagnostic', () => {
    const doc = buildDocument('---\nLanguage: Scala\n---\n\n# Heading {Unclosed\n')
    const close = doc.sections[0].heading.specifier!.close
    expect(close.health.status).toBe('error')
    expect(close.health.diagnostics[0].message).toMatch(/expected closing/i)
  })

  it('container LoomDocument / LoomSection carry okHealth despite leaf errors', () => {
    const doc = buildDocument('---\nLanguage: Scala\n---\n\n# Section {bad label name}\n')
    expect(doc.health.status).toBe('ok')
    expect(doc.sections[0].health.status).toBe('ok')
  })

  it('malformed sections still appear structurally with full body wefts attached', () => {
    const text =
      '---\nLanguage: Scala\n---\n\n# Bad {bad label name}\n\nA preamble line.\n\n=>\n\nval x = 42\n'
    const doc = buildDocument(text)
    const section = doc.sections[0]
    expect(section).toBeDefined()
    expect(section.preamble.length).toBeGreaterThan(0)
    expect(section.code.length).toBeGreaterThan(0)
  })

  it('schema validity holds across every NOK input variant', () => {
    const malformed = [
      '# JustATitle\n',
      '# Title [Bracketed]\n',
      '# OnlyTitle {Lang}\n',
      '# Heading {bad label name}\n',
      '# Heading {Unclosed\n',
      '# Heading {Lang}{Unclosed\n',
    ]
    for (const text of malformed) {
      const doc = buildDocument(text)
      expect(Schema.is(LoomDocumentSchema)(doc)).toBe(true)
    }
  })
})
