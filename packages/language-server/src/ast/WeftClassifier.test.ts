import { describe, expect, it } from "@effect/vitest"
import { Chunk, Effect, Stream } from "effect"
import type { LineRange } from "./LineRanges"
import { incompleteHealth, okHealth } from "./LoomNode"
import { WeftClassifier } from "./WeftClassifier"
import type { LoomWeft } from "./Weft"

// =============================================================================
// Test harness — feed the classifier multi-line input via its Service and
// collect the LoomWefts. Driving the public Service (rather than reaching
// into private functions) exercises the full pipeline: mapAccum carrying
// Option<LoomWeft>, modeOf derivation, probeOf, the decision table.
//
// The Classifier Stage emits the following set of LoomWefts:
//   Weft, ChapterHeadingWeft, SectionHeadingWeft, ArrowWeft, TildeWeft,
//   PreambleWeft, CodeWeft, ProseWeft, DependencyWeft, TangleWeft.
// DependenciesHeadingWeft and TangleHeadingWeft are the Tokeniser Stage's
// responsibility; the Classifier Stage always emits a plain SectionHeadingWeft
// for a `##…` line, regardless of tag content.
// =============================================================================

const classify = (lines: ReadonlyArray<string>): ReadonlyArray<LoomWeft> => {
  const text = lines.join("\n")
  const ranges: LineRange[] = []
  let offset = 0
  for (const line of lines) {
    ranges.push([offset, offset + line.length] as const)
    offset += line.length + 1 // +1 for "\n"
  }
  return Effect.runSync(
    Effect.gen(function* () {
      const c = yield* WeftClassifier
      const source = Stream.fromIterable(ranges)
      const chunk = yield* Stream.runCollect(c.classifyWefts(text)(source))
      return Chunk.toReadonlyArray(chunk)
    }).pipe(Effect.provide(WeftClassifier.Default)),
  )
}

const last = <T>(arr: ReadonlyArray<T>): T => arr[arr.length - 1]
const types = (arr: ReadonlyArray<LoomWeft>): ReadonlyArray<string> =>
  arr.map((w) => w.type)

// =============================================================================
// Stream-level behavior — line numbers, output shape.
// =============================================================================

describe("classifyWefts — stream", () => {
  it("emits one weft per LineRange in order", () => {
    const out = classify(["one", "two", "three"])
    expect(out).toHaveLength(3)
  })

  it("assigns sequential line numbers starting at 1", () => {
    const out = classify(["a", "b", "c", "d"])
    expect(out.map((w) => w.position.start.line)).toEqual([1, 2, 3, 4])
    expect(out.map((w) => w.position.end.line)).toEqual([1, 2, 3, 4])
  })

  it("preserves line-range offsets in the position", () => {
    const out = classify(["hello", "world"])
    // "hello" at offsets 0..5; "world" at offsets 6..11
    expect(out[0].position.start.offset).toBe(0)
    expect(out[0].position.end.offset).toBe(5)
    expect(out[1].position.start.offset).toBe(6)
    expect(out[1].position.end.offset).toBe(11)
  })
})

// =============================================================================
// State axis — modeOf via output type.
//
// The Mealy property "output is next state" means that the type of the
// previous Weft determines the mode for the next line. We verify each
// mode-defining prev-Weft drives the next plain line to the expected leaf.
//
// `dependency` and `tangle` modes are unreachable from the Classifier Stage
// (no Deps / Tangle headings are emitted here), so they cannot be exercised
// through the public Service. modeOf still maps DependenciesHeadingWeft and
// TangleHeadingWeft to those modes — the Tokeniser Stage will exercise that
// path.
// =============================================================================

describe("modeOf — state axis (prev Weft → mode → next leaf)", () => {
  it("None  → orphan → Weft", () => {
    expect(classify(["just text"])[0].type).toBe("Weft")
  })

  it("ChapterHeading → preamble → PreambleWeft", () => {
    const out = classify(["# Title [T]{S}", "intro line"])
    expect(out[1].type).toBe("PreambleWeft")
  })

  it("SectionHeading → preamble → PreambleWeft", () => {
    const out = classify(["## Section", "intro line"])
    expect(out[1].type).toBe("PreambleWeft")
  })

  it("PreambleWeft → preamble (sticky) → PreambleWeft", () => {
    const out = classify(["## Section", "first preamble", "more preamble"])
    expect(out[2].type).toBe("PreambleWeft")
  })

  it("ArrowWeft → code → CodeWeft", () => {
    const out = classify(["## Section", "=> ", "x = 1"])
    expect(out[2].type).toBe("CodeWeft")
  })

  it("CodeWeft → code (sticky) → CodeWeft", () => {
    const out = classify(["## Section", "=>", "x = 1", "y = 2"])
    expect(out[3].type).toBe("CodeWeft")
  })

  it("TildeWeft → prose → ProseWeft", () => {
    const out = classify(["## Section", "=>", "x = 1", "~", "prose text"])
    expect(out[4].type).toBe("ProseWeft")
  })

  it("ProseWeft → prose (sticky, terminal) → ProseWeft", () => {
    const out = classify(["## Section", "~", "prose 1", "prose 2"])
    expect(out[3].type).toBe("ProseWeft")
  })

  it("Weft (pre-chapter) → orphan (sticky) → Weft", () => {
    const out = classify(["before", "still before"])
    expect(out.map((w) => w.type)).toEqual(["Weft", "Weft"])
  })
})

// =============================================================================
// Decision table — (mode, probe) → output Weft.
//
// Only the modes the Classifier Stage can reach are exercised: orphan,
// preamble, code, prose. `dependency` and `tangle` modes are unreachable
// until the Tokeniser Stage promotes section headings to Deps / Tangle.
// =============================================================================

describe("Decision table — universal columns (mode-independent)", () => {
  const modePrelude: Record<string, ReadonlyArray<string>> = {
    orphan: [],
    preamble: ["## A"],
    code: ["## A", "=>"],
    prose: ["## A", "~"],
  }

  for (const [mode, prelude] of Object.entries(modePrelude)) {
    it(`chapter probe wins from mode=${mode}`, () => {
      const out = classify([...prelude, "# Title [T]{S}"])
      expect(last(out).type).toBe("ChapterHeadingWeft")
    })

    it(`section probe wins from mode=${mode}`, () => {
      const out = classify([...prelude, "## Section"])
      expect(last(out).type).toBe("SectionHeadingWeft")
    })

    it(`section probe + [D] yields DependenciesHeadingWeft from mode=${mode}`, () => {
      const out = classify([...prelude, "## Deps [D]"])
      expect(last(out).type).toBe("DependenciesHeadingWeft")
    })

    it(`section probe + [T] yields TangleHeadingWeft from mode=${mode}`, () => {
      const out = classify([...prelude, "## Tangle [T]"])
      expect(last(out).type).toBe("TangleHeadingWeft")
    })
  }
})

describe("Decision table — mode-gated transitions", () => {
  it("preamble + arrow → ArrowWeft", () => {
    const out = classify(["## A", "=>"])
    expect(last(out).type).toBe("ArrowWeft")
  })

  it("preamble + tilde → TildeWeft", () => {
    const out = classify(["## A", "~"])
    expect(last(out).type).toBe("TildeWeft")
  })

  it("code + tilde → TildeWeft", () => {
    const out = classify(["## A", "=>", "x = 1", "~"])
    expect(last(out).type).toBe("TildeWeft")
  })

  it("code + arrow → CodeWeft (arrow does not re-fire inside code mode)", () => {
    const out = classify(["## A", "=>", "x = 1", "=>"])
    expect(last(out).type).toBe("CodeWeft")
  })

  it("prose + arrow → ProseWeft (prose is terminal)", () => {
    const out = classify(["## A", "~", "prose", "=>"])
    expect(last(out).type).toBe("ProseWeft")
  })

  it("prose + tilde → ProseWeft (tilde does not re-fire inside prose)", () => {
    const out = classify(["## A", "~", "prose", "~"])
    expect(last(out).type).toBe("ProseWeft")
  })

  it("orphan + arrow → Weft (no chapter open yet)", () => {
    expect(classify(["=>"])[0].type).toBe("Weft")
  })

  it("orphan + tilde → Weft (no chapter open yet)", () => {
    expect(classify(["~"])[0].type).toBe("Weft")
  })
})

// =============================================================================
// Health status — partials carry incompleteHealth, terminals carry okHealth.
// =============================================================================

describe("Health status", () => {
  it("ChapterHeadingWeft is incompleteHealth (tag/specifier are placeholders)", () => {
    const out = classify(["# Title [T]{S}"])
    expect(out[0].health).toEqual(incompleteHealth)
  })

  it("SectionHeadingWeft is incompleteHealth (texts pending Tokeniser Stage)", () => {
    const out = classify(["## Section"])
    expect(out[0].health).toEqual(incompleteHealth)
  })

  it("ArrowWeft is incompleteHealth (code subtoken may follow)", () => {
    const out = classify(["## A", "=> let x = 1"])
    expect(last(out).health).toEqual(incompleteHealth)
  })

  it("TildeWeft is incompleteHealth (prose subtoken may follow)", () => {
    const out = classify(["## A", "~ a note"])
    expect(last(out).health).toEqual(incompleteHealth)
  })

  it("PreambleWeft is incompleteHealth (subtokens TODO)", () => {
    const out = classify(["## A", "intro"])
    expect(last(out).health).toEqual(incompleteHealth)
  })

  it("ProseWeft is incompleteHealth (subtokens TODO)", () => {
    const out = classify(["## A", "~", "prose"])
    expect(last(out).health).toEqual(incompleteHealth)
  })

  it("plain Weft (pre-chapter) is okHealth (terminal)", () => {
    expect(classify(["pre-chapter prose"])[0].health).toEqual(okHealth)
  })

  it("CodeWeft is okHealth (opaque per spec; no Tokeniser Stage work)", () => {
    const out = classify(["## A", "=>", "let x = 1"])
    expect(last(out).health).toEqual(okHealth)
  })
})

// =============================================================================
// Subtoken health — real source-parsed tokens vs NOK placeholders.
// =============================================================================

describe("Subtoken health", () => {
  it("ChapterHeading.headingStart carries okHealth (real `#` from source)", () => {
    const out = classify(["# Title [T]{S}"])
    const w = out[0]
    if (w.type !== "ChapterHeadingWeft") throw new Error("expected ChapterHeading")
    expect(w.headingStart.health).toEqual(okHealth)
    expect(w.headingStart.value).toBe("#")
  })

  it("SectionHeading.headingStart carries okHealth (real `##`+ from source)", () => {
    const out = classify(["### Deep"])
    const w = out[0]
    if (w.type !== "SectionHeadingWeft") throw new Error("expected SectionHeading")
    expect(w.headingStart.health).toEqual(okHealth)
    expect(w.headingStart.value).toBe("###")
  })

  it("ArrowToken (real marker) carries okHealth", () => {
    const out = classify(["## A", "=>"])
    const w = out[1]
    if (w.type !== "ArrowWeft") throw new Error("expected Arrow")
    expect(w.arrow.health).toEqual(okHealth)
  })

  it("TildeToken (real marker) carries okHealth", () => {
    const out = classify(["## A", "~~~"])
    const w = out[1]
    if (w.type !== "TildeWeft") throw new Error("expected Tilde")
    expect(w.tilde.health).toEqual(okHealth)
  })
})

// =============================================================================
// NOK placeholders — ChapterHeading is the only weft requiring tag/specifier
// stand-ins to satisfy its filter at the Classifier Stage.
// =============================================================================

describe("NOK placeholders on ChapterHeadingWeft", () => {
  const chapter = () => {
    const out = classify(["# Title"])
    const w = out[0]
    if (w.type !== "ChapterHeadingWeft") throw new Error("expected ChapterHeading")
    return w
  }

  it("emits a tag placeholder with incompleteHealth on every subnode", () => {
    const w = chapter()
    expect(w.tag).toBeDefined()
    expect(w.tag!.health).toEqual(incompleteHealth)
    expect(w.tag!.open.health).toEqual(incompleteHealth)
    expect(w.tag!.label.health).toEqual(incompleteHealth)
    expect(w.tag!.close.health).toEqual(incompleteHealth)
  })

  it("emits a specifier placeholder with incompleteHealth on every subnode", () => {
    const w = chapter()
    expect(w.specifier).toBeDefined()
    expect(w.specifier!.health).toEqual(incompleteHealth)
    expect(w.specifier!.open.health).toEqual(incompleteHealth)
    expect(w.specifier!.label.health).toEqual(incompleteHealth)
    expect(w.specifier!.close.health).toEqual(incompleteHealth)
  })

  it("places tag placeholder at zero-width EOL position", () => {
    const w = chapter()
    // line "# Title" is 7 chars; EOL offset = range[1] = 7
    expect(w.tag!.position.start.offset).toBe(7)
    expect(w.tag!.position.end.offset).toBe(7)
  })

  it("places specifier placeholder at zero-width EOL position", () => {
    const w = chapter()
    expect(w.specifier!.position.start.offset).toBe(7)
    expect(w.specifier!.position.end.offset).toBe(7)
  })

  it("placeholders satisfy the ChapterHeadingWeft filter at the schema level", () => {
    // If they didn't, Schema.make in the classifier would throw — getting here
    // (and getting a ChapterHeadingWeft back) is the assertion.
    expect(chapter().type).toBe("ChapterHeadingWeft")
  })
})

// =============================================================================
// Section heading discrimination at the Classifier Stage — the Classifier
// probes for `[D]` / `[T]` on section heading lines and emits the
// appropriate reserved-heading weft kind directly. Detection is by
// lightweight regex; the Tokeniser fills the real subtokens.
// =============================================================================

describe("Section heading — Classifier-Stage [D] / [T] discrimination", () => {
  it("`## Deps [D]` → DependenciesHeadingWeft", () => {
    expect(classify(["## Deps [D]"])[0].type).toBe("DependenciesHeadingWeft")
  })

  it("`## Tangle [T]` → TangleHeadingWeft", () => {
    expect(classify(["## Tangle [T]"])[0].type).toBe("TangleHeadingWeft")
  })

  it("`## Greet [Greet]` → SectionHeadingWeft (non-reserved tag)", () => {
    expect(classify(["## Greet [Greet]"])[0].type).toBe("SectionHeadingWeft")
  })

  it("`## Plain heading` → SectionHeadingWeft", () => {
    expect(classify(["## Plain heading"])[0].type).toBe("SectionHeadingWeft")
  })

  it("`## Multi [D] [T]` → SectionHeadingWeft (multi-tag disqualifies promotion)", () => {
    expect(classify(["## Multi [D] [T]"])[0].type).toBe("SectionHeadingWeft")
  })

  it("`## Multi [Greet] [Reply]` → SectionHeadingWeft (multi-tag)", () => {
    expect(classify(["## Multi [Greet] [Reply]"])[0].type).toBe("SectionHeadingWeft")
  })

  it("`## [D]{TS}` → SectionHeadingWeft (specifier present disqualifies promotion)", () => {
    expect(classify(["## [D]{TS}"])[0].type).toBe("SectionHeadingWeft")
  })

  it("Classifier-Stage DependenciesHeading carries incompleteHealth and a NOK placeholder tag", () => {
    const w = classify(["## Deps [D]"])[0]
    if (w.type !== "DependenciesHeadingWeft") throw new Error("expected DependenciesHeading")
    expect(w.health.status).toBe("incomplete")
    expect(w.tag.health.status).toBe("incomplete")
    // Placeholder tag is zero-width at EOL — Tokeniser replaces it with the real tag.
    expect(w.tag.position.start.offset).toBe(w.position.end.offset)
    expect(w.tag.position.end.offset).toBe(w.position.end.offset)
  })
})

// =============================================================================
// Mealy chain — multi-line transitions exercising the full table.
// =============================================================================

describe("Mealy chain — output IS next state", () => {
  it("classifies a typical chapter with section, code, and prose runs", () => {
    const out = classify([
      "# HonoHello [Hono]{Loom}",      // chapter
      "intro prose",                    // PreambleWeft
      "## Greeting [Greet]",            // SectionHeading
      "preamble line",                  // PreambleWeft
      "=>",                             // ArrowWeft → switches to code
      "app.get('/', () => 'hi')",       // CodeWeft
      "~",                              // TildeWeft → switches to prose
      "now we describe it",             // ProseWeft
    ])
    expect(types(out)).toEqual([
      "ChapterHeadingWeft",
      "PreambleWeft",
      "SectionHeadingWeft",
      "PreambleWeft",
      "ArrowWeft",
      "CodeWeft",
      "TildeWeft",
      "ProseWeft",
    ])
  })

  it("[D] / [T] section headings are emitted as DependenciesHeading / TangleHeading at the Classifier Stage", () => {
    const out = classify([
      "## Deps [D]",
      "import { X }",
      "## Tangle [T]",
      "compose(X)",
    ])
    expect(types(out)).toEqual([
      "DependenciesHeadingWeft",
      "DependencyWeft",
      "TangleHeadingWeft",
      "TangleWeft",
    ])
  })

  it("any heading resets the mode (heading IS the section reset)", () => {
    // Walk through every Classifier-Stage-reachable non-orphan mode, then hit a heading.
    const out = classify([
      "## A", "preamble",  // preamble
      "=>", "code",         // code
      "## B",               // reset from code
      "~", "prose",         // prose
      "## C",               // reset from prose
    ])
    expect(out.filter((w) => w.type === "SectionHeadingWeft")).toHaveLength(3)
  })

  it("determinism — identical input yields identical output", () => {
    const a = classify(["## A", "intro", "=>", "x = 1"])
    const b = classify(["## A", "intro", "=>", "x = 1"])
    expect(types(a)).toEqual(types(b))
    expect(a.map((w) => w.health.status)).toEqual(b.map((w) => w.health.status))
  })
})
