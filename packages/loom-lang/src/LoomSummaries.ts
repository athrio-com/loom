import { Context, Effect, FileSystem, Layer } from 'effect'
import type { ReadError } from '#ast/LoomCorpusAstBuilder'
import { type Path } from './LoomProject'
import { LoomCompiler } from './LoomCompiler'
import { found, type NotWritten, writeText } from './LoomTangler'

export class LoomSummaries extends Context.Service<LoomSummaries>()('LoomSummaries', {
  make: Effect.gen(function* () {
    const compiler = yield* LoomCompiler
    const fs = yield* FileSystem.FileSystem

    const write = (entry: Path): Effect.Effect<ReadonlyArray<Path>, ReadError | NotWritten> =>
      found(fs, entry).pipe(
        Effect.andThen(compiler.summaries(entry)),
        Effect.flatMap((looms) =>
          Effect.forEach(looms, (loom) =>
            writeText(fs, loom.path, loom.text).pipe(Effect.as(loom.path)),
          ),
        ),
      )

    return { write }
  }),
}) {
  static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(LoomCompiler.layer))
}
