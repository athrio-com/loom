import { Context, Effect, FileSystem, Layer } from 'effect'
import { type Path } from '@athrio/loom-ast/LoomCorpusAst'
import { LoomCompiler } from '../LoomCompiler'

export class LoomContents extends Context.Service<LoomContents>()('LoomContents', {
  make: Effect.gen(function* () {
    const compiler = yield* LoomCompiler
    const fs = yield* FileSystem.FileSystem

    const write = (entry: Path): Effect.Effect<Path> =>
      compiler.contents(entry).pipe(
        Effect.flatMap((text) =>
          fs.writeFileString(entry, text).pipe(Effect.orDie, Effect.as(entry)),
        ),
      )

    return { write }
  }),
}) {
  static readonly layer = Layer.effect(this, this.make).pipe(
    Layer.provide(LoomCompiler.layer),
  )
}
