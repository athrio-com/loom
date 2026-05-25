import { describe, expect, it } from "@effect/vitest"
import { Chunk, Effect, Schema, Stream, pipe } from "effect"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { LoomSourceRanges } from "./LineRanges"
import { WeftClassifier } from "./WeftClassifier"
import { WeftTokeniser } from "./WeftTokeniser"
import { LoomWeftSchema, WeftSchema, type LoomWeft } from "./Weft"

// =============================================================================
// Loom AST — integration tests against `corpus/Fun.loom`.
//
// Two layers exercise the Effect-DI composition of the pipeline stages
// against the real-world example fixture:
//
//   Classifier Stage — LoomSourceRanges → WeftClassifier
//   Tokeniser Stage  — Classifier output → WeftTokeniser
//
// Assertions target stage invariants rather than per-weft snapshots, so
// cosmetic changes to the fixture don't ripple through the test suite.
// =============================================================================

const fixturePath = resolve(__dirname, "../../../../corpus/Fun.loom")
const sampleLoom = readFileSync(fixturePath, "utf8")

const classifyText = (text: string): ReadonlyArray<LoomWeft> =>
  Effect.runSync(
    Effect.gen(function* () {
      const sources = yield* LoomSourceRanges
      const classifier = yield* WeftClassifier
      const ranges = yield* sources.stream(text)
      const stream = classifier.classifyWefts(text)(ranges)
      return Chunk.toReadonlyArray(yield* Stream.runCollect(stream))
    }).pipe(
      Effect.provide(LoomSourceRanges.Default),
      Effect.provide(WeftClassifier.Default),
      Effect.orDie,
    ),
  )

const tokeniseText = (text: string): ReadonlyArray<LoomWeft> =>
  Effect.runSync(
    Effect.gen(function* () {
      const sources = yield* LoomSourceRanges
      const classifier = yield* WeftClassifier
      const tokeniser = yield* WeftTokeniser
      const ranges = yield* sources.stream(text)
      const stream = pipe(
        ranges,
        classifier.classifyWefts(text),
        tokeniser.tokeniseWefts(text),
      )
      return Chunk.toReadonlyArray(yield* Stream.runCollect(stream))
    }).pipe(
      Effect.provide(LoomSourceRanges.Default),
      Effect.provide(WeftClassifier.Default),
      Effect.provide(WeftTokeniser.Default),
      Effect.orDie,
    ),
  )

// =============================================================================
// Classifier Stage — coverage of every probe kind, line accounting, schema
// validity per emitted weft.
// =============================================================================

describe("Classifier Stage — integration against corpus/Fun.loom", () => {
  const wefts = classifyText(sampleLoom)

  it("emits one weft per source line", () => {
    expect(wefts.length).toBe(sampleLoom.split("\n").length)
  })

  it("fires every Classifier-Stage probe at least once", () => {
    const seen = new Set(wefts.map((w) => w.type))
    expect(seen.has("Weft")).toBe(true)                  // orphan mode (pre-chapter)
    expect(seen.has("ChapterHeadingWeft")).toBe(true)
    expect(seen.has("SectionHeadingWeft")).toBe(true)
    expect(seen.has("ArrowWeft")).toBe(true)
    expect(seen.has("TildeWeft")).toBe(true)
    expect(seen.has("PreambleWeft")).toBe(true)
    expect(seen.has("CodeWeft")).toBe(true)
    expect(seen.has("ProseWeft")).toBe(true)
  })

  it("every weft is a valid LoomWeft per schema", () => {
    for (const w of wefts) {
      expect(Schema.is(LoomWeftSchema)(w)).toBe(true)
    }
  })

  it("classifies exactly one Chapter", () => {
    expect(wefts.filter((w) => w.type === "ChapterHeadingWeft")).toHaveLength(1)
  })
})

// =============================================================================
// Tokeniser Stage — heading subtokens, body weft Warp/Anchor expansion,
// post-Tokeniser health invariant.
// =============================================================================

describe("Tokeniser Stage — integration against corpus/Fun.loom", () => {
  const wefts = tokeniseText(sampleLoom)

  const filterByType = <K extends LoomWeft["type"]>(
    type: K,
  ): ReadonlyArray<Extract<LoomWeft, { type: K }>> =>
    wefts.filter(
      (w): w is Extract<LoomWeft, { type: K }> => w.type === type,
    )

  it("emits one weft per source line", () => {
    expect(wefts.length).toBe(sampleLoom.split("\n").length)
  })

  it("every weft is a valid LoomWeft per schema", () => {
    for (const w of wefts) {
      expect(Schema.is(LoomWeftSchema)(w)).toBe(true)
    }
  })

  it("post-Tokeniser invariant: no weft is `incomplete`", () => {
    for (const w of wefts) {
      expect(w.health.status).not.toBe("incomplete")
    }
  })

  it("the fixture parses without errors or warnings", () => {
    for (const w of wefts) {
      expect(w.health.status).toBe("ok")
    }
  })

  it("Chapter heading carries the fixture's tag and specifier", () => {
    const [chapter] = filterByType("ChapterHeadingWeft")
    expect(chapter.tag?.label.value).toBe("Arithmetic")
    expect(chapter.specifier?.label.value).toBe("Scala")
  })

  it("orphan Wefts precede the Chapter heading in document order", () => {
    const [chapter] = filterByType("ChapterHeadingWeft")
    const orphans = filterByType("Weft")
    expect(orphans.length).toBeGreaterThan(0)
    for (const w of orphans) {
      expect(w.position.end.line).toBeLessThan(chapter.position.start.line)
    }
  })

  it("chapterless `## Reading notes [Notes]` precedes the Chapter heading", () => {
    const [chapter] = filterByType("ChapterHeadingWeft")
    const notes = filterByType("SectionHeadingWeft").find(
      (s) => s.tag?.label.value === "Notes",
    )
    expect(notes).toBeDefined()
    expect(notes!.position.end.line).toBeLessThan(chapter.position.start.line)
  })

  it("`## Deps {Loom}` parses with the `Loom` specifier and no tag", () => {
    const deps = filterByType("SectionHeadingWeft").find(
      (s) => s.specifier?.label.value === "Loom" && s.tag === undefined,
    )
    expect(deps).toBeDefined()
  })

  it("`## Build script [Build]{Bash}` parses with both tag and per-Section specifier", () => {
    const build = filterByType("SectionHeadingWeft").find(
      (s) => s.tag?.label.value === "Build",
    )
    expect(build?.specifier?.label.value).toBe("Bash")
  })

  it("a PreambleWeft with `{{m: Mul}}` populates warps with the Mul reference", () => {
    const preamble = filterByType("PreambleWeft").find((w) =>
      w.warps.some((wp) => wp.name.value === "m"),
    )
    if (!preamble) throw new Error("expected a PreambleWeft binding `m`")
    const warp = preamble.warps.find((wp) => wp.name.value === "m")!
    expect(warp.annotation.value).toBe("Mul")
    expect(warp.default).toBeUndefined()
    expect(warp.health.status).toBe("ok")
  })

  it("the entry-point preamble declares three warps in one line (a, s, p)", () => {
    const preamble = filterByType("PreambleWeft").find((w) => w.warps.length >= 3)
    if (!preamble) throw new Error("expected a PreambleWeft with three warps")
    const names = preamble.warps.map((wp) => wp.name.value)
    expect(names).toEqual(["a", "s", "p"])
  })

  it("a CodeWeft with `{{m}}` populates anchors with the Mul reference", () => {
    const code = filterByType("CodeWeft").find((c) =>
      c.anchors.some((a) => a.name.value === "m"),
    )
    if (!code) throw new Error("expected a CodeWeft referencing `m`")
    const anchor = code.anchors.find((a) => a.name.value === "m")!
    expect(anchor.health.status).toBe("ok")
  })

  it("the entry-point body emits anchors for each top-level dependency", () => {
    const referenced = new Set(
      filterByType("CodeWeft").flatMap((c) => c.anchors.map((a) => a.name.value)),
    )
    expect(referenced.has("a")).toBe(true)
    expect(referenced.has("s")).toBe(true)
    expect(referenced.has("p")).toBe(true)
  })

  it("ArrowWefts in the fixture have no inline code or anchors", () => {
    for (const arrow of filterByType("ArrowWeft")) {
      expect(arrow.code).toBeUndefined()
      expect(arrow.anchors).toHaveLength(0)
    }
  })

  it("no heading Text token contains the line terminator", () => {
    const headings = [
      ...filterByType("ChapterHeadingWeft"),
      ...filterByType("SectionHeadingWeft"),
    ]
    for (const h of headings) {
      for (const t of h.texts) {
        const slice = sampleLoom.slice(t.position.start.offset, t.position.end.offset)
        expect(slice).not.toMatch(/[\r\n]/)
      }
    }
  })
})

// =============================================================================
// LoomDocument shape compatibility — confirms the existing Classifier /
// Tokeniser output composes with the new `LoomDocument` schema slots
// (`wefts`, `sections`, `chapters`) without any upstream changes. We feed
// a fixture covering pre-chapter prose and an orphan `##+` heading, then
// assert the emitted wefts have the kinds those slots admit.
// =============================================================================

describe("Pipeline compatibility with LoomDocument shape", () => {
  // Pre-chapter prose, then an orphan Section, then a real Chapter.
  const fixture = [
    "Some pre-chapter prose.",         // Weft (orphan)
    "",                                 // Weft (orphan, still pre-heading)
    "## Orphan section [Orphan]",      // SectionHeadingWeft (no parent Chapter)
    "",                                 // PreambleWeft (section opens preamble mode)
    "A line under the orphan section.",// PreambleWeft
    "",                                 // PreambleWeft
    "# Real Chapter [Tag]{Lang}",      // ChapterHeadingWeft
    "",                                 // PreambleWeft (under the chapter)
  ].join("\n")

  const wefts = tokeniseText(fixture)

  it("pre-chapter lines come back as Weft (orphan) kind", () => {
    expect(wefts[0].type).toBe("Weft")
    expect(wefts[1].type).toBe("Weft")
  })

  it("orphan Wefts satisfy `WeftSchema` — valid entries for `LoomDocument.wefts`", () => {
    expect(Schema.is(WeftSchema)(wefts[0])).toBe(true)
    expect(Schema.is(WeftSchema)(wefts[1])).toBe(true)
  })

  it("a `##+` heading before any `#` classifies as SectionHeadingWeft", () => {
    expect(wefts[2].type).toBe("SectionHeadingWeft")
  })

  it("a `#` heading appearing after orphan content still classifies as ChapterHeadingWeft", () => {
    const chapters = wefts.filter((w) => w.type === "ChapterHeadingWeft")
    expect(chapters).toHaveLength(1)
  })

  it("body wefts between the orphan section and the real chapter live under the orphan section's preamble", () => {
    // Indices 3, 4, 5 are between the orphan `##` heading and the real `#`
    // heading; all should be PreambleWeft kind (preamble mode after a heading).
    expect(wefts[3].type).toBe("PreambleWeft")
    expect(wefts[4].type).toBe("PreambleWeft")
    expect(wefts[5].type).toBe("PreambleWeft")
  })
})
