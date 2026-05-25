import { describe, expect, it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import type { LoomDocument } from "./LoomAst"
import { LoomAstBuilder } from "./LoomAstBuilder"
import { okHealth, UnexpectedTokenSchema, type Health, type Position } from "./LoomNode"
import {
  ArrowTokenSchema,
  ChapterHeadingStartTokenSchema,
  SectionHeadingStartTokenSchema,
  SpecifierCloseTokenSchema,
  SpecifierLabelTokenSchema,
  SpecifierOpenTokenSchema,
  SpecifierTokenSchema,
  TagCloseTokenSchema,
  TagLabelTokenSchema,
  TagOpenTokenSchema,
  TagTokenSchema,
  TildeTokenSchema,
} from "./LoomTokens"
import {
  ArrowWeftSchema,
  ChapterHeadingWeftSchema,
  CodeWeftSchema,
  PreambleWeftSchema,
  ProseWeftSchema,
  SectionHeadingWeftSchema,
  TildeWeftSchema,
  WeftSchema,
  type LoomWeft,
} from "./Weft"

// =============================================================================
// LoomAstBuilder — unit tests against synthetic weft streams.
//
// The builder is the AST-pipeline stage that turns a `Stream<LoomWeft>` into
// a `LoomDocument`. These tests bypass the Classifier/Tokeniser and feed
// builder-shaped wefts directly via `Stream.fromIterable`, asserting the
// resulting tree shape: which weft kind ends up where, how heading wefts
// open/close containers, and how positions and health are derived.
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

const tagToken = (label: string, p: Position) =>
  TagTokenSchema.make({
    position: p,
    health: okHealth,
    open: TagOpenTokenSchema.make({ position: p, health: okHealth, value: "[" }),
    label: TagLabelTokenSchema.make({
      type: "TagLabel",
      position: p,
      health: okHealth,
      value: label,
    }),
    close: TagCloseTokenSchema.make({
      position: p,
      health: okHealth,
      value: "]",
    }),
  })

const specToken = (label: string, p: Position) =>
  SpecifierTokenSchema.make({
    position: p,
    health: okHealth,
    open: SpecifierOpenTokenSchema.make({
      position: p,
      health: okHealth,
      value: "{",
    }),
    label: SpecifierLabelTokenSchema.make({
      type: "SpecifierLabel",
      position: p,
      health: okHealth,
      value: label,
    }),
    close: SpecifierCloseTokenSchema.make({
      position: p,
      health: okHealth,
      value: "}",
    }),
  })

const mkWeft = (line: number) =>
  WeftSchema.make({ position: pos(line), health: okHealth })

const mkChapter = (line: number, tag: string, spec: string) => {
  const p = pos(line)
  // ChapterHeadingWeftSchema is a filtered schema (requires tag + specifier);
  // filtered .make() needs an explicit `type` field, since the underlying
  // struct's `withConstructorDefault` doesn't run through the refinement.
  return ChapterHeadingWeftSchema.make({
    type: "ChapterHeadingWeft",
    position: p,
    health: okHealth,
    headingStart: ChapterHeadingStartTokenSchema.make({
      position: p,
      health: okHealth,
    }),
    texts: [],
    tag: tagToken(tag, p),
    specifier: specToken(spec, p),
  })
}

const mkSection = (line: number, tag?: string, spec?: string) => {
  const p = pos(line)
  return SectionHeadingWeftSchema.make({
    position: p,
    health: okHealth,
    headingStart: SectionHeadingStartTokenSchema.make({
      position: p,
      health: okHealth,
    }),
    texts: [],
    tag: tag === undefined ? undefined : tagToken(tag, p),
    specifier: spec === undefined ? undefined : specToken(spec, p),
  })
}

const mkPreamble = (line: number) =>
  PreambleWeftSchema.make({
    position: pos(line),
    health: okHealth,
    warps: [],
  })

const mkArrow = (line: number) => {
  const p = pos(line)
  return ArrowWeftSchema.make({
    position: p,
    health: okHealth,
    arrow: ArrowTokenSchema.make({ position: p, health: okHealth }),
    anchors: [],
  })
}

const mkCode = (line: number) =>
  CodeWeftSchema.make({
    position: pos(line),
    health: okHealth,
    anchors: [],
  })

const mkTilde = (line: number) => {
  const p = pos(line)
  return TildeWeftSchema.make({
    position: p,
    health: okHealth,
    tilde: TildeTokenSchema.make({ position: p, health: okHealth }),
  })
}

const mkProse = (line: number) =>
  ProseWeftSchema.make({ position: pos(line), health: okHealth })

// =============================================================================
// Empty and trivial inputs.
// =============================================================================

describe("LoomAstBuilder — empty and trivial inputs", () => {
  it("an empty stream produces an empty document, all three slots empty", () => {
    const doc = buildAst([])
    expect(doc.wefts).toEqual([])
    expect(doc.sections).toEqual([])
    expect(doc.chapters).toEqual([])
  })

  it("a single Weft (orphan kind) lands on `document.wefts`", () => {
    const w = mkWeft(1)
    const doc = buildAst([w])
    expect(doc.wefts).toHaveLength(1)
    expect(doc.wefts[0]).toEqual(w)
    expect(doc.sections).toEqual([])
    expect(doc.chapters).toEqual([])
  })

  it("multiple consecutive Wefts accumulate in `document.wefts` in source order", () => {
    const a = mkWeft(1)
    const b = mkWeft(2)
    const c = mkWeft(3)
    const doc = buildAst([a, b, c])
    expect(doc.wefts).toEqual([a, b, c])
  })
})

// =============================================================================
// Chapter — opening, body wefts, child sections, closing.
// =============================================================================

describe("LoomAstBuilder — chapters", () => {
  it("a lone chapter heading produces one Chapter with empty body and no children", () => {
    const doc = buildAst([mkChapter(1, "Foo", "Lang")])
    expect(doc.chapters).toHaveLength(1)
    const [chapter] = doc.chapters
    expect(chapter.preamble).toEqual([])
    expect(chapter.code).toEqual([])
    expect(chapter.children).toEqual([])
  })

  it("PreambleWeft after a chapter heading lands on `chapter.preamble`", () => {
    const doc = buildAst([
      mkChapter(1, "Foo", "Lang"),
      mkPreamble(2),
      mkPreamble(3),
    ])
    const [chapter] = doc.chapters
    expect(chapter.preamble).toHaveLength(2)
  })

  it("body wefts (Arrow/Code/Tilde/Prose) after a chapter heading land on `chapter.code` in order", () => {
    const arrow = mkArrow(2)
    const code = mkCode(3)
    const tilde = mkTilde(4)
    const prose = mkProse(5)
    const doc = buildAst([
      mkChapter(1, "Foo", "Lang"),
      arrow,
      code,
      tilde,
      prose,
    ])
    const [chapter] = doc.chapters
    expect(chapter.code).toEqual([arrow, code, tilde, prose])
  })

  it("a heading propagates its tag and specifier into `chapter.heading`", () => {
    const doc = buildAst([mkChapter(1, "MyChapter", "Scala")])
    const [chapter] = doc.chapters
    expect(chapter.heading.tag?.label.value).toBe("MyChapter")
    expect(chapter.heading.specifier?.label.value).toBe("Scala")
  })

  it("a second chapter heading closes the previous chapter and opens a new one", () => {
    const doc = buildAst([
      mkChapter(1, "A", "X"),
      mkArrow(2),
      mkChapter(3, "B", "Y"),
      mkArrow(4),
    ])
    expect(doc.chapters).toHaveLength(2)
    expect(doc.chapters[0].heading.tag?.label.value).toBe("A")
    expect(doc.chapters[1].heading.tag?.label.value).toBe("B")
    expect(doc.chapters[0].code).toHaveLength(1)
    expect(doc.chapters[1].code).toHaveLength(1)
  })
})

// =============================================================================
// Sections under a chapter.
// =============================================================================

describe("LoomAstBuilder — sections under a chapter", () => {
  it("a section heading after a chapter heading opens a child Section", () => {
    const doc = buildAst([
      mkChapter(1, "Foo", "Lang"),
      mkSection(2, "Bar"),
    ])
    const [chapter] = doc.chapters
    expect(chapter.children).toHaveLength(1)
    expect(chapter.children[0].heading.tag?.label.value).toBe("Bar")
  })

  it("body wefts after a section heading flow into the section, not the chapter", () => {
    const doc = buildAst([
      mkChapter(1, "Foo", "Lang"),
      mkSection(2, "Bar"),
      mkPreamble(3),
      mkArrow(4),
      mkCode(5),
    ])
    const [chapter] = doc.chapters
    expect(chapter.preamble).toEqual([])
    expect(chapter.code).toEqual([])
    expect(chapter.children[0].preamble).toHaveLength(1)
    expect(chapter.children[0].code).toHaveLength(2)
  })

  it("a chapter can carry its own preamble before a section heading appears", () => {
    const doc = buildAst([
      mkChapter(1, "Foo", "Lang"),
      mkPreamble(2),
      mkSection(3, "Bar"),
      mkPreamble(4),
    ])
    const [chapter] = doc.chapters
    expect(chapter.preamble).toHaveLength(1)
    expect(chapter.children[0].preamble).toHaveLength(1)
  })

  it("a second section heading closes the previous section into `chapter.children`", () => {
    const doc = buildAst([
      mkChapter(1, "Foo", "Lang"),
      mkSection(2, "A"),
      mkArrow(3),
      mkSection(4, "B"),
      mkArrow(5),
    ])
    const [chapter] = doc.chapters
    expect(chapter.children).toHaveLength(2)
    expect(chapter.children[0].heading.tag?.label.value).toBe("A")
    expect(chapter.children[1].heading.tag?.label.value).toBe("B")
    expect(chapter.children[0].code).toHaveLength(1)
    expect(chapter.children[1].code).toHaveLength(1)
  })

  it("a new chapter heading closes both the open section and the open chapter", () => {
    const doc = buildAst([
      mkChapter(1, "Outer", "X"),
      mkSection(2, "S"),
      mkArrow(3),
      mkChapter(4, "Next", "Y"),
    ])
    expect(doc.chapters).toHaveLength(2)
    expect(doc.chapters[0].children).toHaveLength(1)
    expect(doc.chapters[1].children).toEqual([])
  })
})

// =============================================================================
// Orphan content — no parent chapter.
// =============================================================================

describe("LoomAstBuilder — orphan content", () => {
  it("a section heading before any chapter lands on `document.sections`", () => {
    const doc = buildAst([mkSection(1, "Notes")])
    expect(doc.chapters).toEqual([])
    expect(doc.sections).toHaveLength(1)
    expect(doc.sections[0].heading.tag?.label.value).toBe("Notes")
  })

  it("body wefts under an orphan section flow into that section", () => {
    const doc = buildAst([
      mkSection(1, "Notes"),
      mkPreamble(2),
      mkArrow(3),
      mkCode(4),
    ])
    expect(doc.sections).toHaveLength(1)
    expect(doc.sections[0].preamble).toHaveLength(1)
    expect(doc.sections[0].code).toHaveLength(2)
  })

  it("two consecutive orphan section headings both land on `document.sections`", () => {
    const doc = buildAst([
      mkSection(1, "A"),
      mkArrow(2),
      mkSection(3, "B"),
      mkArrow(4),
    ])
    expect(doc.sections).toHaveLength(2)
    expect(doc.sections[0].code).toHaveLength(1)
    expect(doc.sections[1].code).toHaveLength(1)
  })

  it("orphan Wefts, orphan Section, and a Chapter coexist in their respective slots", () => {
    const doc = buildAst([
      mkWeft(1),
      mkWeft(2),
      mkSection(3, "Notes"),
      mkPreamble(4),
      mkChapter(5, "Foo", "Lang"),
      mkPreamble(6),
      mkSection(7, "Bar"),
      mkArrow(8),
    ])
    expect(doc.wefts).toHaveLength(2)
    expect(doc.sections).toHaveLength(1)
    expect(doc.sections[0].preamble).toHaveLength(1)
    expect(doc.chapters).toHaveLength(1)
    expect(doc.chapters[0].preamble).toHaveLength(1)
    expect(doc.chapters[0].children).toHaveLength(1)
    expect(doc.chapters[0].children[0].code).toHaveLength(1)
  })

  it("a chapter following an orphan section closes the section first", () => {
    const doc = buildAst([
      mkSection(1, "Orphan"),
      mkArrow(2),
      mkChapter(3, "Foo", "Lang"),
    ])
    expect(doc.sections).toHaveLength(1)
    expect(doc.sections[0].code).toHaveLength(1)
    expect(doc.chapters).toHaveLength(1)
  })
})

// =============================================================================
// Position derivation — the span runs from heading start to last constituent.
// =============================================================================

describe("LoomAstBuilder — position spans", () => {
  it("a Section spans from its heading to its last body weft", () => {
    const arrow = mkArrow(3)
    const doc = buildAst([
      mkChapter(1, "Foo", "Lang"),
      mkSection(2, "S"),
      arrow,
    ])
    const section = doc.chapters[0].children[0]
    expect(section.position.start.offset).toBe(pos(2).start.offset)
    expect(section.position.end.offset).toBe(arrow.position.end.offset)
  })

  it("a Section with only a heading spans the heading alone", () => {
    const doc = buildAst([
      mkChapter(1, "Foo", "Lang"),
      mkSection(2, "S"),
    ])
    const section = doc.chapters[0].children[0]
    expect(section.position.start.offset).toBe(pos(2).start.offset)
    expect(section.position.end.offset).toBe(pos(2).end.offset)
  })

  it("a Chapter spans through its last child Section's last weft", () => {
    const lastWeft = mkCode(7)
    const doc = buildAst([
      mkChapter(1, "Foo", "Lang"),
      mkPreamble(2),
      mkSection(3, "S"),
      mkArrow(4),
      lastWeft,
    ])
    const [chapter] = doc.chapters
    expect(chapter.position.end.offset).toBe(lastWeft.position.end.offset)
  })

  it("a Chapter without children spans through its last body weft", () => {
    const lastCode = mkCode(5)
    const doc = buildAst([
      mkChapter(1, "Foo", "Lang"),
      mkPreamble(2),
      lastCode,
    ])
    expect(doc.chapters[0].position.end.offset).toBe(lastCode.position.end.offset)
  })

  it("an empty document has position {0,0} at line 1", () => {
    const doc = buildAst([])
    expect(doc.position.start).toEqual({ line: 1, offset: 0 })
    expect(doc.position.end).toEqual({ line: 1, offset: 0 })
  })

  it("a non-empty document spans from its first constituent to its last", () => {
    const w = mkWeft(1)
    const last = mkCode(5)
    const doc = buildAst([
      w,
      mkChapter(3, "Foo", "Lang"),
      mkPreamble(4),
      last,
    ])
    expect(doc.position.start.offset).toBe(w.position.start.offset)
    expect(doc.position.end.offset).toBe(last.position.end.offset)
  })
})

// =============================================================================
// Container health — okHealth on every container; diagnostics live on
// contained leaves and ride with them untouched.
// =============================================================================

describe("LoomAstBuilder — container health", () => {
  it("the document carries okHealth on any input", () => {
    expect(buildAst([]).health.status).toBe("ok")
    expect(buildAst([mkChapter(1, "Foo", "Lang")]).health.status).toBe("ok")
  })

  it("chapters and sections carry okHealth", () => {
    const doc = buildAst([
      mkChapter(1, "Foo", "Lang"),
      mkSection(2, "S"),
      mkArrow(3),
    ])
    expect(doc.chapters[0].health.status).toBe("ok")
    expect(doc.chapters[0].children[0].health.status).toBe("ok")
  })
})

// =============================================================================
// NOK preservation — the builder receives wefts whose `health` and
// `unexpected[]` carry the Tokeniser's diagnostic findings. Its job at the
// container layer is to forward those leaves unchanged onto the resulting
// LoomHeading. Container nodes (LoomSection / LoomChapter / LoomDocument)
// stay `okHealth` regardless; consumers read leaf health to find problems.
// =============================================================================

const errorHealth = (line: number, message: string): Health => ({
  status: "error",
  diagnostics: [{ message, position: pos(line), severity: "error" }],
})

describe("LoomAstBuilder — NOK preservation", () => {
  it("forwards section weft.health onto LoomSection.heading.health", () => {
    const errored = SectionHeadingWeftSchema.make({
      ...mkSection(2, "Bar"),
      health: errorHealth(2, "synthetic diagnostic"),
    })
    const doc = buildAst([mkChapter(1, "C", "L"), errored])
    const section = doc.chapters[0].children[0]
    expect(section.heading.health.status).toBe("error")
    expect(section.heading.health.diagnostics[0].message).toBe("synthetic diagnostic")
  })

  it("forwards section weft.unexpected onto LoomSection.heading.unexpected", () => {
    const stray = UnexpectedTokenSchema.make({ position: pos(2), value: "]]" })
    const errored = SectionHeadingWeftSchema.make({
      ...mkSection(2, "Bar"),
      unexpected: [stray],
    })
    const doc = buildAst([mkChapter(1, "C", "L"), errored])
    const section = doc.chapters[0].children[0]
    expect(section.heading.unexpected).toBeDefined()
    expect(section.heading.unexpected?.[0].value).toBe("]]")
  })

  it("LoomSection container stays okHealth even when its heading is error", () => {
    const errored = SectionHeadingWeftSchema.make({
      ...mkSection(2, "Bar"),
      health: errorHealth(2, "synthetic"),
    })
    const doc = buildAst([mkChapter(1, "C", "L"), errored])
    expect(doc.chapters[0].children[0].health.status).toBe("ok")
  })

  it("forwards chapter weft.health onto LoomChapter.heading.health", () => {
    const errored = ChapterHeadingWeftSchema.make({
      ...mkChapter(1, "C", "L"),
      health: errorHealth(1, "synthetic chapter error"),
    })
    const doc = buildAst([errored])
    expect(doc.chapters[0].heading.health.status).toBe("error")
    expect(doc.chapters[0].heading.health.diagnostics[0].message).toBe(
      "synthetic chapter error",
    )
  })

  it("LoomChapter and LoomDocument containers stay okHealth despite chapter heading error", () => {
    const errored = ChapterHeadingWeftSchema.make({
      ...mkChapter(1, "C", "L"),
      health: errorHealth(1, "synthetic"),
    })
    const doc = buildAst([errored])
    expect(doc.chapters[0].health.status).toBe("ok")
    expect(doc.health.status).toBe("ok")
  })

  it("preserves heading.tag / heading.specifier identity (the Tokeniser's tokens ride through)", () => {
    // Builder doesn't reconstruct tag/specifier — it copies the weft's token
    // references onto LoomHeading. So mutating the value in the weft propagates
    // directly to the heading.
    const tagWithError = TagTokenSchema.make({
      position: pos(2),
      health: errorHealth(2, "label rejected"),
      open: TagOpenTokenSchema.make({ position: pos(2), health: okHealth, value: "[" }),
      label: TagLabelTokenSchema.make({
        type: "TagLabel",
        position: pos(2),
        health: errorHealth(2, "label rejected"),
        value: "",
        unexpected: [UnexpectedTokenSchema.make({ position: pos(2), value: "bad text" })],
      }),
      close: TagCloseTokenSchema.make({ position: pos(2), health: okHealth, value: "]" }),
    })
    const heading = SectionHeadingWeftSchema.make({
      ...mkSection(2),
      tag: tagWithError,
    })
    const doc = buildAst([mkChapter(1, "C", "L"), heading])
    const section = doc.chapters[0].children[0]
    expect(section.heading.tag?.health.status).toBe("error")
    expect(section.heading.tag?.label.value).toBe("")
    expect(section.heading.tag?.label.unexpected?.[0].value).toBe("bad text")
  })
})
