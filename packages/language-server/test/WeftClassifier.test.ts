import { describe, expect, it } from "@effect/vitest"
import { Chunk, Effect, Stream } from "effect"
import type { LineRange } from "#ast/LineRanges"
import { incompleteHealth, okHealth } from "#ast/LoomNode"
import { WeftClassifier } from "#ast/WeftClassifier"
import type { LoomWeft } from "#ast/Weft"

// =============================================================================
// Test harness — feed the classifier multi-line input via its Service and
// collect the LoomWefts. Driving the public Service (rather than reaching
// into private functions) exercises the full pipeline: mapAccum carrying
// Option<LoomWeft>, modeOf derivation, probeOf, the decision table.
//
// The Classifier Stage emits the following set of LoomWefts:
//   HeadingWeft, ArrowWeft, TildeWeft, PreambleWeft, CodeWeft, ProseWeft.
//
// There is ONE heading kind — HeadingWeft — for every `#{1,6}` line
// regardless of level or tag content. There is no `orphan` mode and no
// default `Weft` kind: lines before the first heading are Document Preamble
// PreambleWefts. Arrow / Tilde transitions begin only within a Section
// (after a heading). The de-dicto (frame) vs de-re (product) distinction
// rides on the Specifier token at Synth time.
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
// Document Preamble — lines before the first heading.
//
// The document opens in preamble mode with seenHeading=false. Every
// non-heading line — including Arrow (`=>`) and Tilde (`~`) lines — is a
// PreambleWeft. No Arrow / Tilde transition fires in the Document Preamble.
// =============================================================================

describe("Document Preamble — pre-heading lines", () => {
  it("a plain line before any heading → PreambleWeft", () => {
    expect(classify(["just text"])[0].type).toBe("PreambleWeft")
  })

  it("`=>` before any heading → PreambleWeft (no transition)", () => {
    expect(classify(["=>"])[0].type).toBe("PreambleWeft")
  })

  it("`~` before any heading → PreambleWeft (no transition)", () => {
    expect(classify(["~"])[0].type).toBe("PreambleWeft")
  })

  it("multiple pre-heading lines all → PreambleWeft", () => {
    const out = classify(["first", "second", "third"])
    expect(types(out)).toEqual(["PreambleWeft", "PreambleWeft", "PreambleWeft"])
  })

  it("mix of plain, `=>`, and `~` before any heading → all PreambleWeft", () => {
    const out = classify(["intro", "=>", "~", "more prose"])
    expect(types(out)).toEqual([
      "PreambleWeft",
      "PreambleWeft",
      "PreambleWeft",
      "PreambleWeft",
    ])
  })

  it("Document Preamble PreambleWefts carry incompleteHealth", () => {
    const out = classify(["pre-heading prose"])
    expect(out[0].health).toEqual(incompleteHealth)
  })
})

// =============================================================================
// State axis — modeOf via output type.
//
// The Mealy property "output is next state" means the type of the previous
// Weft determines the mode for the next line. Each mode-defining Weft is
// verified to drive the next plain line to the expected kind.
// =============================================================================

describe("modeOf — state axis (prev Weft → mode → next leaf)", () => {
  it("HeadingWeft → preamble → PreambleWeft", () => {
    const out = classify(["# Title", "intro line"])
    expect(out[1].type).toBe("PreambleWeft")
  })

  it("level-2 HeadingWeft → preamble → PreambleWeft", () => {
    const out = classify(["## Section", "intro line"])
    expect(out[1].type).toBe("PreambleWeft")
  })

  it("PreambleWeft → preamble (sticky) → PreambleWeft", () => {
    const out = classify(["## Section", "first preamble", "more preamble"])
    expect(out[2].type).toBe("PreambleWeft")
  })

  it("ArrowWeft → code → CodeWeft", () => {
    const out = classify(["## Section", "=>", "x = 1"])
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
})

// =============================================================================
// Heading probe — mode-independent; one kind for all levels `#{1,6}`.
//
// The heading probe /^#{1,6} / fires regardless of current mode. Every
// heading line → HeadingWeft, opening the new Section's body in preamble
// mode.
// =============================================================================

describe("Heading — mode-independent, all levels → HeadingWeft", () => {
  const modePrelude: Record<string, ReadonlyArray<string>> = {
    preamble: ["## A"],
    code:     ["## A", "=>"],
    prose:    ["## A", "~"],
  }

  for (const [mode, prelude] of Object.entries(modePrelude)) {
    it(`heading probe wins from mode=${mode}`, () => {
      const out = classify([...prelude, "# Title"])
      expect(last(out).type).toBe("HeadingWeft")
    })
  }

  it("`# X` (level 1) → HeadingWeft", () => {
    expect(classify(["# Hello"])[0].type).toBe("HeadingWeft")
  })

  it("`## X` (level 2) → HeadingWeft", () => {
    expect(classify(["## Hello"])[0].type).toBe("HeadingWeft")
  })

  it("`### X` (level 3) → HeadingWeft", () => {
    expect(classify(["### Hello"])[0].type).toBe("HeadingWeft")
  })

  it("`###### X` (level 6) → HeadingWeft", () => {
    expect(classify(["###### Hello"])[0].type).toBe("HeadingWeft")
  })

  it("heading from document preamble (before any previous heading) → HeadingWeft", () => {
    // No prior heading — seenHeading is false, but heading probe fires first
    expect(classify(["# First"])[0].type).toBe("HeadingWeft")
  })
})

// =============================================================================
// Decision table — mode-gated transitions.
//
// After the first heading, Arrow and Tilde lines drive mode transitions.
// The table: preamble→Arrow→ArrowWeft; preamble→Tilde→TildeWeft;
//            code→Tilde→TildeWeft; code→arrow→CodeWeft (no re-fire);
//            prose→anything→ProseWeft (terminal).
// =============================================================================

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

  it("preamble + plain → PreambleWeft", () => {
    const out = classify(["# A", "just a line"])
    expect(last(out).type).toBe("PreambleWeft")
  })

  it("code + plain → CodeWeft", () => {
    const out = classify(["# A", "=>", "let x = 1"])
    expect(last(out).type).toBe("CodeWeft")
  })

  it("prose + plain → ProseWeft", () => {
    const out = classify(["# A", "~", "some text"])
    expect(last(out).type).toBe("ProseWeft")
  })
})

// =============================================================================
// Health status — all Classifier-Stage wefts carry incompleteHealth.
//
// The Tokeniser Stage settles health to ok/error/warning. The only okHealth
// values the Classifier emits are on the leading marker tokens themselves
// (headingStart, arrow, tilde) — not on the wefts.
// =============================================================================

describe("Health status", () => {
  it("HeadingWeft is incompleteHealth (texts/tag/specifier pending Tokeniser)", () => {
    const out = classify(["# Title"])
    expect(out[0].health).toEqual(incompleteHealth)
  })

  it("HeadingWeft (level 2+) is incompleteHealth", () => {
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

  it("PreambleWeft is incompleteHealth (Tokeniser settles to ok)", () => {
    const out = classify(["## A", "intro"])
    expect(last(out).health).toEqual(incompleteHealth)
  })

  it("PreambleWeft in Document Preamble is incompleteHealth", () => {
    const out = classify(["before any heading"])
    expect(out[0].health).toEqual(incompleteHealth)
  })

  it("ProseWeft is incompleteHealth (Tokeniser settles to ok)", () => {
    const out = classify(["## A", "~", "prose"])
    expect(last(out).health).toEqual(incompleteHealth)
  })

  it("CodeWeft is incompleteHealth (Tokeniser settles after scanning anchors)", () => {
    const out = classify(["## A", "=>", "let x = 1"])
    expect(last(out).health).toEqual(incompleteHealth)
  })
})

// =============================================================================
// Subtoken health — marker tokens on HeadingWeft, ArrowWeft, TildeWeft.
//
// The leading marker token (headingStart, arrow, tilde) is assembled from
// real source bytes by the Classifier and carries okHealth. Its position
// spans the marker itself: hashes + trailing space for headingStart, `=>`
// for arrow, the tilde run for tilde.
// =============================================================================

describe("Subtoken health — marker tokens", () => {
  it("HeadingWeft.headingStart spans `# ` (level-1: 1 hash + space = offsets 0..2)", () => {
    const out = classify(["# Title"])
    const w = out[0]
    if (w.type !== "HeadingWeft") throw new Error("expected HeadingWeft")
    expect(w.headingStart.health).toEqual(okHealth)
    expect(w.headingStart.position.start.offset).toBe(0)
    expect(w.headingStart.position.end.offset).toBe(2)
  })

  it("HeadingWeft.headingStart spans `## ` (level-2: 2 hashes + space = offsets 0..3)", () => {
    const out = classify(["## Section"])
    const w = out[0]
    if (w.type !== "HeadingWeft") throw new Error("expected HeadingWeft")
    expect(w.headingStart.health).toEqual(okHealth)
    expect(w.headingStart.position.start.offset).toBe(0)
    expect(w.headingStart.position.end.offset).toBe(3)
  })

  it("HeadingWeft.headingStart spans `### ` (level-3: offsets 0..4)", () => {
    const out = classify(["### Deep"])
    const w = out[0]
    if (w.type !== "HeadingWeft") throw new Error("expected HeadingWeft")
    expect(w.headingStart.health).toEqual(okHealth)
    expect(w.headingStart.position.start.offset).toBe(0)
    expect(w.headingStart.position.end.offset).toBe(4)
  })

  it("HeadingWeft.headingStart spans `###### ` (level-6: offsets 0..7)", () => {
    const out = classify(["###### Deep"])
    const w = out[0]
    if (w.type !== "HeadingWeft") throw new Error("expected HeadingWeft")
    expect(w.headingStart.health).toEqual(okHealth)
    expect(w.headingStart.position.start.offset).toBe(0)
    expect(w.headingStart.position.end.offset).toBe(7)
  })

  it("ArrowToken (real marker) carries okHealth", () => {
    const out = classify(["## A", "=>"])
    const w = out[1]
    if (w.type !== "ArrowWeft") throw new Error("expected ArrowWeft")
    expect(w.arrow.health).toEqual(okHealth)
  })

  it("TildeToken (real marker) carries okHealth", () => {
    const out = classify(["## A", "~~~"])
    const w = out[1]
    if (w.type !== "TildeWeft") throw new Error("expected TildeWeft")
    expect(w.tilde.health).toEqual(okHealth)
  })
})

// =============================================================================
// HeadingWeft at Classifier Stage — no NOK placeholders for tag/specifier.
//
// The Classifier does NOT emit tag or specifier placeholders. Both fields are
// optional in HeadingWeftSchema; the Tokeniser fills them from source.
// The `texts` array is emitted as `[]` (empty) — the Tokeniser populates it.
// =============================================================================

describe("HeadingWeft at Classifier Stage — minimal, no placeholders", () => {
  it("tag is absent on the emitted HeadingWeft (Tokeniser fills it)", () => {
    const out = classify(["# Title [Tag]"])
    const w = out[0]
    if (w.type !== "HeadingWeft") throw new Error("expected HeadingWeft")
    expect(w.tag).toBeUndefined()
  })

  it("specifier is absent on the emitted HeadingWeft (Tokeniser fills it)", () => {
    const out = classify(["# Title {Lang}"])
    const w = out[0]
    if (w.type !== "HeadingWeft") throw new Error("expected HeadingWeft")
    expect(w.specifier).toBeUndefined()
  })

  it("title is absent on the emitted HeadingWeft (Tokeniser fills it)", () => {
    const out = classify(["# Some Title"])
    const w = out[0]
    if (w.type !== "HeadingWeft") throw new Error("expected HeadingWeft")
    expect(w.title).toBeUndefined()
  })

  it("headingStart is present and okHealth — the only filled field", () => {
    const out = classify(["## Greet [Greet]"])
    const w = out[0]
    if (w.type !== "HeadingWeft") throw new Error("expected HeadingWeft")
    expect(w.headingStart).toBeDefined()
    expect(w.headingStart.health).toEqual(okHealth)
  })
})

// =============================================================================
// Heading classification — all levels, any tag content → one HeadingWeft.
// =============================================================================

describe("Heading classification — uniform across levels and content", () => {
  it("`# Greet [Greet]` → HeadingWeft", () => {
    expect(classify(["# Greet [Greet]"])[0].type).toBe("HeadingWeft")
  })

  it("`## Greet [Greet]` → HeadingWeft", () => {
    expect(classify(["## Greet [Greet]"])[0].type).toBe("HeadingWeft")
  })

  it("`## Plain heading` → HeadingWeft", () => {
    expect(classify(["## Plain heading"])[0].type).toBe("HeadingWeft")
  })

  it("`## Deps {Loom}` → HeadingWeft (Specifier on the heading is just a token)", () => {
    expect(classify(["## Deps {Loom}"])[0].type).toBe("HeadingWeft")
  })

  it("`## Multi [Greet] [Reply]` → HeadingWeft (multi-tag is just data)", () => {
    expect(classify(["## Multi [Greet] [Reply]"])[0].type).toBe("HeadingWeft")
  })
})

// =============================================================================
// Mealy chain — multi-line transitions exercising the full table.
// =============================================================================

describe("Mealy chain — output IS next state", () => {
  it("classifies a typical document with heading, preamble, code, and prose runs", () => {
    const out = classify([
      "# HonoHello",                    // HeadingWeft
      "intro prose",                    // PreambleWeft
      "## Greeting [Greet]",            // HeadingWeft
      "preamble line",                  // PreambleWeft
      "=>",                             // ArrowWeft → switches to code
      "app.get('/', () => 'hi')",       // CodeWeft
      "~",                              // TildeWeft → switches to prose
      "now we describe it",             // ProseWeft
    ])
    expect(types(out)).toEqual([
      "HeadingWeft",
      "PreambleWeft",
      "HeadingWeft",
      "PreambleWeft",
      "ArrowWeft",
      "CodeWeft",
      "TildeWeft",
      "ProseWeft",
    ])
  })

  it("document preamble lines (including `=>` and `~`) become PreambleWefts", () => {
    const out = classify([
      "{{lang: Scala}}",                // PreambleWeft (Document Preamble)
      "=>",                             // PreambleWeft (no heading yet)
      "~",                              // PreambleWeft (no heading yet)
      "# First Section",               // HeadingWeft (now seenHeading=true)
      "=>",                             // ArrowWeft (inside section)
    ])
    expect(types(out)).toEqual([
      "PreambleWeft",
      "PreambleWeft",
      "PreambleWeft",
      "HeadingWeft",
      "ArrowWeft",
    ])
  })

  it("`{Loom}` sections behave like any other section (preamble + arrow + code admitted)", () => {
    const out = classify([
      "## Deps {Loom}",
      "Some preamble.",
      "=>",
      "needs(ScalaToolchain)",
    ])
    expect(types(out)).toEqual([
      "HeadingWeft",
      "PreambleWeft",
      "ArrowWeft",
      "CodeWeft",
    ])
  })

  it("any heading resets to preamble mode for the next line", () => {
    // Walk through preamble → code → heading (reset) → prose → heading (reset).
    const out = classify([
      "## A", "preamble",               // preamble
      "=>", "code",                     // code
      "## B",                           // reset from code → HeadingWeft
      "~", "prose",                     // prose
      "## C",                           // reset from prose → HeadingWeft
    ])
    expect(out.filter((w) => w.type === "HeadingWeft")).toHaveLength(3)
  })

  it("heading after code mode transitions back to preamble (not code)", () => {
    const out = classify([
      "## A", "=>", "x = 1",           // code mode
      "## B",                           // HeadingWeft → preamble
      "intro",                          // PreambleWeft (not CodeWeft)
    ])
    expect(last(out).type).toBe("PreambleWeft")
  })

  it("heading after prose mode transitions back to preamble (not prose)", () => {
    const out = classify([
      "## A", "~", "prose text",       // prose mode
      "## B",                           // HeadingWeft → preamble
      "intro",                          // PreambleWeft (not ProseWeft)
    ])
    expect(last(out).type).toBe("PreambleWeft")
  })

  it("determinism — identical input yields identical output", () => {
    const a = classify(["## A", "intro", "=>", "x = 1"])
    const b = classify(["## A", "intro", "=>", "x = 1"])
    expect(types(a)).toEqual(types(b))
    expect(a.map((w) => w.health.status)).toEqual(b.map((w) => w.health.status))
  })
})
