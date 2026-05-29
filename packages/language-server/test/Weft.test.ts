import { describe, expect, it } from "@effect/vitest"
import { Option, Schema } from "effect"
import {
  ArrowTokenSchema,
  HeadingStartTokenSchema,
  PathSpecifierTokenSchema,
  SpecifierTokenSchema,
  TagTokenSchema,
  TildeTokenSchema,
  WarpAnchorTokenSchema,
  WarpTokenSchema,
  getProbe,
} from "#ast/LoomTokens"
import { okHealth } from "#ast/LoomNode"
import {
  ArrowWeftSchema,
  HeadingWeftSchema,
  LoomWeftSchema,
  TildeWeftSchema,
} from "#ast/Weft"

const samplePosition = {
  start: { line: 1, column: 1, offset: 0 },
  end: { line: 1, column: 4, offset: 3 },
}

const validHeadingStart = {
  type: "HeadingStart" as const,
  position: samplePosition,
  source: "",
  health: okHealth,
}

const validTag = {
  type: "Tag" as const,
  position: samplePosition,
  source: "",
  health: okHealth,
  open: { type: "TagOpen" as const, value: "[" as const, position: samplePosition, source: "", health: okHealth },
  label: { type: "TagLabel" as const, value: "Greet", position: samplePosition, source: "", health: okHealth },
  close: { type: "TagClose" as const, value: "]" as const, position: samplePosition, source: "", health: okHealth },
}

const validSpecifier = {
  type: "Specifier" as const,
  position: samplePosition,
  source: "",
  health: okHealth,
  open: { type: "SpecifierOpen" as const, value: "{" as const, position: samplePosition, source: "", health: okHealth },
  label: { type: "SpecifierLabel" as const, value: "Loom", position: samplePosition, source: "", health: okHealth },
  close: { type: "SpecifierClose" as const, value: "}" as const, position: samplePosition, source: "", health: okHealth },
}

const validPathSpecifier = {
  type: "PathSpecifier" as const,
  position: samplePosition,
  source: "",
  health: okHealth,
  open: { type: "SpecifierOpen" as const, value: "{" as const, position: samplePosition, source: "", health: okHealth },
  label: { type: "PathSpecifierLabel" as const, value: "src/index.ts", position: samplePosition, source: "", health: okHealth },
  close: { type: "SpecifierClose" as const, value: "}" as const, position: samplePosition, source: "", health: okHealth },
}

// =============================================================================
// Probe annotation
// =============================================================================

describe("Probe annotation", () => {
  it("returns a probe for every token", () => {
    expect(Option.isSome(getProbe(HeadingStartTokenSchema))).toBe(true)
    expect(Option.isSome(getProbe(ArrowTokenSchema))).toBe(true)
    expect(Option.isSome(getProbe(TildeTokenSchema))).toBe(true)
    expect(Option.isSome(getProbe(TagTokenSchema))).toBe(true)
    expect(Option.isSome(getProbe(SpecifierTokenSchema))).toBe(true)
    expect(Option.isSome(getProbe(PathSpecifierTokenSchema))).toBe(true)
    expect(Option.isSome(getProbe(WarpTokenSchema))).toBe(true)
    expect(Option.isSome(getProbe(WarpAnchorTokenSchema))).toBe(true)
  })

  it("returns None for Wefts (line-level recognition lives on tokens only)", () => {
    expect(Option.isNone(getProbe(HeadingWeftSchema))).toBe(true)
    expect(Option.isNone(getProbe(ArrowWeftSchema))).toBe(true)
    expect(Option.isNone(getProbe(TildeWeftSchema))).toBe(true)
  })
})

// =============================================================================
// Probes
// =============================================================================

describe("HeadingStart probe", () => {
  const probe = Option.getOrThrow(getProbe(HeadingStartTokenSchema))

  it("matches level-1 `#` followed by a space", () => {
    expect("# Heading".match(probe)?.[0]).toBe("# ")
  })

  it("matches level-2 through level-6 headings", () => {
    expect("## Section".match(probe)?.[0]).toBe("## ")
    expect("###### Deep".match(probe)?.[0]).toBe("###### ")
  })

  it("rejects 7+ hashes (too deep)", () => {
    expect("####### TooDeep".match(probe)).toBeNull()
  })

  it("rejects hash with no trailing space", () => {
    expect("#NoSpace".match(probe)).toBeNull()
  })

  it("rejects plain text", () => {
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

describe("PathSpecifier probe", () => {
  const probe = Option.getOrThrow(getProbe(PathSpecifierTokenSchema))

  it("finds a path specifier with `/` separators", () => {
    const matches = [..."# Tangle {src/x.ts}".matchAll(probe)]
    expect(matches).toHaveLength(1)
    expect(matches[0][0]).toBe("{src/x.ts}")
  })

  it("admits `.` in path labels", () => {
    const matches = [..."# Tangle {package.json}".matchAll(probe)]
    expect(matches).toHaveLength(1)
    expect(matches[0][0]).toBe("{package.json}")
  })
})

describe("Warp probe", () => {
  const probe = Option.getOrThrow(getProbe(WarpTokenSchema))

  it("matches `{{name: type}}` declarations", () => {
    expect([..."Uses {{mul: Mul}} to multiply.".matchAll(probe)][0]?.[0])
      .toBe("{{mul: Mul}}")
  })

  it("matches `{{name: type = default}}` declarations", () => {
    expect([..."port {{port: string = \"8080\"}}".matchAll(probe)][0]?.[0])
      .toBe(`{{port: string = "8080"}}`)
  })

  it("does not match bare `{{name}}` references (no `:`)", () => {
    expect([..."{{mul}}".matchAll(probe)]).toHaveLength(0)
  })
})

describe("WarpAnchor probe", () => {
  const probe = Option.getOrThrow(getProbe(WarpAnchorTokenSchema))

  it("matches `{{name}}` references", () => {
    expect([..."{{mul}}".matchAll(probe)][0]?.[0]).toBe("{{mul}}")
  })

  it("does not match declarations (which contain `:`)", () => {
    expect([..."{{mul: Mul}}".matchAll(probe)]).toHaveLength(0)
  })
})

// =============================================================================
// Token schema validation
// =============================================================================

describe("HeadingStart schema validation", () => {
  it("accepts a well-formed token", () => {
    expect(Schema.is(HeadingStartTokenSchema)(validHeadingStart)).toBe(true)
  })

  it("rejects a wrong `type` discriminator", () => {
    expect(
      Schema.is(HeadingStartTokenSchema)({
        ...validHeadingStart,
        type: "SectionHeadingStart",
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
        open: { type: "TagOpen", value: "{", position: samplePosition, source: "", health: okHealth },
      }),
    ).toBe(false)
  })
})

describe("PathSpecifier schema validation", () => {
  it("accepts a well-formed `{src/x.ts}`-style token", () => {
    expect(Schema.is(PathSpecifierTokenSchema)(validPathSpecifier)).toBe(true)
  })

  it("label type is `PathSpecifierLabel`", () => {
    expect(validPathSpecifier.label.type).toBe("PathSpecifierLabel")
  })

  it("rejects a Specifier (wrong type discriminator) in the PathSpecifier slot", () => {
    expect(Schema.is(PathSpecifierTokenSchema)(validSpecifier as any)).toBe(false)
  })
})

const warpOpen = {
  type: "WarpOpen" as const, value: "{{" as const,
  position: samplePosition, source: "", health: okHealth,
}
const warpClose = {
  type: "WarpClose" as const, value: "}}" as const,
  position: samplePosition, source: "", health: okHealth,
}

const warpAnchorName = (value: string) => ({
  type: "WarpAnchorName" as const, value, position: samplePosition, source: "", health: okHealth,
})

const warpName = (value: string) => ({
  type: "WarpName" as const, value, position: samplePosition, source: "", health: okHealth,
})

describe("WarpAnchor schema validation", () => {
  it("accepts a simple single-word name", () => {
    expect(
      Schema.is(WarpAnchorTokenSchema)({
        type: "WarpAnchor",
        position: samplePosition,
        source: "",
        health: okHealth,
        open: warpOpen,
        name: warpAnchorName("mul"),
        close: warpClose,
      }),
    ).toBe(true)
  })

  it("accepts a multi-word heading name (e.g. `Multiplier Function`)", () => {
    expect(
      Schema.is(WarpAnchorTokenSchema)({
        type: "WarpAnchor",
        position: samplePosition,
        source: "",
        health: okHealth,
        open: warpOpen,
        name: warpAnchorName("Multiplier Function"),
        close: warpClose,
      }),
    ).toBe(true)
  })

  it("rejects a name containing `:`", () => {
    expect(
      Schema.is(WarpAnchorTokenSchema)({
        type: "WarpAnchor",
        position: samplePosition,
        source: "",
        health: okHealth,
        open: warpOpen,
        name: warpAnchorName("not:valid"),
        close: warpClose,
      }),
    ).toBe(false)
  })
})

describe("Warp schema validation", () => {
  const annotation = {
    type: "WarpAnnotation" as const, value: " Mul",
    position: samplePosition, source: "", health: okHealth,
  }
  const defaultToken = {
    type: "WarpDefault" as const, value: ' "8080"',
    position: samplePosition, source: "", health: okHealth,
  }

  it("accepts a declaration without a default", () => {
    expect(
      Schema.is(WarpTokenSchema)({
        type: "Warp",
        position: samplePosition,
        source: "",
        health: okHealth,
        open: warpOpen,
        name: warpName("mul"),
        annotation,
        close: warpClose,
      }),
    ).toBe(true)
  })

  it("accepts a declaration with a default", () => {
    expect(
      Schema.is(WarpTokenSchema)({
        type: "Warp",
        position: samplePosition,
        source: "",
        health: okHealth,
        open: warpOpen,
        name: warpName("port"),
        annotation: { ...annotation, value: " string" },
        default: defaultToken,
        close: warpClose,
      }),
    ).toBe(true)
  })

  it("rejects when annotation is missing", () => {
    expect(
      Schema.is(WarpTokenSchema)({
        type: "Warp",
        position: samplePosition,
        source: "",
        health: okHealth,
        open: warpOpen,
        name: warpName("mul"),
        close: warpClose,
      }),
    ).toBe(false)
  })
})

// =============================================================================
// HeadingWeft schema validation
// =============================================================================

describe("HeadingWeft schema", () => {
  it("accepts a heading with only headingStart + empty texts (no tag, no specifier)", () => {
    expect(
      Schema.is(HeadingWeftSchema)({
        type: "HeadingWeft",
        position: samplePosition,
        source: "",
        health: okHealth,
        headingStart: validHeadingStart,
        texts: [],
      }),
    ).toBe(true)
  })

  it("accepts a heading with tag only", () => {
    expect(
      Schema.is(HeadingWeftSchema)({
        type: "HeadingWeft",
        position: samplePosition,
        source: "",
        health: okHealth,
        headingStart: validHeadingStart,
        texts: [],
        tag: validTag,
      }),
    ).toBe(true)
  })

  it("accepts a heading with a label specifier only", () => {
    expect(
      Schema.is(HeadingWeftSchema)({
        type: "HeadingWeft",
        position: samplePosition,
        source: "",
        health: okHealth,
        headingStart: validHeadingStart,
        texts: [],
        specifier: validSpecifier,
      }),
    ).toBe(true)
  })

  it("accepts a heading with a path specifier", () => {
    expect(
      Schema.is(HeadingWeftSchema)({
        type: "HeadingWeft",
        position: samplePosition,
        source: "",
        health: okHealth,
        headingStart: validHeadingStart,
        texts: [],
        specifier: validPathSpecifier,
      }),
    ).toBe(true)
  })

  it("accepts a heading with both tag and specifier", () => {
    expect(
      Schema.is(HeadingWeftSchema)({
        type: "HeadingWeft",
        position: samplePosition,
        source: "",
        health: okHealth,
        headingStart: validHeadingStart,
        texts: [],
        tag: validTag,
        specifier: validSpecifier,
      }),
    ).toBe(true)
  })

  it("rejects a wrong-kind token in the tag slot", () => {
    expect(
      Schema.is(HeadingWeftSchema)({
        type: "HeadingWeft",
        position: samplePosition,
        source: "",
        health: okHealth,
        headingStart: validHeadingStart,
        texts: [],
        tag: { ...validSpecifier } as any, // wrong kind
      }),
    ).toBe(false)
  })
})

// =============================================================================
// ArrowWeft / TildeWeft — quick sanity checks preserved from the old suite
// =============================================================================

describe("ArrowWeft schema", () => {
  it("accepts a well-formed arrow Weft", () => {
    expect(
      Schema.is(ArrowWeftSchema)({
        type: "ArrowWeft",
        position: samplePosition,
        source: "",
        health: okHealth,
        arrow: { type: "Arrow", position: samplePosition, source: "", health: okHealth },
        anchors: [],
      }),
    ).toBe(true)
  })

  it("rejects an ArrowWeft holding a wrong-kind token", () => {
    expect(
      Schema.is(ArrowWeftSchema)({
        type: "ArrowWeft",
        position: samplePosition,
        source: "",
        health: okHealth,
        arrow: { type: "Tilde", position: samplePosition, source: "", health: okHealth },
        anchors: [],
      }),
    ).toBe(false)
  })
})

describe("TildeWeft schema", () => {
  it("accepts a well-formed tilde Weft", () => {
    expect(
      Schema.is(TildeWeftSchema)({
        type: "TildeWeft",
        position: samplePosition,
        source: "",
        health: okHealth,
        tilde: { type: "Tilde", position: samplePosition, source: "", health: okHealth },
      }),
    ).toBe(true)
  })
})

// =============================================================================
// LoomWeft union — discriminates correctly across all current Weft kinds
// =============================================================================

describe("LoomWeft union", () => {
  it("accepts a HeadingWeft", () => {
    expect(
      Schema.is(LoomWeftSchema)({
        type: "HeadingWeft",
        position: samplePosition,
        source: "",
        health: okHealth,
        headingStart: validHeadingStart,
        texts: [],
      }),
    ).toBe(true)
  })

  it("accepts an ArrowWeft", () => {
    expect(
      Schema.is(LoomWeftSchema)({
        type: "ArrowWeft",
        position: samplePosition,
        source: "",
        health: okHealth,
        arrow: { type: "Arrow", position: samplePosition, source: "", health: okHealth },
        anchors: [],
      }),
    ).toBe(true)
  })

  it("rejects an unknown kind", () => {
    expect(
      Schema.is(LoomWeftSchema)({ type: "UnknownWeft", position: samplePosition, source: "", health: okHealth }),
    ).toBe(false)
  })
})
