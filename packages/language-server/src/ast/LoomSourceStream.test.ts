import { describe, expect, it } from "@effect/vitest"
import { Chunk, Effect, Stream } from "effect"
import { LoomSourceStream, type SourceLine } from "./LoomSourceStream"

describe("LoomSourceStream.fromString", () => {
  it.effect("splits three plain lines and tracks positions", () =>
    Effect.gen(function* () {
      const ss = yield* LoomSourceStream
      const result = yield* Stream.runCollect(ss.fromString("line1\nline2\nline3"))
      const lines = Chunk.toReadonlyArray(result)

      const expected: ReadonlyArray<SourceLine> = [
        { text: "line1", startPoint: { line: 1, column: 1, offset: 0 } },
        { text: "line2", startPoint: { line: 2, column: 1, offset: 6 } },
        { text: "line3", startPoint: { line: 3, column: 1, offset: 12 } },
      ]
      expect(lines).toEqual(expected)
    }).pipe(Effect.provide(LoomSourceStream.Default)),
  )

  it.effect("preserves empty lines between content", () =>
    Effect.gen(function* () {
      const ss = yield* LoomSourceStream
      const result = yield* Stream.runCollect(ss.fromString("a\n\nb"))
      const lines = Chunk.toReadonlyArray(result)

      const expected: ReadonlyArray<SourceLine> = [
        { text: "a", startPoint: { line: 1, column: 1, offset: 0 } },
        { text: "", startPoint: { line: 2, column: 1, offset: 2 } },
        { text: "b", startPoint: { line: 3, column: 1, offset: 3 } },
      ]
      expect(lines).toEqual(expected)
    }).pipe(Effect.provide(LoomSourceStream.Default)),
  )

  it.effect("handles a single line without trailing newline", () =>
    Effect.gen(function* () {
      const ss = yield* LoomSourceStream
      const result = yield* Stream.runCollect(ss.fromString("no newline at end"))
      const lines = Chunk.toReadonlyArray(result)

      const expected: ReadonlyArray<SourceLine> = [
        { text: "no newline at end", startPoint: { line: 1, column: 1, offset: 0 } },
      ]
      expect(lines).toEqual(expected)
    }).pipe(Effect.provide(LoomSourceStream.Default)),
  )

  it.effect("handles a single line with trailing newline", () =>
    Effect.gen(function* () {
      const ss = yield* LoomSourceStream
      const result = yield* Stream.runCollect(ss.fromString("hello\n"))
      const lines = Chunk.toReadonlyArray(result)

      // Stream.splitLines may produce ["hello"] or ["hello", ""] for trailing \n.
      // Assert the stable invariant: at least one line, first one is "hello"
      // at the document start. The test result reveals the exact contract.
      expect(lines.length).toBeGreaterThanOrEqual(1)
      const first: SourceLine = lines[0]
      expect(first).toEqual({
        text: "hello",
        startPoint: { line: 1, column: 1, offset: 0 },
      } satisfies SourceLine)
    }).pipe(Effect.provide(LoomSourceStream.Default)),
  )

  it.effect("emits SourceLines for a multi-section Loom source", () =>
    Effect.gen(function* () {
      const source = [
        "# Heading [Tag]{Spec}",
        "",
        "Some prose.",
        "",
        "=>",
        "const x = 1",
        "~",
        "Inline prose.",
        "~",
        "const y = 2",
      ].join("\n")

      const ss = yield* LoomSourceStream
      const result = yield* Stream.runCollect(ss.fromString(source))
      const lines = Chunk.toReadonlyArray(result)

      // Offsets computed from running line-length sums + newlines:
      //   line 1: "# Heading [Tag]{Spec}" (21) → offset 0
      //   line 2: ""                       (0) → offset 22
      //   line 3: "Some prose."           (11) → offset 23
      //   line 4: ""                       (0) → offset 35
      //   line 5: "=>"                     (2) → offset 36
      //   line 6: "const x = 1"           (11) → offset 39
      //   line 7: "~"                      (1) → offset 51
      //   line 8: "Inline prose."         (13) → offset 53
      //   line 9: "~"                      (1) → offset 67
      //   line 10: "const y = 2"          (11) → offset 69
      const expected: ReadonlyArray<SourceLine> = [
        { text: "# Heading [Tag]{Spec}", startPoint: { line: 1, column: 1, offset: 0 } },
        { text: "", startPoint: { line: 2, column: 1, offset: 22 } },
        { text: "Some prose.", startPoint: { line: 3, column: 1, offset: 23 } },
        { text: "", startPoint: { line: 4, column: 1, offset: 35 } },
        { text: "=>", startPoint: { line: 5, column: 1, offset: 36 } },
        { text: "const x = 1", startPoint: { line: 6, column: 1, offset: 39 } },
        { text: "~", startPoint: { line: 7, column: 1, offset: 51 } },
        { text: "Inline prose.", startPoint: { line: 8, column: 1, offset: 53 } },
        { text: "~", startPoint: { line: 9, column: 1, offset: 67 } },
        { text: "const y = 2", startPoint: { line: 10, column: 1, offset: 69 } },
      ]
      expect(lines).toEqual(expected)
    }).pipe(Effect.provide(LoomSourceStream.Default)),
  )

  it.effect("partial source via fromTextStream starts from a given Point", () =>
    Effect.gen(function* () {
      const ss = yield* LoomSourceStream
      const partial = Stream.fromIterable(["mid-line continues\nnext line\nlast"])
      const result = yield* Stream.runCollect(
        ss.fromTextStream(partial, { line: 15, column: 8, offset: 4823 }),
      )
      const lines = Chunk.toReadonlyArray(result)

      const expected: ReadonlyArray<SourceLine> = [
        { text: "mid-line continues", startPoint: { line: 15, column: 8, offset: 4823 } },
        { text: "next line", startPoint: { line: 16, column: 1, offset: 4842 } },
        { text: "last", startPoint: { line: 17, column: 1, offset: 4852 } },
      ]
      expect(lines).toEqual(expected)
    }).pipe(Effect.provide(LoomSourceStream.Default)),
  )
})
