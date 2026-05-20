import { Effect, Stream } from "effect"
import { okHealth, type LoomDocument, type Position } from "./LoomAst"
import type { LoomWeft } from "./Weft"

// =============================================================================
// LoomAstBuilder — stub. Stage 3 of the parse pipeline (per how.md step 7).
//
// Real implementation will use Stream.mapAccum with a chapter accumulator
// (ChapterHeadingWeft flushes the previous chapter; sentinel flushes the
// final chapter), then Stream.runFold into a LoomDocument.
//
// For now: ignores the weft stream and returns a minimal valid LoomDocument
// so Loom.ts compiles end-to-end. Replaced when step 7 lands.
// =============================================================================

const zeroPosition: Position = {
  start: { line: 1, offset: 0 },
  end: { line: 1, offset: 0 },
}

const stubDocument: LoomDocument = {
  type: "LoomDocument",
  position: zeroPosition,
  health: okHealth,
  chapters: [
    {
      type: "LoomChapter",
      position: zeroPosition,
      health: okHealth,
      heading: {
        type: "LoomHeading",
        position: zeroPosition,
        health: okHealth,
        markers: {
          type: "LoomHeadingMarkers",
          position: zeroPosition,
          health: okHealth,
          value: "#",
        },
        text: {
          type: "LoomHeadingText",
          position: zeroPosition,
          health: okHealth,
          value: "",
        },
      },
      preamble: [],
      code: [],
      children: [],
    },
  ],
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
