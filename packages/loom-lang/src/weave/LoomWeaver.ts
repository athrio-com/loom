import { Context, Effect, FileSystem, Layer } from 'effect'
import { dirname } from 'node:path'
import { type Path } from '@athrio/loom-ast/LoomCorpusAst'
import { LoomCompiler } from '../LoomCompiler'

export class LoomWeaver extends Context.Service<LoomWeaver>()('LoomWeaver', {
  make: Effect.gen(function* () {
    const compiler = yield* LoomCompiler
    const fs = yield* FileSystem.FileSystem

    const weave = (entry: Path, out: Path): Effect.Effect<Path> =>
      compiler.weave(entry).pipe(
        Effect.map((corpus) => JSON.stringify(corpus, null, 2)),
        Effect.flatMap((json) =>
          fs
            .makeDirectory(dirname(out), { recursive: true })
            .pipe(
              Effect.andThen(fs.writeFileString(out, json)),
              Effect.orDie,
              Effect.as(out),
            ),
        ),
      )

    return { weave }
  }),
}) {
  static readonly layer = Layer.effect(this, this.make).pipe(
    Layer.provide(LoomCompiler.layer),
  )
}
