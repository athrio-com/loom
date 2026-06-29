import { describe, expect, it } from '@effect/vitest'
import { Effect, Stream } from 'effect'
import type { LoomDocument } from '@athrio/loom-ast/LoomAst'
import { LoomAstBuilder } from '#ast/LoomAstBuilder'
import {
  okHealth,
  UnexpectedTokenSchema,
  type Health,
  type Position,
} from '@athrio/loom-ast/LoomNode'
import {
  ArrowTokenSchema,
  HeadingStartTokenSchema,
  SpecifierCloseTokenSchema,
  HeadingTitleTokenSchema,
  SpecifierLabelTokenSchema,
  SpecifierOpenTokenSchema,
  SpecifierTokenSchema,
  TildeTokenSchema,
  WarpAnnotationTokenSchema,
  WarpCloseTokenSchema,
  WarpNameTokenSchema,
  WarpOpenTokenSchema,
  WarpTokenSchema,
} from '@athrio/loom-ast/LoomTokens'
import {
  ArrowWeftSchema,
  CodeWeftSchema,
  HeadingWeftSchema,
  PreambleWeftSchema,
  ProseWeftSchema,
  TildeWeftSchema,
  type LoomWeft,
} from '@athrio/loom-ast/Weft'

// =============================================================================
// LoomAstBuilder — unit tests against synthetic weft streams.
//
// The builder is the AST-pipeline stage that turns a `Stream<LoomWeft>` into
// a `LoomDocument`. These tests bypass the Classifier/Tokeniser and feed
// builder-shaped wefts directly via `Stream.fromIterable`, asserting the
// resulting tree shape.
//
// The FLAT model: every HeadingWeft opens a LoomSection appended to
// `document.sections`. There is no chapter tier. LoomDocument has exactly
// two slots: `preamble: PreambleWeft[]` and `sections: LoomSection[]`.
// Pre-heading PreambleWefts go to `document.preamble`; PreambleWefts after
// a heading go to the open section's `preamble`; body wefts (Arrow/Code/
// Tilde/Prose) go to the open section's `code`.
//
// The corresponding end-to-end coverage (real source → Classifier →
// Tokeniser → AstBuilder) lives in Loom.integration.test.ts.
// =============================================================================

// =============================================================================
// Harness — run the Service against a synthetic stream and return the
// document. Builder never fails, so `runSync` is fine.
// =============================================================================

const buildAst = (wefts: ReadonlyArray<LoomWeft>): LoomDocument =>
  Effect.runSync(
    Effect.gen(function* () {
      const builder = yield* LoomAstBuilder
      return yield* builder.build(Stream.fromIterable(wefts))
    }).pipe(Effect.provide(LoomAstBuilder.Default)),
  )

// =============================================================================
// Weft factories — each helper produces a schema-valid weft. Positions are
// derived from `line` so different wefts have non-overlapping offsets and
// position-span assertions stay readable.
// =============================================================================

const pos = (line: number): Position => ({
  start: { line, offset: line * 100 },
  end: { line, offset: line * 100 + 10 },
})

// Synthetic test fixtures don't correspond to real source text — positions
// are computed from line numbers. Every constructed node carries `source: ""`
// since there are no bytes to slice.

const titleToken = (title: string, p: Position) =>
  HeadingTitleTokenSchema.make({
    type: 'HeadingTitle',
    position: p,
    source: title,
    health: okHealth,
  })

const specToken = (label: string, p: Position) =>
  SpecifierTokenSchema.make({
    position: p,
    source: '',
    health: okHealth,
    open: SpecifierOpenTokenSchema.make({
      position: p,
      source: '',
      health: okHealth,
      value: '{',
    }),
    label: SpecifierLabelTokenSchema.make({
      type: 'SpecifierLabel',
      position: p,
      source: '',
      health: okHealth,
      value: label,
    }),
    close: SpecifierCloseTokenSchema.make({
      position: p,
      source: '',
      health: okHealth,
      value: '}',
    }),
  })

// mkHeading — builds a HeadingWeft using the unified HeadingWeftSchema
// (there is no longer a separate Chapter/Section heading schema). Any heading
// level can be expressed by adjusting the position; the HeadingStart token
// carries only position information, not a level field. A section is named by
// its title — the second argument becomes the HeadingTitle token's `source`.
const mkHeading = (line: number, title?: string, spec?: string) => {
  const p = pos(line)
  return HeadingWeftSchema.make({
    position: p,
    source: '',
    health: okHealth,
    headingStart: HeadingStartTokenSchema.make({
      position: p,
      source: '',
      health: okHealth,
    }),
    title: title === undefined ? undefined : titleToken(title, p),
    specifier: spec === undefined ? undefined : specToken(spec, p),
  })
}

// mkPreamble — a plain PreambleWeft with no Warp declarations (no lang warp).
// Use `langPreamble` when you need a Document Preamble that carries a lang warp.
// Document health is okHealth either way; the lang warp is no longer required.
const mkPreamble = (line: number) =>
  PreambleWeftSchema.make({
    position: pos(line),
    source: '',
    health: okHealth,
    warps: [],
    anchors: [],
  })

// langPreamble — a PreambleWeft whose `warps` contains a WarpToken whose
// `name.value === "lang"`. The lang warp no longer affects document health;
// this factory exists so a fixture can carry a lang warp when it needs one.
const langPreamble = (line: number) => {
  const p = pos(line)
  return PreambleWeftSchema.make({
    position: p,
    source: '',
    health: okHealth,
    warps: [
      WarpTokenSchema.make({
        position: p,
        source: '',
        health: okHealth,
        open: WarpOpenTokenSchema.make({
          position: p,
          source: '',
          health: okHealth,
          value: '{{',
        }),
        name: WarpNameTokenSchema.make({
          type: 'WarpName',
          position: p,
          source: '',
          health: okHealth,
          value: 'lang',
        }),
        annotation: WarpAnnotationTokenSchema.make({
          type: 'WarpAnnotation',
          position: p,
          source: '',
          health: okHealth,
          value: 'Scala',
        }),
        close: WarpCloseTokenSchema.make({
          position: p,
          source: '',
          health: okHealth,
          value: '}}',
        }),
      }),
    ],
    anchors: [],
  })
}

const mkArrow = (line: number) => {
  const p = pos(line)
  return ArrowWeftSchema.make({
    position: p,
    source: '',
    health: okHealth,
    arrow: ArrowTokenSchema.make({ position: p, source: '', health: okHealth }),
    anchors: [],
  })
}

const mkCode = (line: number) =>
  CodeWeftSchema.make({
    position: pos(line),
    source: '',
    health: okHealth,
    anchors: [],
  })

const mkTilde = (line: number) => {
  const p = pos(line)
  return TildeWeftSchema.make({
    position: p,
    source: '',
    health: okHealth,
    tilde: TildeTokenSchema.make({ position: p, source: '', health: okHealth }),
    anchors: [],
  })
}

const mkProse = (line: number) =>
  ProseWeftSchema.make({
    position: pos(line),
    source: '',
    health: okHealth,
    anchors: [],
  })

// =============================================================================
// Empty and trivial inputs.
// =============================================================================

describe('LoomAstBuilder — empty and trivial inputs', () => {
  it('an empty stream produces an empty document: empty preamble, empty sections', () => {
    const doc = buildAst([])
    expect(doc.preamble).toEqual([])
    expect(doc.sections).toEqual([])
  })

  it("an empty document has health.status === 'ok' (the lang warp is no longer required)", () => {
    const doc = buildAst([])
    expect(doc.health.status).toBe('ok')
    expect(doc.health.diagnostics).toEqual([])
  })

  it('an empty document has position {1,0}..{1,0}', () => {
    const doc = buildAst([])
    expect(doc.position.start).toEqual({ line: 1, offset: 0 })
    expect(doc.position.end).toEqual({ line: 1, offset: 0 })
  })
})

// =============================================================================
// Document Preamble — PreambleWefts before the first heading.
// =============================================================================

describe('LoomAstBuilder — document preamble', () => {
  it('PreambleWefts before the first heading accumulate on document.preamble in source order', () => {
    const a = mkPreamble(1)
    const b = mkPreamble(2)
    const c = mkPreamble(3)
    const doc = buildAst([a, b, c])
    expect(doc.preamble).toEqual([a, b, c])
    expect(doc.sections).toEqual([])
  })

  it("a lang-warp PreambleWeft in the document preamble → health 'ok'", () => {
    const doc = buildAst([langPreamble(1)])
    expect(doc.health.status).toBe('ok')
  })

  it('PreambleWefts before the first heading do NOT start a section', () => {
    const doc = buildAst([mkPreamble(1), mkPreamble(2)])
    expect(doc.sections).toHaveLength(0)
  })
})

// =============================================================================
// Flat sections — every HeadingWeft opens a new LoomSection.
// =============================================================================

describe('LoomAstBuilder — flat sections', () => {
  it('a lone heading produces exactly one flat LoomSection with empty preamble and empty code', () => {
    const doc = buildAst([mkHeading(1, 'Foo')])
    expect(doc.sections).toHaveLength(1)
    const [section] = doc.sections
    expect(section.preamble).toEqual([])
    expect(section.code).toEqual([])
  })

  it("PreambleWeft after a heading lands on the open section's preamble, not document.preamble", () => {
    const doc = buildAst([mkHeading(1, 'Foo'), mkPreamble(2), mkPreamble(3)])
    expect(doc.preamble).toHaveLength(0)
    const [section] = doc.sections
    expect(section.preamble).toHaveLength(2)
  })

  it('body wefts (Arrow/Code/Tilde/Prose) after a heading land on section.code in order', () => {
    const arrow = mkArrow(2)
    const code = mkCode(3)
    const tilde = mkTilde(4)
    const prose = mkProse(5)
    const doc = buildAst([mkHeading(1, 'Foo'), arrow, code, tilde, prose])
    const [section] = doc.sections
    expect(section.code).toEqual([arrow, code, tilde, prose])
  })

  it('a heading forwards its title and specifier onto section.heading', () => {
    const doc = buildAst([mkHeading(1, 'MySection', 'Scala')])
    const [section] = doc.sections
    expect(section.heading.title?.source).toBe('MySection')
    expect(section.heading.specifier?.label.value).toBe('Scala')
  })

  it('a second heading closes the first section and opens a new flat section', () => {
    const arrow1 = mkArrow(2)
    const arrow2 = mkArrow(4)
    const doc = buildAst([mkHeading(1, 'A'), arrow1, mkHeading(3, 'B'), arrow2])
    expect(doc.sections).toHaveLength(2)
    expect(doc.sections[0].heading.title?.source).toBe('A')
    expect(doc.sections[1].heading.title?.source).toBe('B')
    expect(doc.sections[0].code).toEqual([arrow1])
    expect(doc.sections[1].code).toEqual([arrow2])
  })

  it('any number of headings produce that many flat sections (no nesting)', () => {
    const doc = buildAst([
      mkHeading(1, 'A'),
      mkHeading(2, 'B'),
      mkHeading(3, 'C'),
    ])
    expect(doc.sections).toHaveLength(3)
    expect(doc.sections[0].heading.title?.source).toBe('A')
    expect(doc.sections[1].heading.title?.source).toBe('B')
    expect(doc.sections[2].heading.title?.source).toBe('C')
  })
})

// =============================================================================
// Mixed document — pre-heading preamble + multiple flat sections.
// =============================================================================

describe('LoomAstBuilder — mixed document', () => {
  it('pre-heading preamble (with lang) + several headings: preamble populated, sections flat, health ok', () => {
    const doc = buildAst([
      langPreamble(1),
      mkHeading(2, 'Alpha'),
      mkPreamble(3),
      mkArrow(4),
      mkHeading(5, 'Beta'),
      mkCode(6),
    ])
    expect(doc.health.status).toBe('ok')
    expect(doc.preamble).toHaveLength(1)
    expect(doc.sections).toHaveLength(2)
    expect(doc.sections[0].heading.title?.source).toBe('Alpha')
    expect(doc.sections[0].preamble).toHaveLength(1)
    expect(doc.sections[0].code).toHaveLength(1)
    expect(doc.sections[1].heading.title?.source).toBe('Beta')
    expect(doc.sections[1].code).toHaveLength(1)
  })
})

// =============================================================================
// Lang warp is optional — document health no longer depends on it.
//
// The missing-lang warning has been removed: there is no MissingLanguageWarp
// fault, and makeDocument always sets okHealth. A document is healthy whether
// the lang warp is absent, in the document preamble, or only in a section
// preamble; the lang warp's presence and placement no longer affect health.
// =============================================================================

describe('LoomAstBuilder — lang warp is optional (no missing-lang warning)', () => {
  it("a document without a lang warp still has health 'ok'", () => {
    const doc = buildAst([mkPreamble(1), mkHeading(2, 'Foo')])
    expect(doc.health.status).toBe('ok')
    expect(doc.health.diagnostics).toEqual([])
  })

  it("a lang warp in the document preamble keeps health 'ok'", () => {
    const doc = buildAst([langPreamble(1), mkHeading(2, 'Foo')])
    expect(doc.health.status).toBe('ok')
  })

  it("a lang warp only in a section preamble also keeps health 'ok'", () => {
    // Placement no longer matters: a warp inside a section's preamble (not the
    // document preamble) is just as fine as none at all.
    const doc = buildAst([mkHeading(1, 'Foo'), langPreamble(2)])
    expect(doc.health.status).toBe('ok')
  })
})

// =============================================================================
// Position spans.
// =============================================================================

describe('LoomAstBuilder — position spans', () => {
  it('a Section with only a heading spans the heading alone', () => {
    const doc = buildAst([mkHeading(2, 'S')])
    const [section] = doc.sections
    expect(section.position.start.offset).toBe(pos(2).start.offset)
    expect(section.position.end.offset).toBe(pos(2).end.offset)
  })

  it('a Section spans from its heading to its last body weft', () => {
    const arrow = mkArrow(3)
    const doc = buildAst([mkHeading(2, 'S'), arrow])
    const [section] = doc.sections
    expect(section.position.start.offset).toBe(pos(2).start.offset)
    expect(section.position.end.offset).toBe(arrow.position.end.offset)
  })

  it('a Section span includes preamble wefts and body wefts; end is the last element', () => {
    const lastCode = mkCode(5)
    const doc = buildAst([
      mkHeading(2, 'S'),
      mkPreamble(3),
      mkArrow(4),
      lastCode,
    ])
    const [section] = doc.sections
    expect(section.position.start.offset).toBe(pos(2).start.offset)
    expect(section.position.end.offset).toBe(lastCode.position.end.offset)
  })

  it('an empty document has position {1,0}..{1,0}', () => {
    const doc = buildAst([])
    expect(doc.position.start).toEqual({ line: 1, offset: 0 })
    expect(doc.position.end).toEqual({ line: 1, offset: 0 })
  })

  it('a non-empty document spans from its first constituent to its last', () => {
    const first = langPreamble(1)
    const last = mkCode(5)
    const doc = buildAst([first, mkHeading(3, 'Foo'), mkPreamble(4), last])
    expect(doc.position.start.offset).toBe(first.position.start.offset)
    expect(doc.position.end.offset).toBe(last.position.end.offset)
  })

  it('a document with only pre-heading preambles spans the preamble wefts', () => {
    const first = langPreamble(1)
    const last = mkPreamble(3)
    const doc = buildAst([first, last])
    expect(doc.position.start.offset).toBe(first.position.start.offset)
    expect(doc.position.end.offset).toBe(last.position.end.offset)
  })
})

// =============================================================================
// Container health — okHealth on every container; diagnostics live on
// contained leaves and ride with them untouched.
// =============================================================================

describe('LoomAstBuilder — container health', () => {
  it('sections always carry okHealth (even when their heading carries error health)', () => {
    const doc = buildAst([mkHeading(1, 'Foo'), mkHeading(2, 'Bar')])
    for (const section of doc.sections) {
      expect(section.health.status).toBe('ok')
    }
  })
})

// =============================================================================
// NOK preservation — the builder receives wefts whose `health` and
// `unexpected[]` carry the Tokeniser's diagnostic findings. Its job at the
// container layer is to forward those leaves unchanged onto the resulting
// LoomHeading. Container nodes (LoomSection / LoomDocument) stay `okHealth`
// regardless; consumers read leaf health to find problems.
// =============================================================================

const errorHealth = (line: number, message: string): Health => ({
  status: 'error',
  diagnostics: [{ message, position: pos(line), severity: 'error' }],
})

describe('LoomAstBuilder — NOK preservation', () => {
  it('forwards weft.health onto section.heading.health', () => {
    const errored = HeadingWeftSchema.make({
      ...mkHeading(1, 'Bar'),
      health: errorHealth(1, 'synthetic diagnostic'),
    })
    const doc = buildAst([errored])
    const [section] = doc.sections
    expect(section.heading.health.status).toBe('error')
    expect(section.heading.health.diagnostics[0].message).toBe(
      'synthetic diagnostic',
    )
  })

  it('forwards weft.unexpected onto section.heading.unexpected', () => {
    const stray = UnexpectedTokenSchema.make({ position: pos(1), value: ']]' })
    const errored = HeadingWeftSchema.make({
      ...mkHeading(1, 'Bar'),
      unexpected: [stray],
    })
    const doc = buildAst([errored])
    const [section] = doc.sections
    expect(section.heading.unexpected).toBeDefined()
    expect(section.heading.unexpected?.[0].value).toBe(']]')
  })

  it('LoomSection container stays okHealth even when its heading is error', () => {
    const errored = HeadingWeftSchema.make({
      ...mkHeading(1, 'Bar'),
      health: errorHealth(1, 'synthetic'),
    })
    const doc = buildAst([errored])
    expect(doc.sections[0].health.status).toBe('ok')
  })
})
