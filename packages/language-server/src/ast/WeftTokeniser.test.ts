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
  if (w.type !== "ChapterHeadingWeft" && w.type !== "SectionHeadingWeft") {
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
// SectionHeading — schema makes tag and specifier optional. Every `##…`
// line is a SectionHeadingWeft regardless of tag content; the Specifier-
// driven de-dicto cut happens at Synth time.
// =============================================================================

describe("Tokeniser — SectionHeading", () => {
  it("single tag → SectionHeadingWeft with the tag filled", () => {
    const out = tokenise(["## Section [Greet]"])
    const w = headingAt(out, 0)
    if (w.type !== "SectionHeadingWeft") throw new Error()
    expect(w.tag?.label.value).toBe("Greet")
  })

  it("`[D]` is just a tag like any other (no promotion)", () => {
    const out = tokenise(["## Deps [D]"])
    const w = headingAt(out, 0)
    if (w.type !== "SectionHeadingWeft") throw new Error()
    expect(w.tag?.label.value).toBe("D")
  })

  it("tag + specifier → SectionHeadingWeft with both filled", () => {
    const out = tokenise(["## Section [D]{TypeScript}"])
    const w = headingAt(out, 0)
    if (w.type !== "SectionHeadingWeft") throw new Error()
    expect(w.tag?.label.value).toBe("D")
    expect(w.specifier?.label.value).toBe("TypeScript")
  })

  it("`{Loom}` Specifier is just a token (no special routing at Classifier/Tokeniser)", () => {
    const out = tokenise(["## Deps {Loom}"])
    const w = headingAt(out, 0)
    if (w.type !== "SectionHeadingWeft") throw new Error()
    expect(w.specifier?.label.value).toBe("Loom")
  })

  it("no tags → SectionHeadingWeft with undefined tag", () => {
    const out = tokenise(["## Plain heading"])
    const w = headingAt(out, 0)
    if (w.type !== "SectionHeadingWeft") throw new Error()
    expect(w.tag).toBeUndefined()
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

describe("Tokeniser — body weft kinds preserved", () => {
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
// Warp tokenisation — PreambleWeft hosts `{{name: annotation [= default]}}`
// declarations; ArrowWeft and CodeWeft host `{{name}}` references.
// =============================================================================

describe("Tokeniser — Warp declarations on PreambleWeft", () => {
  const preambleWeft = (line: string) => {
    const out = tokenise(["## A", line])
    const w = out[1]
    if (w.type !== "PreambleWeft") throw new Error(`expected PreambleWeft, got ${w.type}`)
    return w
  }

  it("recognises a single `{{name: annotation}}`", () => {
    const w = preambleWeft("Uses {{mul: Mul}} to multiply.")
    expect(w.warps).toHaveLength(1)
    expect(w.warps[0].name.value).toBe("mul")
    expect(w.warps[0].annotation.value).toBe("Mul")
    expect(w.warps[0].default).toBeUndefined()
    expect(w.warps[0].health.status).toBe("ok")
  })

  it("recognises a declaration with a default", () => {
    const w = preambleWeft(`Port {{port: string = "8080"}}.`)
    expect(w.warps[0].name.value).toBe("port")
    expect(w.warps[0].annotation.value).toBe("string")
    expect(w.warps[0].default?.value).toBe(`"8080"`)
  })

  it("recognises multiple warps on one line", () => {
    const w = preambleWeft("first {{a: A}} then {{b: B}}.")
    expect(w.warps).toHaveLength(2)
    expect(w.warps[0].name.value).toBe("a")
    expect(w.warps[1].name.value).toBe("b")
  })

  it("preserves nested commas inside `<>` brackets in annotation", () => {
    const w = preambleWeft("hold {{r: Record<string, number>}}.")
    expect(w.warps[0].annotation.value).toBe("Record<string, number>")
    expect(w.warps[0].health.status).toBe("ok")
  })

  it("top-level `,` in annotation surfaces as warp.unexpected[]", () => {
    const w = preambleWeft("multi {{a: B, }}.")
    expect(w.warps[0].annotation.value).toBe("B")
    expect(w.warps[0].unexpected).toBeDefined()
    expect(w.warps[0].unexpected![0].value).toBe(", ")
    expect(w.warps[0].health.status).toBe("error")
  })

  it("top-level `;` in annotation surfaces as warp.unexpected[]", () => {
    const w = preambleWeft("{{a: B; C}}")
    expect(w.warps[0].annotation.value).toBe("B")
    expect(w.warps[0].health.status).toBe("error")
  })

  it("missing `:` synthesises an error-health annotation", () => {
    const w = preambleWeft("bad {{onlyName}}")
    expect(w.warps[0].name.value).toBe("onlyName")
    expect(w.warps[0].annotation.value).toBe("")
    expect(w.warps[0].annotation.health.status).toBe("error")
    expect(w.warps[0].health.status).toBe("error")
  })

  it("empty annotation after `:` is error-health", () => {
    const w = preambleWeft("{{a: }}")
    expect(w.warps[0].annotation.value).toBe("")
    expect(w.warps[0].annotation.health.status).toBe("error")
  })

  it("empty default after `=` is error-health (preserves the `=` evidence)", () => {
    const w = preambleWeft("{{a: B = }}")
    expect(w.warps[0].default).toBeDefined()
    expect(w.warps[0].default!.value).toBe("")
    expect(w.warps[0].default!.health.status).toBe("error")
  })

  it("invalid name routes the bad text to name.unexpected[]", () => {
    const w = preambleWeft("{{not-an-id: Tag}}")
    expect(w.warps[0].name.value).toBe("")
    expect(w.warps[0].name.health.status).toBe("error")
    expect(w.warps[0].name.unexpected?.[0].value).toBe("not-an-id")
  })

  it("unclosed `{{` produces a synthetic `}}` at EOL with error health", () => {
    const w = preambleWeft("{{a: B")
    expect(w.warps[0].close.health.status).toBe("error")
    expect(w.warps[0].close.health.diagnostics[0].message).toMatch(/expected closing/i)
  })

  it("stray `}}` becomes weft.unexpected[]", () => {
    const w = preambleWeft("loose }} pair")
    expect(w.warps).toHaveLength(0)
    expect(w.unexpected).toBeDefined()
    expect(w.unexpected![0].value).toBe("}}")
    expect(w.health.status).toBe("error")
  })

  it("post-Tokeniser PreambleWeft is never `incomplete`", () => {
    expect(preambleWeft("plain text").health.status).not.toBe("incomplete")
    expect(preambleWeft("{{a: B}}").health.status).not.toBe("incomplete")
    expect(preambleWeft("{{bad").health.status).not.toBe("incomplete")
  })
})

describe("Tokeniser — WarpAnchor references on ArrowWeft / CodeWeft", () => {
  const codeWeftFromLines = (lines: ReadonlyArray<string>, idx: number) => {
    const out = tokenise(lines)
    const w = out[idx]
    if (w.type !== "CodeWeft") throw new Error(`expected CodeWeft, got ${w.type}`)
    return w
  }

  const arrowWeftFromLine = (line: string) => {
    const out = tokenise(["## A", line])
    const w = out[1]
    if (w.type !== "ArrowWeft") throw new Error(`expected ArrowWeft, got ${w.type}`)
    return w
  }

  it("CodeWeft recognises a single anchor `{{name}}`", () => {
    const w = codeWeftFromLines(["## A", "=>", "use {{mul}} here"], 2)
    expect(w.anchors).toHaveLength(1)
    expect(w.anchors[0].name.value).toBe("mul")
    expect(w.anchors[0].health.status).toBe("ok")
  })

  it("CodeWeft recognises multiple anchors on one line", () => {
    const w = codeWeftFromLines(["## A", "=>", "{{a}} + {{b}}"], 2)
    expect(w.anchors).toHaveLength(2)
    expect(w.anchors.map((a) => a.name.value)).toEqual(["a", "b"])
  })

  it("ArrowWeft recognises an anchor inline with the arrow's code", () => {
    const w = arrowWeftFromLine("=> {{x}}")
    expect(w.anchors).toHaveLength(1)
    expect(w.anchors[0].name.value).toBe("x")
  })

  it("anchor with `:` content puts the rest on weft.unexpected[]", () => {
    const w = codeWeftFromLines(["## A", "=>", "{{mul: Mul}}"], 2)
    expect(w.anchors).toHaveLength(1)
    expect(w.anchors[0].name.value).toBe("mul")
    expect(w.unexpected).toBeDefined()
    expect(w.unexpected![0].value).toBe(": Mul")
    expect(w.health.status).toBe("error")
  })

  it("anchor with whitespace around the name is ok", () => {
    const w = codeWeftFromLines(["## A", "=>", "{{ name }}"], 2)
    expect(w.anchors[0].name.value).toBe("name")
    expect(w.anchors[0].health.status).toBe("ok")
  })

  it("invalid anchor name (non-identifier start) becomes error-health name", () => {
    const w = codeWeftFromLines(["## A", "=>", "{{1bad}}"], 2)
    expect(w.anchors[0].name.health.status).toBe("error")
  })

  it("unclosed `{{` in code produces a synthetic `}}` at EOL", () => {
    const w = codeWeftFromLines(["## A", "=>", "{{x"], 2)
    expect(w.anchors[0].close.health.status).toBe("error")
  })

  it("post-Tokeniser CodeWeft is never `incomplete`", () => {
    expect(codeWeftFromLines(["## A", "=>", "plain code"], 2).health.status)
      .not.toBe("incomplete")
    expect(codeWeftFromLines(["## A", "=>", "{{a}}"], 2).health.status)
      .not.toBe("incomplete")
  })
})

// =============================================================================
// `{Loom}` sections — same grammar as any other Section. The `{Loom}`
// Specifier is just a token; there is no special body weft re-typing.
// =============================================================================

describe("Tokeniser — `{Loom}` sections behave like any other Section", () => {
  it("`## Deps {Loom}` admits Preamble + Arrow + Code wefts in its body", () => {
    const out = tokenise(["## Deps {Loom}", "Some preamble.", "=>", "needs(X)"])
    expect(out.map((w) => w.type)).toEqual([
      "SectionHeadingWeft",
      "PreambleWeft",
      "ArrowWeft",
      "CodeWeft",
    ])
  })

  it("body wefts before any heading (orphan mode) pass through as plain Weft", () => {
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
