import { Array, Effect, Option, pipe } from 'effect'
import { dirname, resolve as resolvePath } from 'node:path'
import { defaultAnchorDelims, type AnchorDelims } from '#ast/LoomTokens'
import { LoomSourceRanges } from '#ast/LineRanges'
import { WeftClassifier } from '#ast/WeftClassifier'
import { WeftTokeniser } from '#ast/WeftTokeniser'
import { LoomAstBuilder, emptyDocumentFor } from '#ast/LoomAstBuilder'
import type { FrameModule } from '#ast/FrameAst'
import { FrameAstBuilder } from '#ast/FrameAstBuilder'
import { ProductAstBuilder } from '#ast/ProductAstBuilder'
import type { LoomModule, Path } from '#ast/LoomCorpusAst'

export interface Source {
  readonly read: (path: Path) => Effect.Effect<string>
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
      const productBuilder = yield* ProductAstBuilder

      const build = (
        source: Source,
        path: Path,
        delims: AnchorDelims = defaultAnchorDelims,
      ): Effect.Effect<LoomModule> =>
        Effect.gen(function* () {
          const text = yield* source.read(path)
          const doc = yield* sourceRanges.stream(text).pipe(
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
          )
          const frame = yield* frames.build(doc)
          const imports = pipe(
            frame.imports,
            Array.filterMap((i) =>
              pipe(
                specifierOf(i.text),
                Option.flatMap((spec) => locate(path, spec)),
              ),
            ),
          )
          const code = yield* productBuilder.build({
            path,
            text,
            frame,
            imports: importBindingsOf(path, frame),
          })
          return { path, text, doc, frame, code, imports }
        })

      return { build }
    }),
    dependencies: [
      LoomSourceRanges.Default,
      WeftClassifier.Default,
      WeftTokeniser.Default,
      LoomAstBuilder.Default,
      FrameAstBuilder.Default,
      ProductAstBuilder.Default,
    ],
  },
) {}

const specifierOf = (importLine: string): Option.Option<string> =>
  pipe(
    Option.fromNullable(importLine.match(/from\s*["']([^"']+)["']/)),
    Option.flatMap((m) => Option.fromNullable(m[1])),
  )

const namesOf = (importLine: string): ReadonlyArray<string> =>
  pipe(
    Option.fromNullable(importLine.match(/\{([^}]*)\}/)),
    Option.flatMap((m) => Option.fromNullable(m[1])),
    Option.match({
      onNone: () => [],
      onSome: (inner) =>
        pipe(
          inner.split(','),
          Array.map((s) => s.trim()),
          Array.filter((s) => s.length > 0 && !s.includes(' as ')),
        ),
    }),
  )

const locate = (
  hostFile: Path,
  importSpecifier: string,
): Option.Option<Path> =>
  importSpecifier.endsWith('.loom')
    ? Option.some(resolvePath(dirname(hostFile), importSpecifier))
    : Option.none()

const importBindingsOf = (
  hostFile: Path,
  frame: FrameModule,
): ReadonlyMap<string, Path> =>
  new Map(
    pipe(
      frame.imports,
      Array.flatMap((line) =>
        pipe(
          specifierOf(line.text),
          Option.flatMap((spec) => locate(hostFile, spec)),
          Option.match({
            onNone: (): ReadonlyArray<readonly [string, Path]> => [],
            onSome: (p) => Array.map(namesOf(line.text), (n) => [n, p] as const),
          }),
        ),
      ),
    ),
  )
