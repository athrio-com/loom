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
import type { ParsedDocument } from '@athrio/loom-ast/LoomAst'
import { type Declared, LoomDocumentBuilder, nothingDeclared } from '#ast/LoomDocumentBuilder'
import { ProductBuilder } from '#ast/ProductBuilder'
import type { LoomModule, Location } from '@athrio/loom-ast/LoomCorpusAst'

export interface Source {
  readonly read: (path: Location) => Effect.Effect<string, ReadError>
  readonly list: Option.Option<(loom: Location) => Effect.Effect<ReadonlyArray<Location>>>
}

export class ReadError extends Data.TaggedError('ReadError')<{
  readonly path: Location
  readonly cause: unknown
}> {
  get message(): string {
    return `Cannot read ${this.path}: ${
      this.cause instanceof Error ? this.cause.message : String(this.cause)
    }`
  }
}

export interface ParsedLoom {
  readonly path: Location
  readonly text: string
  readonly tree: ParsedDocument
}

export class LoomCorpusAstBuilder extends Context.Service<LoomCorpusAstBuilder>()(
  'LoomCorpusAstBuilder',
  {
    make: Effect.gen(function* () {
      const sourceRanges = yield* LoomSourceRanges
      const classify = yield* WeftClassifier
      const tokenise = yield* WeftTokeniser
      const astBuilder = yield* LoomAstBuilder
      const documents = yield* LoomDocumentBuilder
      const products = yield* ProductBuilder

      const parse = (
        source: Source,
        path: Location,
        delims: AnchorDelims = defaultAnchorDelims,
      ): Effect.Effect<ParsedLoom> =>
        source.read(path).pipe(
          Effect.flatMap((text) => {
            const onBadDelims = (err: InvalidAnchorDelims) =>
              Effect.succeed(emptyDocument(text, err.message))
            return checkAnchorDelims(delims).pipe(
              Effect.andThen(sourceRanges.rangesOf(text)),
              Effect.map((ranges) =>
                pipe(
                  ranges,
                  classify.classifyWefts(text),
                  tokenise.tokeniseWefts(text, delims),
                  astBuilder.build,
                ),
              ),
              Effect.catchTag('MixedEOL', (err) => Effect.succeed(emptyDocumentFor(text, err))),
              Effect.catchTags({
                EmptyAnchorDelims: onBadDelims,
                IdenticalAnchorDelims: onBadDelims,
                WhitespaceAnchorDelims: onBadDelims,
                ReservedAnchorDelims: onBadDelims,
              }),
              Effect.map((tree): ParsedLoom => ({ path, text, tree })),
            )
          }),
          Effect.catchTag('ReadError', (err) =>
            Effect.succeed<ParsedLoom>({ path, text: '', tree: emptyDocument('', err.message) }),
          ),
        )

      const finish = (
        loom: ParsedLoom,
        primaryLanguage?: string,
        variables: Record<string, string> = {},
        declared: Declared = nothingDeclared,
      ): Effect.Effect<LoomModule> => {
        const doc = documents.build(loom.tree, declared)
        return products
          .build(doc, loom.path, primaryLanguage, variables)
          .pipe(Effect.map((product) => ({ path: loom.path, text: loom.text, doc, product })))
      }

      const build = (
        source: Source,
        path: Location,
        delims: AnchorDelims = defaultAnchorDelims,
        primaryLanguage?: string,
        variables: Record<string, string> = {},
        declared: Declared = nothingDeclared,
      ): Effect.Effect<LoomModule> =>
        parse(source, path, delims).pipe(
          Effect.flatMap((loom) => finish(loom, primaryLanguage, variables, declared)),
        )

      return { parse, finish, build }
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
        LoomDocumentBuilder.layer,
        ProductBuilder.layer,
      ),
    ),
  )
}
