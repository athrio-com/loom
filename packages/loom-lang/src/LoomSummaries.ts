import { Context, Effect, FileSystem, Layer } from 'effect'
import { type Path } from './LoomProject'
import { LoomCompiler } from './LoomCompiler'

export class LoomSummaries extends Context.Service<LoomSummaries>()('LoomSummaries', {
  make: Effect.gen(function* () {
    const compiler = yield* LoomCompiler
    const fs = yield* FileSystem.FileSystem

    const write = (entry: Path): Effect.Effect<ReadonlyArray<Path>> =>
      compiler
        .summaries(entry)
        .pipe(
          Effect.flatMap((looms) =>
            Effect.forEach(looms, (loom) =>
              fs.writeFileString(loom.path, loom.text).pipe(Effect.orDie, Effect.as(loom.path)),
            ),
          ),
        )

    return { write }
  }),
}) {
  static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(LoomCompiler.layer))
}
