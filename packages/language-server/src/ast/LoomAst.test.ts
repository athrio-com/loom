import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"
import { LoomHeadingSchema } from "./LoomAst"
import { okHealth, type Position } from "./LoomNode"

const pos: Position = {
  start: { line: 1, column: 1, offset: 0 },
  end: { line: 1, column: 4, offset: 3 },
}

const chapterMarkers = {
  type: "ChapterHeadingStart" as const,
  position: pos,
  health: okHealth,
}

const sectionMarkers = {
  type: "SectionHeadingStart" as const,
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
// LoomHeading.texts — array of TextTokens, never a single token.
// =============================================================================

describe("LoomHeading.texts", () => {
  it("accepts an empty texts array (heading with no interstitial text)", () => {
    expect(
      Schema.is(LoomHeadingSchema)({
        type: "LoomHeading",
        position: pos,
        health: okHealth,
        markers: chapterMarkers,
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
        markers: sectionMarkers,
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
        markers: chapterMarkers,
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
        markers: chapterMarkers,
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
        markers: sectionMarkers,
        // a Tag is the wrong kind here
        texts: [tag("Greet") as unknown as ReturnType<typeof text>],
      }),
    ).toBe(false)
  })
})
