import { describe, expect, it } from "@effect/vitest"
import { Option, Schema } from "effect"
import {
  ArrowTokenSchema,
  HeadingStartTokenSchema,
  SeparatorTokenSchema,
  SpecifierTokenSchema,
  TagTokenSchema,
  TildeTokenSchema,
  getProbe,
} from "./LoomTokens"
import {
  ArrowWeftSchema,
  HeadingWeftSchema,
  LoomWeftSchema,
  SeparatorWeftSchema,
  TildeWeftSchema,
  WeftSchema,
} from "./LoomWefts"
import type { LineRange } from "./StreamLineRanges"

const samplePosition = {
  start: { line: 1, column: 1, offset: 0 },
  end: { line: 1, column: 4, offset: 3 },
}

// Sample source — a LineRange covering "## Heading" (10 chars) at offset 0.
const sampleSource: LineRange = [0, 10]

const validHeadingStart = {
  type: "HeadingStart" as const,
  position: samplePosition,
  markers: { value: "##", position: samplePosition },
}

const validTag = {
  type: "Tag" as const,
  position: samplePosition,
  open: { value: "[" as const, position: samplePosition },
  label: { value: "Greet", position: samplePosition },
  close: { value: "]" as const, position: samplePosition },
}

const validSpecifier = {
  type: "Specifier" as const,
  position: samplePosition,
  open: { value: "{" as const, position: samplePosition },
  label: { value: "Loom", position: samplePosition },
  close: { value: "}" as const, position: samplePosition },
}

// =============================================================================
// Probe annotation
// =============================================================================

describe("Probe annotation", () => {
  it("returns a probe for every token", () => {
    expect(Option.isSome(getProbe(HeadingStartTokenSchema))).toBe(true)
    expect(Option.isSome(getProbe(ArrowTokenSchema))).toBe(true)
    expect(Option.isSome(getProbe(TildeTokenSchema))).toBe(true)
    expect(Option.isSome(getProbe(SeparatorTokenSchema))).toBe(true)
    expect(Option.isSome(getProbe(TagTokenSchema))).toBe(true)
    expect(Option.isSome(getProbe(SpecifierTokenSchema))).toBe(true)
  })

  it("returns None for Wefts (not pattern-recognised at schema level)", () => {
    expect(Option.isNone(getProbe(WeftSchema))).toBe(true)
    expect(Option.isNone(getProbe(HeadingWeftSchema))).toBe(true)
    expect(Option.isNone(getProbe(ArrowWeftSchema))).toBe(true)
    expect(Option.isNone(getProbe(TildeWeftSchema))).toBe(true)
    expect(Option.isNone(getProbe(SeparatorWeftSchema))).toBe(true)
  })
})

// =============================================================================
// Probes
// =============================================================================

describe("HeadingStart probe", () => {
  const probe = Option.getOrThrow(getProbe(HeadingStartTokenSchema))

  it("matches 1–6 hash markers followed by a space", () => {
    expect("# Heading".match(probe)?.[0]).toBe("# ")
    expect("## Section".match(probe)?.[0]).toBe("## ")
    expect("###### Deep".match(probe)?.[0]).toBe("###### ")
  })

  it("rejects malformed headings", () => {
    expect("##NoSpace".match(probe)).toBeNull()
    expect("####### TooDeep".match(probe)).toBeNull()
    expect("Plain text".match(probe)).toBeNull()
  })
})

describe("Arrow probe", () => {
  const probe = Option.getOrThrow(getProbe(ArrowTokenSchema))

  it("matches `=>` with optional indent and tolerates trailing content", () => {
    expect(probe.test("=>")).toBe(true)
    expect(probe.test("  =>")).toBe(true)
    expect(probe.test("=> let x = 1")).toBe(true)
  })

  it("rejects `=>` mid-line", () => {
    expect(probe.test("const f = (x) => x + 1")).toBe(false)
  })
})

describe("Tilde probe", () => {
  const probe = Option.getOrThrow(getProbe(TildeTokenSchema))

  it("matches one or more `~` with optional indent and trailing", () => {
    expect(probe.test("~")).toBe(true)
    expect(probe.test("~~~~~")).toBe(true)
    expect(probe.test("  ~~~ trailing")).toBe(true)
  })

  it("captures the full tilde stack within its match", () => {
    expect("~~~~~ Text".match(probe)?.[0]).toBe("~~~~~")
  })

  it("rejects `~` mid-line", () => {
    expect(probe.test("const x = ~y")).toBe(false)
  })
})

describe("Separator probe (strict whole-line)", () => {
  it("matches exactly `---`", () => {
    const probe = Option.getOrThrow(getProbe(SeparatorTokenSchema))
    expect(probe.test("---")).toBe(true)
    expect(probe.test("----")).toBe(false)
    expect(probe.test("--- foo")).toBe(false)
  })
})

describe("Tag probe", () => {
  const probe = Option.getOrThrow(getProbe(TagTokenSchema))

  it("finds every [name] with position", () => {
    const matches = [..."# Heading [Greet] more [Reply]".matchAll(probe)]
    expect(matches).toHaveLength(2)
    expect(matches[0][0]).toBe("[Greet]")
    expect(matches[0].index).toBe(10)
    expect(matches[1][0]).toBe("[Reply]")
    expect(matches[1].index).toBe(23)
  })

  it("rejects empty brackets and disallowed characters", () => {
    expect([..."[]".matchAll(probe)]).toHaveLength(0)
    expect([..."[has space]".matchAll(probe)]).toHaveLength(0)
  })
})

describe("Specifier probe", () => {
  const probe = Option.getOrThrow(getProbe(SpecifierTokenSchema))

  it("finds every {name} with position", () => {
    const matches = [..."# Section {Loom}".matchAll(probe)]
    expect(matches).toHaveLength(1)
    expect(matches[0][0]).toBe("{Loom}")
  })
})

// =============================================================================
// Token schema validation (subset)
// =============================================================================

describe("HeadingStart schema validation", () => {
  it("accepts a well-formed token", () => {
    expect(Schema.is(HeadingStartTokenSchema)(validHeadingStart)).toBe(true)
  })

  it("rejects markers with too many hashes", () => {
    expect(
      Schema.is(HeadingStartTokenSchema)({
        ...validHeadingStart,
        markers: { value: "#######", position: samplePosition },
      }),
    ).toBe(false)
  })
})

describe("Tag schema validation", () => {
  it("accepts a well-formed token", () => {
    expect(Schema.is(TagTokenSchema)(validTag)).toBe(true)
  })

  it("rejects wrong open delimiter", () => {
    expect(
      Schema.is(TagTokenSchema)({
        ...validTag,
        open: { value: "{", position: samplePosition },
      }),
    ).toBe(false)
  })
})

// =============================================================================
// Weft schema validation
// =============================================================================

describe("Weft (default) schema", () => {
  it("accepts a well-formed default Weft", () => {
    expect(
      Schema.is(WeftSchema)({ type: "Weft", source: sampleSource }),
    ).toBe(true)
  })
})

describe("HeadingWeft schema", () => {
  it("accepts a heading with only headingStart (no tag, no specifier)", () => {
    expect(
      Schema.is(HeadingWeftSchema)({
        type: "HeadingWeft",
        source: sampleSource,
        headingStart: validHeadingStart,
      }),
    ).toBe(true)
  })

  it("accepts a heading with tag only", () => {
    expect(
      Schema.is(HeadingWeftSchema)({
        type: "HeadingWeft",
        source: sampleSource,
        headingStart: validHeadingStart,
        tag: validTag,
      }),
    ).toBe(true)
  })

  it("accepts a heading with specifier only", () => {
    expect(
      Schema.is(HeadingWeftSchema)({
        type: "HeadingWeft",
        source: sampleSource,
        headingStart: validHeadingStart,
        specifier: validSpecifier,
      }),
    ).toBe(true)
  })

  it("accepts a heading with both tag and specifier", () => {
    expect(
      Schema.is(HeadingWeftSchema)({
        type: "HeadingWeft",
        source: sampleSource,
        headingStart: validHeadingStart,
        tag: validTag,
        specifier: validSpecifier,
      }),
    ).toBe(true)
  })

  it("rejects a heading carrying a non-tag in the tag slot", () => {
    expect(
      Schema.is(HeadingWeftSchema)({
        type: "HeadingWeft",
        source: sampleSource,
        headingStart: validHeadingStart,
        tag: { ...validSpecifier }, // wrong kind
      }),
    ).toBe(false)
  })
})

describe("ArrowWeft schema", () => {
  it("accepts a well-formed arrow Weft", () => {
    expect(
      Schema.is(ArrowWeftSchema)({
        type: "ArrowWeft",
        source: sampleSource,
        arrow: { type: "Arrow", position: samplePosition },
      }),
    ).toBe(true)
  })

  it("rejects an ArrowWeft holding a wrong-kind token", () => {
    expect(
      Schema.is(ArrowWeftSchema)({
        type: "ArrowWeft",
        source: sampleSource,
        arrow: { type: "Tilde", position: samplePosition },
      }),
    ).toBe(false)
  })
})

describe("TildeWeft schema", () => {
  it("accepts a well-formed tilde Weft", () => {
    expect(
      Schema.is(TildeWeftSchema)({
        type: "TildeWeft",
        source: sampleSource,
        tilde: { type: "Tilde", position: samplePosition },
      }),
    ).toBe(true)
  })
})

describe("SeparatorWeft schema", () => {
  it("accepts a well-formed separator Weft", () => {
    expect(
      Schema.is(SeparatorWeftSchema)({
        type: "SeparatorWeft",
        source: sampleSource,
        separator: { type: "Separator", position: samplePosition },
      }),
    ).toBe(true)
  })
})

describe("LoomWeft union", () => {
  it("accepts every Weft kind", () => {
    expect(
      Schema.is(LoomWeftSchema)({ type: "Weft", source: sampleSource }),
    ).toBe(true)
    expect(
      Schema.is(LoomWeftSchema)({
        type: "SeparatorWeft",
        source: sampleSource,
        separator: { type: "Separator", position: samplePosition },
      }),
    ).toBe(true)
  })

  it("rejects an unknown kind", () => {
    expect(
      Schema.is(LoomWeftSchema)({ type: "UnknownWeft", source: sampleSource }),
    ).toBe(false)
  })
})
