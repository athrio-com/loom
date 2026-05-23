import { describe, expect, it } from "@effect/vitest"
import { Chunk, Effect, Stream } from "effect"
import type { LineRange } from "./LineRanges"
import { okHealth } from "./LoomNode"
import { WeftClassifier } from "./WeftClassifier"
import { WeftTokeniser } from "./WeftTokeniser"
import type { LoomWeft } from "./Weft"

// =============================================================================
// Harness — drive lines through Classifier → Tokeniser and collect the
// emitted wefts. Both stages run; the tests assert on the post-Tokeniser
// output, which is what consumers downstream of the Tokeniser see.
// =============================================================================

const tokenise = (lines: ReadonlyArray<string>): ReadonlyArray<LoomWeft> => {
  const text = lines.join("\n")
  const ranges: LineRange[] = []
  let offset = 0
  for (const line of lines) {
    ranges.push([offset, offset + line.length] as const)
    offset += line.length + 1
  }
  return Effect.runSync(
    Effect.gen(function* () {
      const classifier = yield* WeftClassifier
      const tokeniser = yield* WeftTokeniser
      const source = Stream.fromIterable(ranges)
      const classified = classifier.classifyWefts(text)(source)
      const stream = tokeniser.tokeniseWefts(text)(classified)
      const chunk = yield* Stream.runCollect(stream)
      return Chunk.toReadonlyArray(chunk)
    }).pipe(
      Effect.provide(WeftClassifier.Default),
      Effect.provide(WeftTokeniser.Default),
    ),
  )
}

const headingAt = (out: ReadonlyArray<LoomWeft>, idx: number) => {
  const w = out[idx]
  if (
    w.type !== "ChapterHeadingWeft"
    && w.type !== "SectionHeadingWeft"
    && w.type !== "DependenciesHeadingWeft"
    && w.type !== "TangleHeadingWeft"
  ) {
    throw new Error(`expected a heading at index ${idx}, got ${w.type}`)
  }
  return w
}

// =============================================================================
// Scanning + construction — happy paths. Tag and Specifier tokens are built
// from anchor matches, their subnodes carry real source positions and ok
// health, label values are extracted from the source slice.
// =============================================================================

describe("Tokeniser — scanning + construction (happy paths)", () => {
  it("fills a tag's open/label/close subnodes from a `[Foo]` source", () => {
    const out = tokenise(["## Section [Foo]"])
    const w = headingAt(out, 0)
    if (w.type !== "SectionHeadingWeft") throw new Error()
    expect(w.tag?.open.value).toBe("[")
    expect(w.tag?.label.value).toBe("Foo")
    expect(w.tag?.close.value).toBe("]")
    expect(w.tag?.open.health).toEqual(okHealth)
    expect(w.tag?.label.health).toEqual(okHealth)
    expect(w.tag?.close.health).toEqual(okHealth)
  })

  it("places tag subnode positions at real source offsets", () => {
    // "## Section [Foo]" — `[` at index 11, `]` at index 15.
    const out = tokenise(["## Section [Foo]"])
    const w = headingAt(out, 0)
    if (w.type !== "SectionHeadingWeft") throw new Error()
    expect(w.tag?.open.position.start.offset).toBe(11)
    expect(w.tag?.open.position.end.offset).toBe(12)
    expect(w.tag?.close.position.start.offset).toBe(15)
    expect(w.tag?.close.position.end.offset).toBe(16)
    expect(w.tag?.label.position.start.offset).toBe(12)
    expect(w.tag?.label.position.end.offset).toBe(15)
  })

  it("fills a specifier's open/label/close subnodes from a `{Lang}` source", () => {
    const out = tokenise(["# Title [App]{TypeScript}"])
    const w = headingAt(out, 0)
    if (w.type !== "ChapterHeadingWeft") throw new Error()
    expect(w.specifier?.open.value).toBe("{")
    expect(w.specifier?.label.value).toBe("TypeScript")
    expect(w.specifier?.close.value).toBe("}")
    expect(w.specifier?.open.health).toEqual(okHealth)
    expect(w.specifier?.label.health).toEqual(okHealth)
    expect(w.specifier?.close.health).toEqual(okHealth)
  })

  it("aggregates tag/specifier subnode health into the weft", () => {
    const out = tokenise(["# Title [App]{TypeScript}"])
    expect(out[0].health.status).toBe("ok")
  })
})

// =============================================================================
// ChapterHeading — schema requires tag and specifier. The Tokeniser
// replaces the Classifier's NOK placeholders with real tokens when the
// source provides them; otherwise the placeholders remain.
// =============================================================================

describe("Tokeniser — ChapterHeading", () => {
  it("replaces Classifier NOK placeholders with real tag and specifier", () => {
    const out = tokenise(["# Title [App]{TypeScript}"])
    const w = headingAt(out, 0)
    if (w.type !== "ChapterHeadingWeft") throw new Error()
    expect(w.tag?.label.value).toBe("App")
    expect(w.specifier?.label.value).toBe("TypeScript")
    expect(w.tag?.health.status).toBe("ok")
    expect(w.specifier?.health.status).toBe("ok")
  })

  it("synthesises an error-health tag when source provides none", () => {
    const out = tokenise(["# Title"])
    const w = headingAt(out, 0)
    if (w.type !== "ChapterHeadingWeft") throw new Error()
    expect(w.tag?.health.status).toBe("error")
    expect(w.tag?.health.diagnostics[0].message).toMatch(/requires a tag/i)
    // Synthetic tag sits at a zero-width EOL position.
    expect(w.tag?.position.start.offset).toBe(w.position.end.offset)
    expect(w.tag?.position.end.offset).toBe(w.position.end.offset)
  })

  it("synthesises an error-health specifier when source provides none", () => {
    const out = tokenise(["# Title"])
    const w = headingAt(out, 0)
    if (w.type !== "ChapterHeadingWeft") throw new Error()
    expect(w.specifier?.health.status).toBe("error")
    expect(w.specifier?.health.diagnostics[0].message).toMatch(/requires a specifier/i)
  })

  it("synth-only ChapterHeading rolls up to error health (never incomplete)", () => {
    const out = tokenise(["# Title"])
    expect(out[0].health.status).toBe("error")
  })

  it("partial source (tag only) → real tag + synth specifier + error weft", () => {
    const out = tokenise(["# Title [App]"])
    const w = headingAt(out, 0)
    if (w.type !== "ChapterHeadingWeft") throw new Error()
    expect(w.tag?.label.value).toBe("App")
    expect(w.tag?.health.status).toBe("ok")
    expect(w.specifier?.health.status).toBe("error")
    expect(w.specifier?.health.diagnostics[0].message).toMatch(/requires a specifier/i)
    expect(w.health.status).toBe("error")
  })

  it("post-Tokeniser ChapterHeading is never `incomplete`", () => {
    // Across the full matrix of presence/absence, the weft is ok or error,
    // never incomplete. The Tokeniser is the authority after Classifier Stage.
    for (const line of ["# Title", "# Title [App]", "# Title {TS}", "# Title [App]{TS}"]) {
      expect(tokenise([line])[0].health.status).not.toBe("incomplete")
    }
  })
})

// =============================================================================
// SectionHeading — schema makes tag and specifier optional. Promotion to
// Deps/Tangle is attempted when exactly one reserved-label tag is present
// and no specifier; otherwise the weft stays as SectionHeading.
// =============================================================================

describe("Tokeniser — SectionHeading promotion", () => {
  it("promotes `## … [D]` to DependenciesHeadingWeft", () => {
    const out = tokenise(["## Deps [D]"])
    expect(out[0].type).toBe("DependenciesHeadingWeft")
  })

  it("promotes `## … [T]` to TangleHeadingWeft", () => {
    const out = tokenise(["## Tangle [T]"])
    expect(out[0].type).toBe("TangleHeadingWeft")
  })

  it("non-reserved single tag → stays SectionHeadingWeft with the tag filled", () => {
    const out = tokenise(["## Section [Greet]"])
    const w = headingAt(out, 0)
    if (w.type !== "SectionHeadingWeft") throw new Error()
    expect(w.tag?.label.value).toBe("Greet")
  })

  it("a single tag + a specifier blocks promotion (Deps/Tangle have no specifier slot)", () => {
    const out = tokenise(["## Section [D]{TypeScript}"])
    expect(out[0].type).toBe("SectionHeadingWeft")
  })

  it("no tags → stays SectionHeadingWeft with undefined tag", () => {
    const out = tokenise(["## Plain heading"])
    const w = headingAt(out, 0)
    if (w.type !== "SectionHeadingWeft") throw new Error()
    expect(w.tag).toBeUndefined()
  })

  it("promoted Deps weft's tag has label value 'D'", () => {
    const out = tokenise(["## Deps [D]"])
    const w = out[0]
    if (w.type !== "DependenciesHeadingWeft") throw new Error()
    expect(w.tag.label.value).toBe("D")
  })
})

// =============================================================================
// Multi-tag / multi-specifier — extras land on `weft.unexpected[]` and the
// weft's aggregated health flips to error.
// =============================================================================

describe("Tokeniser — multi-tag / multi-specifier", () => {
  it("multi-tag section captures extras as UnexpectedToken on the weft", () => {
    const out = tokenise(["## Multi [D] [T]"])
    const w = headingAt(out, 0)
    if (w.type !== "SectionHeadingWeft") throw new Error()
    expect(w.unexpected).toBeDefined()
    expect(w.unexpected!.length).toBeGreaterThan(0)
  })

  it("multi-tag heading promotes neither to Deps nor Tangle", () => {
    expect(tokenise(["## Multi [D] [T]"])[0].type).toBe("SectionHeadingWeft")
    expect(tokenise(["## Multi [T] [D]"])[0].type).toBe("SectionHeadingWeft")
    expect(tokenise(["## Multi [D] [D]"])[0].type).toBe("SectionHeadingWeft")
  })

  it("first tag still becomes the weft's `tag`; extras go to unexpected", () => {
    const out = tokenise(["## Multi [First] [Second]"])
    const w = headingAt(out, 0)
    if (w.type !== "SectionHeadingWeft") throw new Error()
    expect(w.tag?.label.value).toBe("First")
    expect(w.unexpected?.length).toBeGreaterThan(0)
  })

  it("unexpected entries flip weft health to error via aggregation", () => {
    const out = tokenise(["## Multi [D] [T]"])
    expect(out[0].health.status).toBe("error")
  })

  it("multi-specifier captures extras as UnexpectedToken", () => {
    const out = tokenise(["# Title [App]{One}{Two}"])
    const w = headingAt(out, 0)
    if (w.type !== "ChapterHeadingWeft") throw new Error()
    expect(w.unexpected).toBeDefined()
    expect(w.unexpected!.length).toBeGreaterThan(0)
    expect(w.health.status).toBe("error")
  })
})

// =============================================================================
// Synthetic close — `[` without a matching `]` on the same line. The
// resulting Tag still has structure (open + label + synthetic close at EOL),
// but `close.health.status === "error"` with a "missing `]`" diagnostic, and
// the parent Tag's aggregated health follows.
// =============================================================================

describe("Tokeniser — synthetic close (unclosed bracket)", () => {
  it("unclosed `[` produces a Tag with synthetic close at EOL", () => {
    const out = tokenise(["## Section [Foo"])
    const w = headingAt(out, 0)
    if (w.type !== "SectionHeadingWeft") throw new Error()
    // line `## Section [Foo` is 15 chars long; close should be at 15..15.
    expect(w.tag?.close.position.start.offset).toBe(15)
    expect(w.tag?.close.position.end.offset).toBe(15)
  })

  it("synthetic close carries error health with a 'missing `]`' diagnostic", () => {
    const out = tokenise(["## Section [Foo"])
    const w = headingAt(out, 0)
    if (w.type !== "SectionHeadingWeft") throw new Error()
    expect(w.tag?.close.health.status).toBe("error")
    expect(w.tag?.close.health.diagnostics[0].message).toMatch(/expected closing/i)
  })

  it("Tag with synthetic close has its own health aggregated to error", () => {
    const out = tokenise(["## Section [Foo"])
    const w = headingAt(out, 0)
    if (w.type !== "SectionHeadingWeft") throw new Error()
    expect(w.tag?.health.status).toBe("error")
  })

  it("unclosed `{` produces a Specifier with synthetic close + error health", () => {
    const out = tokenise(["# Title [App]{Lang"])
    const w = headingAt(out, 0)
    if (w.type !== "ChapterHeadingWeft") throw new Error()
    expect(w.specifier?.close.health.status).toBe("error")
    expect(w.specifier?.close.health.diagnostics[0].message).toMatch(/expected closing/i)
  })
})

// =============================================================================
// Label validation — malformed label values are kept in the AST via the
// synthetic-empty + UnexpectedToken mechanism. The schema's cross-field
// filter admits empty `value` only when health is NOK.
// =============================================================================

describe("Tokeniser — malformed label values", () => {
  it("label with a space gets error health, value `\"\"`, and bad text in unexpected", () => {
    const out = tokenise(["## Section [has space]"])
    const w = headingAt(out, 0)
    if (w.type !== "SectionHeadingWeft") throw new Error()
    expect(w.tag?.label.health.status).toBe("error")
    expect(w.tag?.label.value).toBe("")
    expect(w.tag?.label.unexpected?.[0].value).toBe("has space")
  })

  it("label with a dot fails the pattern and lands in unexpected", () => {
    const out = tokenise(["## Section [foo.bar]"])
    const w = headingAt(out, 0)
    if (w.type !== "SectionHeadingWeft") throw new Error()
    expect(w.tag?.label.health.status).toBe("error")
    expect(w.tag?.label.unexpected?.[0].value).toBe("foo.bar")
  })

  it("malformed label propagates error to the Tag and to the weft", () => {
    const out = tokenise(["## Section [bad space]"])
    const w = headingAt(out, 0)
    if (w.type !== "SectionHeadingWeft") throw new Error()
    expect(w.tag?.health.status).toBe("error")
    expect(w.health.status).toBe("error")
  })

  it("malformed Specifier label also routes the bad text to unexpected", () => {
    const out = tokenise(["# Title [App]{bad lang}"])
    const w = headingAt(out, 0)
    if (w.type !== "ChapterHeadingWeft") throw new Error()
    expect(w.specifier?.label.health.status).toBe("error")
    expect(w.specifier?.label.value).toBe("")
    expect(w.specifier?.label.unexpected?.[0].value).toBe("bad lang")
  })
})

// =============================================================================
// Text gaps — heading text between structural anchors (after the marker's
// trailing space) becomes TextTokens.
// =============================================================================

describe("Tokeniser — text gaps", () => {
  it("emits a TextToken for the text before the tag", () => {
    const out = tokenise(["## Title here [Tag]"])
    const w = headingAt(out, 0)
    if (w.type !== "SectionHeadingWeft") throw new Error()
    expect(w.texts.length).toBeGreaterThan(0)
    // Marker `## ` ends at offset 3; tag opens at 14. Gap is [3..14).
    expect(w.texts[0].position.start.offset).toBe(3)
    expect(w.texts[0].position.end.offset).toBe(14)
  })

  it("emits text between tag and specifier", () => {
    const out = tokenise(["# Title [App]{TypeScript}"])
    const w = headingAt(out, 0)
    if (w.type !== "ChapterHeadingWeft") throw new Error()
    // `# ` ends at offset 2; tag is at 8..13; specifier at 13..25.
    // The gap before the tag is "Title " (offsets 2..8) and there's no gap
    // between tag (13) and specifier (13) since they're adjacent.
    expect(w.texts.length).toBeGreaterThanOrEqual(1)
    expect(w.texts[0].position.start.offset).toBe(2)
  })

  it("no text gap when heading has only the marker and anchors", () => {
    const out = tokenise(["## [Tag]"])
    const w = headingAt(out, 0)
    if (w.type !== "SectionHeadingWeft") throw new Error()
    expect(w.texts.length).toBe(0)
  })
})

// =============================================================================
// Pass-through — wefts the Tokeniser doesn't yet handle survive unchanged.
// =============================================================================

describe("Tokeniser — body weft kinds preserved (outside Deps/Tangle)", () => {
  it("Weft, PreambleWeft, ArrowWeft, CodeWeft, TildeWeft, ProseWeft survive their kind", () => {
    const out = tokenise([
      "pre-chapter line",  // Weft
      "# Title [App]{TS}", // ChapterHeading (tokenised)
      "intro",             // PreambleWeft
      "=>",                // ArrowWeft
      "x = 1",             // CodeWeft
      "~",                 // TildeWeft
      "prose",             // ProseWeft
    ])
    expect(out.map((w) => w.type)).toEqual([
      "Weft",
      "ChapterHeadingWeft",
      "PreambleWeft",
      "ArrowWeft",
      "CodeWeft",
      "TildeWeft",
      "ProseWeft",
    ])
  })
})

// =============================================================================
// Body weft tokenisation — Arrow / Tilde fill optional inline subtokens
// (code / prose) from the source; Preamble / Prose flip health to ok
// (structural-final at this stage). Post-Tokeniser, no body weft should
// remain `incomplete`.
// =============================================================================

describe("Tokeniser — body weft subtoken expansion", () => {
  it("ArrowWeft with inline code fills the `code` subtoken at the right position", () => {
    const out = tokenise(["## A", "=> let x = 1"])
    const w = out[1]
    if (w.type !== "ArrowWeft") throw new Error("expected ArrowWeft")
    expect(w.code).toBeDefined()
    expect(w.code!.health.status).toBe("ok")
    // Line "=> let x = 1" starts at offset 5 (after "## A\n"); the code
    // segment "let x = 1" starts at offset 5 + 3 = 8.
    expect(w.code!.position.start.offset).toBe(8)
    expect(w.code!.position.end.offset).toBe(17)
  })

  it("ArrowWeft without inline code leaves `code` undefined", () => {
    const out = tokenise(["## A", "=>"])
    const w = out[1]
    if (w.type !== "ArrowWeft") throw new Error("expected ArrowWeft")
    expect(w.code).toBeUndefined()
  })

  it("TildeWeft with inline prose fills the `prose` subtoken", () => {
    const out = tokenise(["## A", "~ a note"])
    const w = out[1]
    if (w.type !== "TildeWeft") throw new Error("expected TildeWeft")
    expect(w.prose).toBeDefined()
    expect(w.prose!.health.status).toBe("ok")
  })

  it("TildeWeft without inline prose leaves `prose` undefined", () => {
    const out = tokenise(["## A", "~"])
    const w = out[1]
    if (w.type !== "TildeWeft") throw new Error("expected TildeWeft")
    expect(w.prose).toBeUndefined()
  })

  it("post-Tokeniser ArrowWeft health is ok", () => {
    expect(tokenise(["## A", "=>"])[1].health.status).toBe("ok")
    expect(tokenise(["## A", "=> let x = 1"])[1].health.status).toBe("ok")
  })

  it("post-Tokeniser TildeWeft health is ok", () => {
    expect(tokenise(["## A", "~"])[1].health.status).toBe("ok")
    expect(tokenise(["## A", "~ note"])[1].health.status).toBe("ok")
  })

  it("post-Tokeniser PreambleWeft health flips from incomplete to ok", () => {
    const out = tokenise(["## A", "preamble line"])
    expect(out[1].type).toBe("PreambleWeft")
    expect(out[1].health.status).toBe("ok")
  })

  it("post-Tokeniser ProseWeft health flips from incomplete to ok", () => {
    const out = tokenise(["## A", "~", "prose line"])
    expect(out[2].type).toBe("ProseWeft")
    expect(out[2].health.status).toBe("ok")
  })

  it("post-Tokeniser body wefts are never `incomplete`", () => {
    const out = tokenise([
      "# Title [App]{TS}",
      "intro preamble",
      "=>",
      "x = 1",
      "=> let y",
      "~",
      "trailing prose",
      "~~~ note",
    ])
    for (const w of out) {
      expect(w.health.status).not.toBe("incomplete")
    }
  })
})

// =============================================================================
// Body re-typing inside Deps / Tangle sections — Stage 1 re-types body wefts
// to opaque DependencyWeft / TangleWeft before any inner-content tokenisation
// happens, so we never tokenise an ArrowWeft only to discard it.
// =============================================================================

describe("Tokeniser — Stage 1 body re-typing inside Deps / Tangle", () => {
  it("PreambleWeft inside Deps section becomes opaque DependencyWeft", () => {
    const out = tokenise(["## Deps [D]", "import { Hono }"])
    expect(out[0].type).toBe("DependenciesHeadingWeft")
    expect(out[1].type).toBe("DependencyWeft")
  })

  it("PreambleWeft inside Tangle section becomes opaque TangleWeft", () => {
    const out = tokenise(["## Tangle [T]", "compose(App)"])
    expect(out[0].type).toBe("TangleHeadingWeft")
    expect(out[1].type).toBe("TangleWeft")
  })

  it("ArrowWeft / CodeWeft inside Deps are absorbed as opaque DependencyWeft (no inner tokenisation)", () => {
    const out = tokenise(["## Deps [D]", "=>", "import X"])
    expect(out.map((w) => w.type)).toEqual([
      "DependenciesHeadingWeft",
      "DependencyWeft",
      "DependencyWeft",
    ])
  })

  it("re-typed DependencyWeft / TangleWeft carry okHealth (opaque per design)", () => {
    const out = tokenise(["## Deps [D]", "import X"])
    expect(out[1].health.status).toBe("ok")
    const out2 = tokenise(["## Tangle [T]", "compose(X)"])
    expect(out2[1].health.status).toBe("ok")
  })

  it("re-typed DependencyWeft / TangleWeft preserve the source position", () => {
    // Line 2 is "import X" — offsets 12..20 in the combined source.
    const out = tokenise(["## Deps [D]", "import X"])
    expect(out[1].position.start.offset).toBe(12)
    expect(out[1].position.end.offset).toBe(20)
  })

  it("section context resets to `regular` after a non-Deps/Tangle heading", () => {
    const out = tokenise([
      "## Deps [D]",     // → DepsHeading, ctx=deps
      "import X",         // → DependencyWeft
      "## Plain section", // → SectionHeading, ctx=regular
      "preamble",         // → PreambleWeft (NOT DependencyWeft)
    ])
    expect(out.map((w) => w.type)).toEqual([
      "DependenciesHeadingWeft",
      "DependencyWeft",
      "SectionHeadingWeft",
      "PreambleWeft",
    ])
  })

  it("two consecutive Deps sections each re-type their own bodies", () => {
    const out = tokenise([
      "## Deps A [D]", "import A",
      "## Deps B [D]", "import B",
    ])
    expect(out.map((w) => w.type)).toEqual([
      "DependenciesHeadingWeft",
      "DependencyWeft",
      "DependenciesHeadingWeft",
      "DependencyWeft",
    ])
  })

  it("body wefts before any heading (outside context) pass through unchanged", () => {
    const out = tokenise(["loose line"])
    expect(out[0].type).toBe("Weft")
  })
})

// =============================================================================
// Health aggregation — the weft's `health.status` is the worst of its
// subnodes' statuses plus any `unexpected[]` entries (which count as error).
// =============================================================================

describe("Tokeniser — health aggregation", () => {
  it("well-formed heading: weft is ok", () => {
    expect(tokenise(["# Title [App]{TS}"])[0].health.status).toBe("ok")
    expect(tokenise(["## Section [Foo]"])[0].health.status).toBe("ok")
  })

  it("any error subnode flips the weft to error", () => {
    // Synthetic close inside the tag → tag.health is error → weft.health is error.
    expect(tokenise(["## Section [Foo"])[0].health.status).toBe("error")
  })

  it("any unexpected entry flips the weft to error even with ok subnodes", () => {
    // [First] is well-formed; [Second] is extra → unexpected → weft is error.
    expect(tokenise(["## Multi [First] [Second]"])[0].health.status).toBe("error")
  })
})
