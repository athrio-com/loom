import { Context, Effect, FileSystem, Layer } from 'effect'
import type { ReadError } from '#ast/LoomCorpusAstBuilder'
import { type Path } from '../LoomProject'
import { LoomCompiler } from '../LoomCompiler'
import { found, type NotWritten, writeText } from '../LoomTangler'

export class LoomWeaver extends Context.Service<LoomWeaver>()('LoomWeaver', {
  make: Effect.gen(function* () {
    const compiler = yield* LoomCompiler
    const fs = yield* FileSystem.FileSystem

    const weave = (entry: Path, out: Path): Effect.Effect<Path, ReadError | NotWritten> =>
      found(fs, entry).pipe(
        Effect.andThen(compiler.weave(entry)),
        Effect.map((corpus) => JSON.stringify(corpus, null, 2)),
        Effect.flatMap((json) => writeText(fs, out, json)),
        Effect.as(out),
      )

    return { weave }
  }),
}) {
  static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(LoomCompiler.layer))
}
