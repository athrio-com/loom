import { Effect, pipe } from "effect"
import type { LoomDocument } from "./LoomAst"
import type { Health, Position } from "./LoomNode"
import { LoomSourceRanges, type MixedEOL } from "./LineRanges"
import { WeftClassifier } from "./WeftClassifier"
import { WeftTokeniser } from "./WeftTokeniser"
import { LoomAstBuilder } from "./LoomAstBuilder"

// =============================================================================
// Loom — the single entry point that turns raw source text into a
// `LoomDocument` AST. Composes the parsing pipeline:
//
//   LoomSourceRanges → WeftClassifier → WeftTokeniser → LoomAstBuilder
//
// Contract:
//
//   Loom.ast(text): Effect<LoomDocument>     — never fails
//
// Every AST node carries a uniform `health` field. `MixedEOL` (mixed line
// terminators) is caught at the orchestrator boundary and converted to a
// minimal LoomDocument with NOK root health; the pipeline does not run on
// that path. Every other structural problem (malformed tag, missing bracket,
// invalid mode transition) lives in the `health` field of the relevant node.
// A flat diagnostic list is derived by walking the AST and collecting nodes
// where `health.status !== "ok"`.
// =============================================================================

export class Loom extends Effect.Service<Loom>()("Loom", {
  dependencies: [
    LoomSourceRanges.Default,
    WeftClassifier.Default,
    WeftTokeniser.Default,
    LoomAstBuilder.Default,
  ],
  effect: Effect.gen(function* () {
    const source = yield* LoomSourceRanges
    const classify = yield* WeftClassifier
    const tokenise = yield* WeftTokeniser
    const document = yield* LoomAstBuilder

    return {
      // ast — parse source text into a LoomDocument. Never fails: MixedEOL
      // is recovered as an empty document with NOK root health; all other
      // structural problems live in node-level `health` fields.
      ast: (text: string): Effect.Effect<LoomDocument> =>
        source.stream(text).pipe(
          Effect.flatMap((sourceRanges) => pipe(
            sourceRanges,
            classify.classifyWefts(text),  // Stream<LineRange> → Stream<LoomWeft>
            tokenise.tokeniseWefts(text),  // Stream<LoomWeft>  → Stream<LoomWeft>
            document.build,                // Stream<LoomWeft>  → Effect<LoomDocument>
          )),
          // Short-circuit on mixed terminators: pipeline never runs; recover
          // with an empty document whose root health carries the diagnostic.
          Effect.catchTag("MixedEOL", (err) =>
            Effect.succeed(emptyDocumentFor(text, err))
          ),
        ),
    }
  }),
}) { }


// =============================================================================
// emptyDocumentFor — the LoomDocument returned when `MixedEOL` short-circuits
// the pipeline. Position spans the whole input (positions describe source
// spans, not error locations). Error context lives in `health.diagnostics`.
// `chapters` is empty: no synthetic AST shape is fabricated.
// =============================================================================

const emptyDocumentFor = (text: string, err: MixedEOL): LoomDocument => {
  const docPosition: Position = {
    start: { line: 1, offset: 0 },
    end: { line: 1, offset: text.length },
  }
  const rootHealth: Health = {
    status: "error",
    diagnostics: [
      {
        message: `Mixed line terminators. Line ${err.primaryLine} has ${eolName(err.primary)}, but line ${err.foundLine} has ${eolName(err.found)}. Pick one and stick with it.`,
        position: docPosition,
        severity: "error",
      },
    ],
  }
  return {
    type: "LoomDocument",
    position: docPosition,
    health: rootHealth,
    chapters: [],
  }
}

const eolName = (kind: "lf" | "crlf" | "cr"): string => {
  switch (kind) {
    case "lf":   return "LF (Unix)"
    case "crlf": return "CRLF (Windows)"
    case "cr":   return "CR (classic Mac)"
  }
}
