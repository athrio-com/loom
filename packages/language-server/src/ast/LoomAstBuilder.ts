import { Effect, Stream } from "effect"
import type { LoomDocument, Position } from "./LoomAst"
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
  chapters: [
    {
      type: "LoomChapter",
      position: zeroPosition,
      heading: {
        type: "LoomHeading",
        position: zeroPosition,
        markers: { value: "#", position: zeroPosition },
        text: { value: "", position: zeroPosition },
      },
      preamble: [],
      code: [],
      sections: [],
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
