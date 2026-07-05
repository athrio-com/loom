import { Context, Data, Effect, Layer, Option, pipe } from 'effect'
import {
  checkAnchorDelims,
  defaultAnchorDelims,
  type AnchorDelims,
  type InvalidAnchorDelims,
} from '@athrio/loom-ast/LoomTokens'
import { LoomSourceRanges } from '#ast/LineRanges'
import { WeftClassifier } from '#ast/WeftClassifier'
import { WeftTokeniser } from '#ast/WeftTokeniser'
import { LoomAstBuilder, emptyDocument, emptyDocumentFor } from '#ast/LoomAstBuilder'
import type { LoomDocument } from '@athrio/loom-ast/LoomAst'
import { ProductBuilder } from '#ast/ProductBuilder'
import type { LoomModule, Path } from '@athrio/loom-ast/LoomCorpusAst'

export interface Source {
  readonly read: (path: Path) => Effect.Effect<string, ReadError>
  readonly list: Option.Option<(dir: Path) => Effect.Effect<ReadonlyArray<Path>>>
}

export class ReadError extends Data.TaggedError('ReadError')<{
  readonly path: Path
  readonly cause: unknown
}> {
  get message(): string {
    return `Cannot read ${this.path}: ${
      this.cause instanceof Error ? this.cause.message : String(this.cause)
    }`
  }
}

export class LoomCorpusAstBuilder extends Context.Service<LoomCorpusAstBuilder>()(
  'LoomCorpusAstBuilder',
  {
    make: Effect.gen(function* () {
      const sourceRanges = yield* LoomSourceRanges
      const classify = yield* WeftClassifier
      const tokenise = yield* WeftTokeniser
      const astBuilder = yield* LoomAstBuilder
      const products = yield* ProductBuilder

      const parsed = (
        source: Source,
        path: Path,
        delims: AnchorDelims,
      ): Effect.Effect<{ readonly text: string; readonly doc: LoomDocument }> =>
        source.read(path).pipe(
          Effect.flatMap((text) => {
            const onBadDelims = (err: InvalidAnchorDelims) =>
              Effect.succeed(emptyDocument(text, err.message))
            return checkAnchorDelims(delims).pipe(
              Effect.andThen(sourceRanges.stream(text)),
              Effect.flatMap((ranges) =>
                pipe(
                  ranges,
                  classify.classifyWefts(text),
                  tokenise.tokeniseWefts(text, delims),
                  astBuilder.build,
                ),
              ),
              Effect.catchTag('MixedEOL', (err) =>
                Effect.succeed(emptyDocumentFor(text, err)),
              ),
              Effect.catchTags({
                EmptyAnchorDelims: onBadDelims,
                IdenticalAnchorDelims: onBadDelims,
                WhitespaceAnchorDelims: onBadDelims,
                ReservedAnchorDelims: onBadDelims,
              }),
              Effect.map((doc) => ({ text, doc })),
            )
          }),
          Effect.catchTag('ReadError', (err) =>
            Effect.succeed({ text: '', doc: emptyDocument('', err.message) }),
          ),
        )

      const build = (
        source: Source,
        path: Path,
        delims: AnchorDelims = defaultAnchorDelims,
        primaryLanguage?: string,
      ): Effect.Effect<LoomModule> =>
        Effect.gen(function* () {
          const { text, doc } = yield* parsed(source, path, delims)
          const product = yield* products.build(doc, path, primaryLanguage)
          return { path, text, doc, product }
        })

      return { build }
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make).pipe(
    Layer.provide(
      Layer.mergeAll(
        LoomSourceRanges.layer,
        WeftClassifier.layer,
        WeftTokeniser.layer,
        LoomAstBuilder.layer,
        ProductBuilder.layer,
      ),
    ),
  )
}
