import { describe, expect, it } from "@effect/vitest"
import { Chunk, Effect, Schema, Stream } from "effect"
import { LoomSourceRanges } from "./LineRanges"
import { WeftClassifier } from "./WeftClassifier"
import { LoomWeftSchema, type LoomWeft } from "./Weft"

// =============================================================================
// WeftClassifier — integration test.
//
// Exercises the Effect-DI composition of LoomSourceRanges + WeftClassifier
// against a representative inline `.loom` source. Asserts Classifier-Stage
// invariants rather than per-weft snapshots, so incidental shape changes
// don't ripple through the test.
// =============================================================================

const sampleLoom = `# Sample [App]{TypeScript}

Some intro prose for the chapter.

## Greeting [Greet]

Preamble line for the greeting section.

=>

app.get('/hello', () => 'world')

~

Prose describing what the handler does.

## Deps {Loom}

=>

needs(HonoToolchain)

## Tangle {Loom}

=>

tangle("src/index.ts", compose(Greet))
`

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

describe("Classifier Stage — integration against an inline sample loom", () => {
  const wefts = classifyText(sampleLoom)

  it("emits at least one weft per source line", () => {
    expect(wefts.length).toBeGreaterThan(0)
    expect(wefts.length).toBe(sampleLoom.split("\n").length)
  })

  it("fires every Classifier-Stage probe at least once", () => {
    const seen = new Set(wefts.map((w) => w.type))
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

  it("classifies exactly one Chapter and three Sections (Greeting + Deps + Tangle)", () => {
    expect(wefts.filter((w) => w.type === "ChapterHeadingWeft")).toHaveLength(1)
    expect(wefts.filter((w) => w.type === "SectionHeadingWeft")).toHaveLength(3)
  })
})
