import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"
import {
  LoomDocumentSchema,
  LoomHeadingSchema,
  LoomSectionSchema,
} from "#ast/LoomAst"
import { okHealth, type Position } from "#ast/LoomNode"

const pos: Position = {
  start: { line: 1, column: 1, offset: 0 },
  end: { line: 1, column: 4, offset: 3 },
}

const headingStart = {
  type: "HeadingStart" as const,
  position: pos,
  health: okHealth,
}

const text = (offsetStart: number, offsetEnd: number) => ({
  type: "Text" as const,
  position: {
    start: { line: 1, column: offsetStart + 1, offset: offsetStart },
    end: { line: 1, column: offsetEnd + 1, offset: offsetEnd },
  },
  health: okHealth,
})

const tag = (label: string) => ({
  type: "Tag" as const,
  position: pos,
  health: okHealth,
  open: { type: "TagOpen" as const, value: "[" as const, position: pos, health: okHealth },
  label: { type: "TagLabel" as const, value: label, position: pos, health: okHealth },
  close: { type: "TagClose" as const, value: "]" as const, position: pos, health: okHealth },
})

const specifier = (label: string) => ({
  type: "Specifier" as const,
  position: pos,
  health: okHealth,
  open: { type: "SpecifierOpen" as const, value: "{" as const, position: pos, health: okHealth },
  label: { type: "SpecifierLabel" as const, value: label, position: pos, health: okHealth },
  close: { type: "SpecifierClose" as const, value: "}" as const, position: pos, health: okHealth },
})

// =============================================================================
// LoomHeading — one shape for every heading level.
//
// `headingStart` is the single heading-start token (HeadingStartTokenSchema).
// `texts` is an array of TextTokens; it must always be an array.
// `tag` and `specifier` are both optional.
// =============================================================================

describe("LoomHeading.headingStart", () => {
  it("accepts a heading built with headingStart field", () => {
    expect(
      Schema.is(LoomHeadingSchema)({
        type: "LoomHeading",
        position: pos,
        health: okHealth,
        headingStart,
        texts: [],
        tag: tag("Loom"),
        specifier: specifier("Loom"),
      }),
    ).toBe(true)
  })

  it("rejects a heading whose headingStart has the wrong type discriminator", () => {
    expect(
      Schema.is(LoomHeadingSchema)({
        type: "LoomHeading",
        position: pos,
        health: okHealth,
        headingStart: { ...headingStart, type: "Arrow" },
        texts: [],
      }),
    ).toBe(false)
  })
})

describe("LoomHeading.texts", () => {
  it("accepts an empty texts array (heading with no interstitial text)", () => {
    expect(
      Schema.is(LoomHeadingSchema)({
        type: "LoomHeading",
        position: pos,
        health: okHealth,
        headingStart,
        texts: [],
        tag: tag("Loom"),
        specifier: specifier("Loom"),
      }),
    ).toBe(true)
  })

  it("accepts a single text segment (typical `## Section title` heading)", () => {
    expect(
      Schema.is(LoomHeadingSchema)({
        type: "LoomHeading",
        position: pos,
        health: okHealth,
        headingStart,
        texts: [text(3, 16)],
      }),
    ).toBe(true)
  })

  it("accepts multiple text segments interleaved with structural tokens", () => {
    // models `# [Loom] is written in {Loom}` — text after the tag, before the specifier
    expect(
      Schema.is(LoomHeadingSchema)({
        type: "LoomHeading",
        position: pos,
        health: okHealth,
        headingStart,
        texts: [text(8, 23), text(29, 30)],
        tag: tag("Loom"),
        specifier: specifier("Loom"),
      }),
    ).toBe(true)
  })

  it("rejects a single TextToken in the `texts` slot (must be an array)", () => {
    expect(
      Schema.is(LoomHeadingSchema)({
        type: "LoomHeading",
        position: pos,
        health: okHealth,
        headingStart,
        texts: text(3, 16), // not an array
        tag: tag("Loom"),
        specifier: specifier("Loom"),
      }),
    ).toBe(false)
  })

  it("rejects a non-Text token in the texts array", () => {
    expect(
      Schema.is(LoomHeadingSchema)({
        type: "LoomHeading",
        position: pos,
        health: okHealth,
        headingStart,
        // a Tag is the wrong kind here
        texts: [tag("Greet") as unknown as ReturnType<typeof text>],
      }),
    ).toBe(false)
  })
})

// =============================================================================
// LoomDocument — two slots: preamble (PreambleWeft[]) and sections
// (LoomSection[]). There is NO `wefts` slot and NO `chapters` slot.
// Either slot may be empty.
// =============================================================================

const preambleWeft = () => ({
  type: "PreambleWeft" as const,
  position: pos,
  health: okHealth,
  warps: [],
})

const heading = () => ({
  type: "LoomHeading" as const,
  position: pos,
  health: okHealth,
  headingStart,
  texts: [],
})

const section = () => ({
  type: "LoomSection" as const,
  position: pos,
  health: okHealth,
  heading: heading(),
  preamble: [],
  code: [],
})

describe("LoomDocument", () => {
  it("accepts an empty document (both slots empty)", () => {
    expect(
      Schema.is(LoomDocumentSchema)({
        type: "LoomDocument",
        position: pos,
        health: okHealth,
        preamble: [],
        sections: [],
      }),
    ).toBe(true)
  })

  it("accepts PreambleWefts in `preamble`", () => {
    expect(
      Schema.is(LoomDocumentSchema)({
        type: "LoomDocument",
        position: pos,
        health: okHealth,
        preamble: [preambleWeft(), preambleWeft()],
        sections: [],
      }),
    ).toBe(true)
  })

  it("accepts LoomSections in `sections`", () => {
    expect(
      Schema.is(LoomDocumentSchema)({
        type: "LoomDocument",
        position: pos,
        health: okHealth,
        preamble: [],
        sections: [section()],
      }),
    ).toBe(true)
  })

  it("rejects a non-PreambleWeft (e.g. a bare object with wrong type) in `preamble`", () => {
    expect(
      Schema.is(LoomDocumentSchema)({
        type: "LoomDocument",
        position: pos,
        health: okHealth,
        preamble: [{ type: "ProseWeft", position: pos, health: okHealth }],
        sections: [],
      }),
    ).toBe(false)
  })

  it("rejects a non-Section (e.g. an object with no heading) in `sections`", () => {
    expect(
      Schema.is(LoomDocumentSchema)({
        type: "LoomDocument",
        position: pos,
        health: okHealth,
        preamble: [],
        sections: [{ type: "LoomSection", position: pos, health: okHealth }],
      }),
    ).toBe(false)
  })

  it("rejects a document with the old three-slot shape (wefts/sections/chapters)", () => {
    expect(
      Schema.is(LoomDocumentSchema)({
        type: "LoomDocument",
        position: pos,
        health: okHealth,
        wefts: [],
        sections: [],
        chapters: [],
      }),
    ).toBe(false)
  })
})

// =============================================================================
// LoomSection — quick sanity checks for the body slots.
// =============================================================================

describe("LoomSection — body shape", () => {
  it("accepts heading + empty preamble + empty code", () => {
    expect(Schema.is(LoomSectionSchema)(section())).toBe(true)
  })

  it("accepts a section with preamble wefts", () => {
    expect(
      Schema.is(LoomSectionSchema)({
        ...section(),
        preamble: [preambleWeft()],
      }),
    ).toBe(true)
  })

  it("rejects a section without a heading", () => {
    expect(
      Schema.is(LoomSectionSchema)({
        type: "LoomSection",
        position: pos,
        health: okHealth,
        preamble: [],
        code: [],
      }),
    ).toBe(false)
  })
})
