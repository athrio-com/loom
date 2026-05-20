import { Effect, Stream } from "effect"
import type { LineRange } from "./LineRanges"
import type { LoomWeft } from "./Weft"

// =============================================================================
// WeftClassifier — stub. Stage 1 of the parse pipeline (per how.md step 5).
//
// Real implementation will use Stream.mapAccum with a ParseContext (mode
// tracks prose/code/deps/tangle and section kind). Recognises Dependencies/
// Tangle headings at this stage — no later promotion.
//
// For now: returns an empty stream so Loom.ts compiles end-to-end while we
// follow how.md's sequential implementation order.
// =============================================================================

export class WeftClassifier extends Effect.Service<WeftClassifier>()(
  "WeftClassifier",
  {
    succeed: {
      classifyWefts:
        (_text: string) =>
        (_source: Stream.Stream<LineRange>): Stream.Stream<LoomWeft> =>
          Stream.empty,
    },
  },
) { }
