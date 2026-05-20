import { describe, expect, it } from "@effect/vitest"
import { Chunk, Effect, Stream } from "effect"
import { LoomSourceRanges, MixedEOL, type LineRange } from "./LineRanges"

// =============================================================================
// collect — helper that resolves the LoomSourceRanges service, opens a stream
// over `text`, drains it, and returns the ranges as a plain readonly array.
// Every test funnels through this so the Effect plumbing is written once and
// the assertions stay focused on the range data.
// =============================================================================

const collect = (text: string) =>
  Effect.gen(function* () {
    const ss = yield* LoomSourceRanges
    const stream = yield* ss.stream(text)
    const chunk = yield* Stream.runCollect(stream)
    return Chunk.toReadonlyArray(chunk)
  })

// =============================================================================
// Range correctness — table-driven checks against precomputed offsets.
//
// These pin down the exact half-open [start, end) ranges the unfold emits for
// every EOL convention and every edge case (empty input, single line, trailing
// terminator, consecutive blank lines, terminator-only). If anyone changes the
// unfold's seed or the regex match handling, these fire immediately with the
// offending offsets — much easier to debug than the structural invariants
// further down.
// =============================================================================

describe("StreamLineRanges — range correctness", () => {
  it.effect("LF, multiple lines", () =>
    Effect.gen(function* () {
      const ranges = yield* collect("line1\nline2\nline3")
      expect(ranges).toEqual<ReadonlyArray<LineRange>>([
        [0, 6],
        [6, 12],
        [12, 17],
      ])
    }).pipe(Effect.provide(LoomSourceRanges.Default)),
  )

  it.effect("CRLF, multiple lines", () =>
    Effect.gen(function* () {
      const ranges = yield* collect("line1\r\nline2\r\nline3")
      expect(ranges).toEqual<ReadonlyArray<LineRange>>([
        [0, 7],
        [7, 14],
        [14, 19],
      ])
    }).pipe(Effect.provide(LoomSourceRanges.Default)),
  )

  it.effect("CR-only (classic Mac)", () =>
    Effect.gen(function* () {
      const ranges = yield* collect("a\rb\rc")
      expect(ranges).toEqual<ReadonlyArray<LineRange>>([
        [0, 2],
        [2, 4],
        [4, 5],
      ])
    }).pipe(Effect.provide(LoomSourceRanges.Default)),
  )

  // A source ending with a terminator emits an extra empty range at the tail.
  // This isn't an accident — it represents the "empty final line" that text
  // editors show after a trailing newline, and downstream stages can rely on
  // its presence when computing positions past the last terminator.
  it.effect("trailing terminator emits a final empty range", () =>
    Effect.gen(function* () {
      const ranges = yield* collect("hello\n")
      expect(ranges).toEqual<ReadonlyArray<LineRange>>([
        [0, 6],
        [6, 6],
      ])
    }).pipe(Effect.provide(LoomSourceRanges.Default)),
  )

  // No terminator anywhere → detectEol returns None and the service short-
  // circuits to a single range covering the whole text. checkMixed is skipped.
  it.effect("single line, no terminator", () =>
    Effect.gen(function* () {
      const ranges = yield* collect("hello")
      expect(ranges).toEqual<ReadonlyArray<LineRange>>([[0, 5]])
    }).pipe(Effect.provide(LoomSourceRanges.Default)),
  )

  // Same None branch as above; the lone range collapses to [0, 0]. Important
  // because consumers should never see a zero-element stream, even for "".
  it.effect("empty input", () =>
    Effect.gen(function* () {
      const ranges = yield* collect("")
      expect(ranges).toEqual<ReadonlyArray<LineRange>>([[0, 0]])
    }).pipe(Effect.provide(LoomSourceRanges.Default)),
  )

  it.effect("consecutive blank lines", () =>
    Effect.gen(function* () {
      const ranges = yield* collect("a\n\n\nb")
      expect(ranges).toEqual<ReadonlyArray<LineRange>>([
        [0, 2],
        [2, 3],
        [3, 4],
        [4, 5],
      ])
    }).pipe(Effect.provide(LoomSourceRanges.Default)),
  )

  it.effect("only a terminator", () =>
    Effect.gen(function* () {
      const ranges = yield* collect("\n")
      expect(ranges).toEqual<ReadonlyArray<LineRange>>([
        [0, 1],
        [1, 1],
      ])
    }).pipe(Effect.provide(LoomSourceRanges.Default)),
  )
})

// =============================================================================
// EOL convention & MixedEOL — every primary/stray combination plus the no-
// false-positive case for pure CRLF.
//
// MixedEOL must fire whenever a stray terminator appears, and must NOT fire
// when the file is internally consistent. The pure-CRLF case is the regression
// guard for the `(?<!\r)\n|\r(?!\n)` stray pattern — a naïve `/\n|\r/` would
// match the `\n` inside `\r\n` and report a false mix.
// =============================================================================

describe("StreamLineRanges — EOL convention & MixedEOL", () => {
  it.effect("LF primary, stray CR fails", () =>
    Effect.gen(function* () {
      const result = yield* Effect.flip(collect("a\nb\rc"))
      expect(result).toBeInstanceOf(MixedEOL)
      expect(result).toMatchObject({ primary: "lf", found: "cr", offset: 3 })
    }).pipe(Effect.provide(LoomSourceRanges.Default)),
  )

  it.effect("CRLF primary, bare LF fails", () =>
    Effect.gen(function* () {
      const result = yield* Effect.flip(collect("a\r\nb\nc"))
      expect(result).toBeInstanceOf(MixedEOL)
      expect(result).toMatchObject({ primary: "crlf", found: "lf", offset: 4 })
    }).pipe(Effect.provide(LoomSourceRanges.Default)),
  )

  it.effect("CRLF primary, bare CR fails", () =>
    Effect.gen(function* () {
      const result = yield* Effect.flip(collect("a\r\nb\rc"))
      expect(result).toBeInstanceOf(MixedEOL)
      expect(result).toMatchObject({ primary: "crlf", found: "cr", offset: 4 })
    }).pipe(Effect.provide(LoomSourceRanges.Default)),
  )

  it.effect("CR primary, stray LF fails", () =>
    Effect.gen(function* () {
      const result = yield* Effect.flip(collect("a\rb\nc"))
      expect(result).toBeInstanceOf(MixedEOL)
      expect(result).toMatchObject({ primary: "cr", found: "lf", offset: 3 })
    }).pipe(Effect.provide(LoomSourceRanges.Default)),
  )

  // Regression guard: the CRLF stray regex uses negative look-around so the
  // `\n` inside `\r\n` and the `\r` inside `\r\n` are NOT flagged as stray.
  // Without that, every pure-CRLF file would falsely report MixedEOL.
  it.effect("pure CRLF is not flagged as mixed", () =>
    Effect.gen(function* () {
      const ranges = yield* collect("a\r\nb\r\nc")
      expect(ranges).toEqual<ReadonlyArray<LineRange>>([
        [0, 3],
        [3, 6],
        [6, 7],
      ])
    }).pipe(Effect.provide(LoomSourceRanges.Default)),
  )
})

// =============================================================================
// Structural invariants — the contract Volar mappings depend on.
//
// Three invariants applied across a varied corpus:
//
//   round-trip — concatenating `text.slice(start, end)` over every range
//                reconstructs the original source byte-for-byte. This is the
//                single strongest assertion: if it holds, no offset is wrong.
//
//   contiguity — every `range.end` equals the next `range.start`. No gaps,
//                no overlaps. Volar mappings break silently if this fails.
//
//   full span  — the first range starts at 0 and the last range ends at
//                `text.length`. The stream covers the whole source.
//
// Each invariant runs against the same corpus, so any new edge case added to
// `corpus` is automatically exercised by all three.
// =============================================================================

describe("StreamLineRanges — structural invariants", () => {
  const corpus: ReadonlyArray<string> = [
    "",
    "hello",
    "hello\n",
    "\n",
    "line1\nline2\nline3",
    "a\n\n\nb",
    "line1\r\nline2\r\nline3",
    "a\rb\rc",
    "# Heading [Tag]\n\nProse line.\n\n=>\nconst x = 1\n",
  ]

  for (const text of corpus) {
    const label = JSON.stringify(text).slice(0, 40)
    it.effect(`round-trip: slices concatenate to the source (${label})`, () =>
      Effect.gen(function* () {
        const ranges = yield* collect(text)
        const rejoined = ranges.map(([s, e]) => text.slice(s, e)).join("")
        expect(rejoined).toBe(text)
      }).pipe(Effect.provide(LoomSourceRanges.Default)),
    )

    it.effect(`contiguity: every range.end === next range.start (${label})`, () =>
      Effect.gen(function* () {
        const ranges = yield* collect(text)
        for (let i = 1; i < ranges.length; i++) {
          expect(ranges[i][0]).toBe(ranges[i - 1][1])
        }
      }).pipe(Effect.provide(LoomSourceRanges.Default)),
    )

    it.effect(`spans the source: first.start=0, last.end=text.length (${label})`, () =>
      Effect.gen(function* () {
        const ranges = yield* collect(text)
        expect(ranges.length).toBeGreaterThan(0)
        expect(ranges[0][0]).toBe(0)
        expect(ranges[ranges.length - 1][1]).toBe(text.length)
      }).pipe(Effect.provide(LoomSourceRanges.Default)),
    )
  }
})

// =============================================================================
// Streaming behavior — proofs that the returned value is actually a Stream,
// not an Array dressed up in an Effect.
//
//   laziness       — `Stream.take(2)` must not pull every range from the
//                    underlying unfold. We count pulls via `Stream.tap` and
//                    assert the counter stays bounded. If someone replaces the
//                    unfold with an eager array, this fails loudly.
//
//   replayability  — the unfold closes over a RegExp with mutable `lastIndex`.
//                    Running the same Stream value twice must yield identical
//                    output; this is the regression test against accidental
//                    state leakage between runs.
//
//   composability  — confirms operators like `Stream.map` chain through
//                    without first collecting. If `stream()` ever regresses to
//                    returning an array, the call sites break here.
// =============================================================================

describe("StreamLineRanges — streaming behavior", () => {
  it.effect("laziness: Stream.take(n) does not pull the whole source", () =>
    Effect.gen(function* () {
      const ss = yield* LoomSourceRanges
      const stream = yield* ss.stream("a\nb\nc\nd\ne")
      let pulls = 0
      yield* stream.pipe(
        Stream.tap(() => Effect.sync(() => { pulls++ })),
        Stream.take(2),
        Stream.runDrain,
      )
      // 5 ranges total ([0,2],[2,4],[4,6],[6,8],[8,9]); take(2) must not pull
      // all of them. We allow up to one over-pull to accommodate chunking.
      expect(pulls).toBeLessThanOrEqual(3)
    }).pipe(Effect.provide(LoomSourceRanges.Default)),
  )

  it.effect("replayability: running the same Stream twice yields identical ranges", () =>
    Effect.gen(function* () {
      const ss = yield* LoomSourceRanges
      const stream = yield* ss.stream("line1\nline2\nline3")
      const a = Chunk.toReadonlyArray(yield* Stream.runCollect(stream))
      const b = Chunk.toReadonlyArray(yield* Stream.runCollect(stream))
      expect(a).toEqual(b)
    }).pipe(Effect.provide(LoomSourceRanges.Default)),
  )

  it.effect("composability: operators chain through the Stream", () =>
    Effect.gen(function* () {
      const ss = yield* LoomSourceRanges
      const stream = yield* ss.stream("a\nbb\nccc")
      const lengths = yield* stream.pipe(
        Stream.map(([s, e]: LineRange) => e - s),
        Stream.runCollect,
      )
      expect(Chunk.toReadonlyArray(lengths)).toEqual([2, 3, 3])
    }).pipe(Effect.provide(LoomSourceRanges.Default)),
  )
})
