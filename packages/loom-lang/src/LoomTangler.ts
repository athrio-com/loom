import { Array, Effect, pipe } from 'effect'
import { FileSystem } from '@effect/platform'
import { dirname, resolve as resolvePath } from 'node:path'
import { type Path } from '@athrio/loom-ast/LoomCorpusAst'
import { LoomCompiler, type TangledFile, type TangleError } from './LoomCompiler'

const ignoredSegment = new Set(['node_modules', '.loom', 'dist', '.git'])

const isStorePath = (name: string): boolean =>
  name.split('/').some((segment) => ignoredSegment.has(segment))

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
        Effect.orDie,
        Effect.map((names) =>
          pipe(
            names,
            Array.filter((name) => name.endsWith('.loom') && !isStorePath(name)),
            Array.map((name) => resolvePath(dir, name)),
          ),
        ),
      )

    const tangle = (
      path: Path,
    ): Effect.Effect<ReadonlyArray<TangledFile>, TangleError> =>
      Effect.gen(function* () {
        const info = yield* fs.stat(path).pipe(Effect.orDie)
        const looms =
          info.type === 'Directory' ? yield* loomsUnder(path) : [path]
        const written = yield* Effect.forEach(looms, tangleFile)
        return written.flat()
      })

    return { tangle }
  }),
  dependencies: [LoomCompiler.Default],
}) {}
