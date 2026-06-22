import { describe, expect, it } from '@effect/vitest'
import { Effect, Stream } from 'effect'
import type { LoomDocument } from '#ast/LoomAst'
import { LoomAstBuilder } from '#ast/LoomAstBuilder'
import {
  okHealth,
  UnexpectedTokenSchema,
  type Health,
  type Position,
} from '@athrio/loom-core/LoomNode'
import {
  ArrowTokenSchema,
  HeadingStartTokenSchema,
  SpecifierCloseTokenSchema,
  SpecifierLabelTokenSchema,
  SpecifierOpenTokenSchema,
  SpecifierTokenSchema,
  TagCloseTokenSchema,
  TagLabelTokenSchema,
  TagOpenTokenSchema,
  TagTokenSchema,
  TildeTokenSchema,
  WarpAnnotationTokenSchema,
  WarpCloseTokenSchema,
  WarpNameTokenSchema,
  WarpOpenTokenSchema,
  WarpTokenSchema,
} from '#ast/LoomTokens'
import {
  ArrowWeftSchema,
  CodeWeftSchema,
  HeadingWeftSchema,
  PreambleWeftSchema,
  ProseWeftSchema,
  TildeWeftSchema,
  type LoomWeft,
} from '#ast/Weft'

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

const tagToken = (label: string, p: Position) =>
  TagTokenSchema.make({
    position: p,
    source: '',
    health: okHealth,
    open: TagOpenTokenSchema.make({
      position: p,
      source: '',
      health: okHealth,
      value: '[',
    }),
    label: TagLabelTokenSchema.make({
      type: 'TagLabel',
      position: p,
      source: '',
      health: okHealth,
      value: label,
    }),
    close: TagCloseTokenSchema.make({
      position: p,
      source: '',
      health: okHealth,
      value: ']',
    }),
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
// carries only position information, not a level field.
const mkHeading = (line: number, tag?: string, spec?: string) => {
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
    tag: tag === undefined ? undefined : tagToken(tag, p),
    specifier: spec === undefined ? undefined : specToken(spec, p),
  })
}

// mkPreamble — a plain PreambleWeft with no Warp declarations (no lang warp).
// Use `langPreamble` when you need a Document Preamble that satisfies the
// `{{lang: …}}` requirement.
const mkPreamble = (line: number) =>
  PreambleWeftSchema.make({
    position: pos(line),
    source: '',
    health: okHealth,
    warps: [],
  })

// langPreamble — a PreambleWeft whose `warps` contains a WarpToken whose
// `name.value === "lang"`. When this weft is in `document.preamble`, the
// builder's `hasLangWarp` check passes and `document.health` is `okHealth`.
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
  })
}

const mkProse = (line: number) =>
  ProseWeftSchema.make({ position: pos(line), source: '', health: okHealth })

// =============================================================================
// Empty and trivial inputs.
// =============================================================================

describe('LoomAstBuilder — empty and trivial inputs', () => {
  it('an empty stream produces an empty document: empty preamble, empty sections', () => {
    const doc = buildAst([])
    expect(doc.preamble).toEqual([])
    expect(doc.sections).toEqual([])
  })

  it("an empty document has health.status === 'warning' (no lang warp in preamble)", () => {
    const doc = buildAst([])
    expect(doc.health.status).toBe('warning')
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

  it('a heading forwards its tag and specifier onto section.heading', () => {
    const doc = buildAst([mkHeading(1, 'MySection', 'Scala')])
    const [section] = doc.sections
    expect(section.heading.tag?.label.value).toBe('MySection')
    expect(section.heading.specifier?.label.value).toBe('Scala')
  })

  it('a tagless heading produces a section whose heading.tag is undefined', () => {
    const doc = buildAst([mkHeading(1)])
    const [section] = doc.sections
    expect(section.heading.tag).toBeUndefined()
  })

  it('a second heading closes the first section and opens a new flat section', () => {
    const arrow1 = mkArrow(2)
    const arrow2 = mkArrow(4)
    const doc = buildAst([mkHeading(1, 'A'), arrow1, mkHeading(3, 'B'), arrow2])
    expect(doc.sections).toHaveLength(2)
    expect(doc.sections[0].heading.tag?.label.value).toBe('A')
    expect(doc.sections[1].heading.tag?.label.value).toBe('B')
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
    expect(doc.sections[0].heading.tag?.label.value).toBe('A')
    expect(doc.sections[1].heading.tag?.label.value).toBe('B')
    expect(doc.sections[2].heading.tag?.label.value).toBe('C')
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
    expect(doc.sections[0].heading.tag?.label.value).toBe('Alpha')
    expect(doc.sections[0].preamble).toHaveLength(1)
    expect(doc.sections[0].code).toHaveLength(1)
    expect(doc.sections[1].heading.tag?.label.value).toBe('Beta')
    expect(doc.sections[1].code).toHaveLength(1)
  })
})

// =============================================================================
// Missing-lang warning.
// =============================================================================

describe('LoomAstBuilder — missing-lang warning', () => {
  it("no lang warp in document preamble → health.status 'warning'", () => {
    const doc = buildAst([mkPreamble(1), mkHeading(2, 'Foo')])
    expect(doc.health.status).toBe('warning')
    expect(doc.health.diagnostics).toHaveLength(1)
    expect(doc.health.diagnostics[0].severity).toBe('warning')
  })

  it("a lang warp in document preamble → health.status 'ok'", () => {
    const doc = buildAst([langPreamble(1), mkHeading(2, 'Foo')])
    expect(doc.health.status).toBe('ok')
  })

  it("a lang warp only in section preamble (not document preamble) → health 'warning'", () => {
    // The lang warp must be in the DOCUMENT preamble (before the first heading).
    // A warp inside a section's preamble does not satisfy the requirement.
    const doc = buildAst([mkHeading(1, 'Foo'), langPreamble(2)])
    expect(doc.health.status).toBe('warning')
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

  it('preserves heading.tag / heading.specifier identity (Tokeniser tokens ride through unchanged)', () => {
    // The builder copies the weft's tag/specifier token references directly onto
    // LoomHeading — it does not reconstruct them. A tag token with error health
    // and empty label value (as the Tokeniser emits for a malformed label) rides
    // through to section.heading.tag unchanged.
    const tagWithError = TagTokenSchema.make({
      position: pos(1),
      source: '',
      health: errorHealth(1, 'label rejected'),
      open: TagOpenTokenSchema.make({
        position: pos(1),
        source: '',
        health: okHealth,
        value: '[',
      }),
      label: TagLabelTokenSchema.make({
        type: 'TagLabel',
        position: pos(1),
        source: '',
        health: errorHealth(1, 'label rejected'),
        value: '',
        unexpected: [
          UnexpectedTokenSchema.make({ position: pos(1), value: 'bad text' }),
        ],
      }),
      close: TagCloseTokenSchema.make({
        position: pos(1),
        source: '',
        health: okHealth,
        value: ']',
      }),
    })
    const heading = HeadingWeftSchema.make({
      ...mkHeading(1),
      tag: tagWithError,
    })
    const doc = buildAst([heading])
    const [section] = doc.sections
    expect(section.heading.tag?.health.status).toBe('error')
    expect(section.heading.tag?.label.value).toBe('')
    expect(section.heading.tag?.label.unexpected?.[0].value).toBe('bad text')
    // The section container stays ok despite the NOK heading
    expect(section.health.status).toBe('ok')
  })
})
