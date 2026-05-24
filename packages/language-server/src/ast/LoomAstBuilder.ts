import { Effect, Stream } from "effect"
import type { LoomDocument } from "./LoomAst"
import { okHealth, type Position } from "./LoomNode"
import type { LoomWeft } from "./Weft"

// =============================================================================
// LoomAstBuilder — final stage of the parse pipeline.
//
//   build(Stream<LoomWeft>): Effect<LoomDocument>
//
// Groups the weft stream into the `LoomDocument → LoomChapter[] →
// LoomSection[]` hierarchy via `Stream.mapAccum` with a chapter accumulator:
// `ChapterHeadingWeft` flushes the previous chapter; a sentinel flushes the
// final chapter. Inside a chapter, the same accumulator pattern groups
// wefts into `LoomSection`s. Folds into a `LoomDocument` via
// `Stream.runFold`. Never fails.
//
// Current implementation: stubbed — discards the input stream and returns
// an empty document so the orchestrator compiles end-to-end.
// =============================================================================

const zeroPosition: Position = {
  start: { line: 1, offset: 0 },
  end: { line: 1, offset: 0 },
}

const stubDocument: LoomDocument = {
  type: "LoomDocument",
  position: zeroPosition,
  health: okHealth,
  chapters: [],
}

export class LoomAstBuilder extends Effect.Service<LoomAstBuilder>()(
  "LoomAstBuilder",
  {
    succeed: {
      build: (_source: Stream.Stream<LoomWeft>): Effect.Effect<LoomDocument> =>
        Effect.succeed(stubDocument),
    },
  },
) { }
