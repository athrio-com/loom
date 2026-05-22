import { Effect, Stream } from "effect"
import type { LoomWeft } from "./Weft"

// =============================================================================
// WeftTokeniser — stub. The Tokeniser Stage of the parse pipeline (per how.md step 6).
//
// Real implementation will be a pure Stream.map: per-Weft-kind probe expansion
// that fills texts[], tag, specifier, code?, prose? on each Weft. No mode
// state.
//
// For now: passes the input stream through unchanged so Loom.ts compiles
// end-to-end while we follow how.md's sequential implementation order.
// =============================================================================

export class WeftTokeniser extends Effect.Service<WeftTokeniser>()(
  "WeftTokeniser",
  {
    succeed: {
      tokeniseWefts:
        (_text: string) =>
        (source: Stream.Stream<LoomWeft>): Stream.Stream<LoomWeft> =>
          source,
    },
  },
) { }
