import { Array, Effect, pipe } from 'effect'
import { FileSystem } from '@effect/platform'
import { dirname, resolve as resolvePath } from 'node:path'
import { type Path } from '@athrio/loom-ast/LoomCorpusAst'
import { LoomCompiler, type TangledFile, type TangleError } from './LoomCompiler'

export class LoomTangler extends Effect.Service<LoomTangler>()('LoomTangler', {
  effect: Effect.gen(function* () {
    const compiler = yield* LoomCompiler
    const fs = yield* FileSystem.FileSystem

    const writeFile = (file: TangledFile): Effect.Effect<TangledFile> =>
      fs
        .makeDirectory(dirname(file.path), { recursive: true })
        .pipe(
          Effect.zipRight(fs.writeFileString(file.path, file.content)),
          Effect.orDie,
          Effect.as(file),
        )

    const tangleFile = (
      entry: Path,
    ): Effect.Effect<ReadonlyArray<TangledFile>, TangleError> =>
      compiler
        .tangle(entry)
        .pipe(Effect.flatMap((files) => Effect.forEach(files, writeFile)))

    const loomsUnder = (dir: Path): Effect.Effect<ReadonlyArray<Path>> =>
      fs.readDirectory(dir, { recursive: true }).pipe(
        Effect.map((names) =>
          pipe(
            names,
            Array.filter((name) => name.endsWith('.loom')),
            Array.map((name) => resolvePath(dir, name)),
          ),
        ),
        Effect.orDie,
      )

    const tangle = (
      path: Path,
    ): Effect.Effect<ReadonlyArray<TangledFile>, TangleError> =>
      Effect.gen(function* () {
        const info = yield* fs.stat(path).pipe(Effect.orDie)
        const files =
          info.type === 'Directory' ? yield* loomsUnder(path) : [path]
        return (yield* Effect.forEach(files, tangleFile)).flat()
      })

    return { tangle }
  }),
  dependencies: [LoomCompiler.Default],
}) {}
