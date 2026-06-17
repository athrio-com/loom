import { Effect, Layer, pipe } from 'effect'
import { LoomSourceRanges } from '#ast/LineRanges'
import { WeftClassifier } from '#ast/WeftClassifier'
import { WeftTokeniser } from '#ast/WeftTokeniser'
import { LoomAstBuilder, emptyDocumentFor } from '#ast/LoomAstBuilder'
import type { LoomDocument } from '#ast/LoomAst'

// Test support: parse `.loom` source to a LoomDocument through the four parse
// stages as a flat chain — the same composition the production spine
// (`LoomCorpusAstBuilder.build`) runs, without the frame/product passes on top.
// Production has no standalone parse aggregate by design; tests that only need a
// document use this helper, and `ParseLayer` provides the four stage services.

export const ParseLayer = Layer.mergeAll(
  LoomSourceRanges.Default,
  WeftClassifier.Default,
  WeftTokeniser.Default,
  LoomAstBuilder.Default,
)

export const parseDocument = (
  text: string,
): Effect.Effect<
  LoomDocument,
  never,
  LoomSourceRanges | WeftClassifier | WeftTokeniser | LoomAstBuilder
> =>
  Effect.gen(function* () {
    const sourceRanges = yield* LoomSourceRanges
    const classify = yield* WeftClassifier
    const tokenise = yield* WeftTokeniser
    const astBuilder = yield* LoomAstBuilder
    return yield* sourceRanges.stream(text).pipe(
      Effect.flatMap((ranges) =>
        pipe(
          ranges,
          classify.classifyWefts(text),
          tokenise.tokeniseWefts(text),
          astBuilder.build,
        ),
      ),
      Effect.catchTag('MixedEOL', (err) =>
        Effect.succeed(emptyDocumentFor(text, err)),
      ),
    )
  })
