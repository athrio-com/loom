import { Effect, pipe } from "effect"
import {
  okHealth,
  type Health,
  type LoomDocument,
  type Position,
} from "./LoomAst"
import { LoomSourceRanges, type MixedEOL } from "./LineRanges"
import { WeftClassifier } from "./WeftClassifier"
import { WeftTokeniser } from "./WeftTokeniser"
import { LoomAstBuilder } from "./LoomAstBuilder"

// =============================================================================
// emptyDocumentFor — produces a minimal LoomDocument with NOK root health and
// a positioned diagnostic describing the offending terminator. The document
// is otherwise empty; downstream walkers see one empty chapter with okHealth.
// =============================================================================

const emptyDocumentFor = (err: MixedEOL): LoomDocument => {
  const position: Position = {
    start: { line: 1, offset: err.offset },
    end: { line: 1, offset: err.offset },
  }
  const rootHealth: Health = {
    status: "error",
    diagnostics: [
      {
        message: `Mixed line terminators: file is ${err.primary} but contains ${err.found} at offset ${err.offset}.`,
        position,
        severity: "error",
      },
    ],
  }
  return {
    type: "LoomDocument",
    position,
    health: rootHealth,
    chapters: [
      {
        type: "LoomChapter",
        position,
        health: okHealth,
        heading: {
          type: "LoomHeading",
          position,
          health: okHealth,
          markers: {
            type: "LoomHeadingMarkers",
            position,
            health: okHealth,
            value: "#",
          },
          text: {
            type: "LoomHeadingText",
            position,
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
}

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
          // Short-circuit on mixed terminators: minimal document, NOK root
          // health (once step 1 lands). Placed AFTER the pipeline so the
          // recovery value type matches the pipeline output (LoomDocument).
          Effect.catchTag("MixedEOL", (err) =>
            Effect.succeed(emptyDocumentFor(err))
          ),
        ),
    }
  }),
}) { }
