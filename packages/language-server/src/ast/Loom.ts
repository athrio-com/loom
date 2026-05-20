import { Effect, pipe } from "effect"
import type { LoomDocument } from "./LoomAst"
import type { Health, Position } from "./LoomNode"
import { LoomSourceRanges, type MixedEOL } from "./LineRanges"
import { WeftClassifier } from "./WeftClassifier"
import { WeftTokeniser } from "./WeftTokeniser"
import { LoomAstBuilder } from "./LoomAstBuilder"

// =============================================================================
// Loom — the single entry point for turning raw source text into a
// LoomDocument AST.
//
// This service is the full parsing pipeline.
//
// Contract:
//   Loom.ast(text) → Effect<LoomDocument>   ← never fails
//
// The AST has a uniform health shape at every level — LoomDocument itself,
// every chapter, section, token, and subtoken all carry:
//
//   health: { status: "ok" | "error" | "warning", diagnostics: ReadonlyArray<Diagnostic> }
//
// MixedEOL (mixed line terminators) is the one pipeline-level interrupt. It
// does not surface in the Effect channel — it is caught internally and
// returned as a minimal LoomDocument with NOK health at the top level and a
// positioned diagnostic describing the offending terminator. The document is
// otherwise empty. The pipeline short-circuits; no further stages run.
//
// Every other structural problem (malformed tags, missing brackets, invalid
// mode transitions, constraint violations) is captured in the health field of
// the relevant node. The AST speaks for itself.
//
// Callers that need a flat diagnostic list walk the AST collecting nodes
// where health.status !== "ok". The loomLanguagePlugin does this before
// handing diagnostics to Volar.
// =============================================================================

// =============================================================================
// Pipeline stages — each is an injectable Effect.Service.
//
// Read each service file before implementing this one:
//
//   WeftClassifier   — classifyWefts(text)(Stream<LineRange>) → Stream<LoomWeft>
//                      Mode-aware: tracks prose/code/deps/tangle and section
//                      kind (Chapter, Deps, Tangle) via Stream.mapAccum.
//                      Recognises DependenciesHeadingWeft and TangleHeadingWeft
//                      by probing ## level + [D]/[T] tag simultaneously —
//                      no later promotion.
//
//   WeftTokeniser    — tokeniseWefts(text)(Stream<LoomWeft>) → Stream<LoomWeft>
//                      Pure per-kind subtoken expansion. Fills texts[], tag,
//                      specifier, code?, prose? on each Weft. No mode state.
//
//   LoomAstBuilder   — build(Stream<LoomWeft>) → Effect<LoomDocument>
//                      Groups wefts into AST hierarchy and folds into document:
//                        LoomChapter  (#  level — ChapterHeadingWeft)
//                          ├── LoomSection      (##+ level — SectionHeadingWeft)
//                          ├── LoomDependencies (##  level — DependenciesHeadingWeft [D])
//                          └── LoomTangle       (##  level — TangleHeadingWeft [T])
//                      ChapterHeadingWeft flushes the previous chapter and opens
//                      a new one. Sentinel flushes the final chapter. Never fails.
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
      // ast — produce a LoomDocument from source text. Never fails.
      //
      // MixedEOL is caught here and converted to a minimal LoomDocument with
      // NOK health at the root and a positioned diagnostic. The pipeline
      // short-circuits; no stages run. Every other error is captured in
      // health fields on the relevant AST nodes downstream.
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
// emptyDocumentFor — produces a LoomDocument for the MixedEOL short-circuit.
//
// Document position spans the whole input (0..text.length) — positions are
// about source spans, not error locations. Error context lives in
// `health.diagnostics` where it belongs. `chapters: []` because nothing
// parsed; no synthetic AST shape is fabricated.
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
