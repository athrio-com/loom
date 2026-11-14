import { Effect, Layer, pipe } from 'effect'
import { LoomSourceRanges } from '#ast/LineRanges'
import { WeftClassifier } from '#ast/WeftClassifier'
import { WeftTokeniser } from '#ast/WeftTokeniser'
import { LoomAstBuilder, emptyDocumentFor } from '#ast/LoomAstBuilder'
import { LoomDocumentBuilder } from '#ast/LoomDocumentBuilder'
import type { LoomDocument, ParsedDocument } from '@athrio/loom-ast/LoomAst'

// Test support: read `.loom` source the way a build does, without the product
// pass on top. `parsedDocument` runs the four parse stages as a flat chain and
// gives the tree the parser built. `parseDocument` then runs the row of small
// passes over that tree and gives the LoomDocument every later reader takes —
// the same composition the production spine (`LoomCorpusAstBuilder.build`)
// runs. `ParseLayer` provides the stage services and the row's.

export const ParseLayer = Layer.mergeAll(
  LoomSourceRanges.layer,
  WeftClassifier.layer,
  WeftTokeniser.layer,
  LoomAstBuilder.layer,
  LoomDocumentBuilder.layer,
)

type ParseServices = LoomSourceRanges | WeftClassifier | WeftTokeniser | LoomAstBuilder

export const parsedDocument = (text: string): Effect.Effect<ParsedDocument, never, ParseServices> =>
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

export const parseDocument = (
  text: string,
): Effect.Effect<LoomDocument, never, ParseServices | LoomDocumentBuilder> =>
  Effect.gen(function* () {
    const documents = yield* LoomDocumentBuilder
    return documents.build(yield* parsedDocument(text))
  })
