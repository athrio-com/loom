import { Array, Data, Effect, Option, pipe } from 'effect'
import { dirname, resolve as resolvePath } from 'node:path'
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
import { FrameAstBuilder } from '#ast/FrameAstBuilder'
import type { LoomModule, Path } from '@athrio/loom-ast/LoomCorpusAst'

export interface Source {
  readonly read: (path: Path) => Effect.Effect<string, ReadError>
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

export class LoomCorpusAstBuilder extends Effect.Service<LoomCorpusAstBuilder>()(
  'LoomCorpusAstBuilder',
  {
    effect: Effect.gen(function* () {
      const sourceRanges = yield* LoomSourceRanges
      const classify = yield* WeftClassifier
      const tokenise = yield* WeftTokeniser
      const astBuilder = yield* LoomAstBuilder
      const frames = yield* FrameAstBuilder

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
              Effect.zipRight(sourceRanges.stream(text)),
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
          const frame = yield* frames.build(doc, path, primaryLanguage)
          const imports = pipe(
            frame.imports,
            Array.filterMap((i) =>
              pipe(
                specifierOf(i.text),
                Option.flatMap((spec) => locate(path, spec)),
              ),
            ),
          )
          return { path, text, doc, frame, imports }
        })

      return { build }
    }),
    dependencies: [
      LoomSourceRanges.Default,
      WeftClassifier.Default,
      WeftTokeniser.Default,
      LoomAstBuilder.Default,
      FrameAstBuilder.Default,
    ],
  },
) {}

const specifierOf = (importLine: string): Option.Option<string> =>
  pipe(
    Option.fromNullable(importLine.match(/from\s*["']([^"']+)["']/)),
    Option.flatMap((m) => Option.fromNullable(m[1])),
  )

const locate = (
  hostFile: Path,
  importSpecifier: string,
): Option.Option<Path> =>
  importSpecifier.endsWith('.loom')
    ? Option.some(resolvePath(dirname(hostFile), importSpecifier))
    : Option.none()
