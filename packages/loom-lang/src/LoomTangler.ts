import { Array, Context, Effect, FileSystem, Layer, Option, Schema, pipe } from 'effect'
import { dirname, relative, resolve as resolvePath } from 'node:path'
import { type Path } from '@athrio/loom-ast/LoomCorpusAst'
import { workspaceRoot } from '@athrio/loom-lang-services/LoomStore'
import { LoomCompiler, type TangledFile, type TangleError } from './LoomCompiler'
import {
  emptyLock,
  orphansOf,
  pruned,
  recorded,
  LoomLockSchema,
  type LoomLock,
} from './LoomLock'

const ignoredSegment = new Set(['node_modules', '.loom', 'dist', '.git'])

const isStorePath = (name: string): boolean =>
  name.split('/').some((segment) => ignoredSegment.has(segment))

export class LoomTangler extends Context.Service<LoomTangler>()('LoomTangler', {
  make: Effect.gen(function* () {
    const compiler = yield* LoomCompiler
    const fs = yield* FileSystem.FileSystem

    const matchesDisk = (file: TangledFile): Effect.Effect<boolean> =>
      fs.readFileString(file.path).pipe(
        Effect.option,
        Effect.map(Option.contains(file.content)),
      )

    const writeFile = (file: TangledFile): Effect.Effect<TangledFile> =>
      matchesDisk(file).pipe(
        Effect.flatMap((same) =>
          same
            ? Effect.void
            : fs
                .makeDirectory(dirname(file.path), { recursive: true })
                .pipe(Effect.andThen(fs.writeFileString(file.path, file.content))),
        ),
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

    const loomsOf = (path: Path): Effect.Effect<ReadonlyArray<Path>> =>
      fs.stat(path).pipe(
        Effect.orDie,
        Effect.flatMap((info) =>
          info.type === 'Directory'
            ? loomsUnder(path)
            : Effect.succeed<ReadonlyArray<Path>>([path]),
        ),
      )

    const workspaceOf = (path: Path): Effect.Effect<Path> =>
      fs.stat(path).pipe(
        Effect.orDie,
        Effect.map((info) =>
          workspaceRoot(info.type === 'Directory' ? path : dirname(path)),
        ),
      )

    const lockFile = (root: Path): Path =>
      resolvePath(root, '.loom', 'loom.lock')

    const readLock = (root: Path): Effect.Effect<LoomLock> =>
      fs.readFileString(lockFile(root)).pipe(
        Effect.flatMap((text) => Effect.try(() => JSON.parse(text) as unknown)),
        Effect.flatMap(Schema.decodeUnknownEffect(LoomLockSchema)),
        Effect.orElseSucceed(() => emptyLock),
      )

    const writeLock = (root: Path, lock: LoomLock): Effect.Effect<void> =>
      fs
        .makeDirectory(dirname(lockFile(root)), { recursive: true })
        .pipe(
          Effect.andThen(
            fs.writeFileString(
              lockFile(root),
              JSON.stringify(lock, null, 2) + '\n',
            ),
          ),
          Effect.orDie,
        )

    const tangle = (
      path: Path,
    ): Effect.Effect<ReadonlyArray<TangledFile>, TangleError> =>
      Effect.gen(function* () {
        const looms = yield* loomsOf(path)
        const written = (yield* Effect.forEach(looms, tangleFile)).flat()
        const root = yield* workspaceOf(path)
        const lock = yield* readLock(root)
        yield* writeLock(
          root,
          recorded(lock, Array.map(written, (file) => relative(root, file.path))),
        )
        return written
      })

    const orphanState = (
      from: Path,
    ): Effect.Effect<
      {
        readonly root: Path
        readonly produced: ReadonlyArray<string>
        readonly orphans: ReadonlyArray<string>
      },
      TangleError
    > =>
      Effect.gen(function* () {
        const root = workspaceRoot(from)
        const looms = yield* loomsUnder(root)
        const files = (
          yield* Effect.forEach(looms, (loom) => compiler.tangle(loom))
        ).flat()
        const produced = Array.map(files, (file) => relative(root, file.path))
        const lock = yield* readLock(root)
        return { root, produced, orphans: orphansOf(lock, new Set(produced)) }
      })

    const orphans = (
      from: Path,
    ): Effect.Effect<ReadonlyArray<Path>, TangleError> =>
      orphanState(from).pipe(
        Effect.map(({ root, orphans }) =>
          Array.map(orphans, (rel) => resolvePath(root, rel)),
        ),
      )

    const prune = (
      from: Path,
    ): Effect.Effect<ReadonlyArray<Path>, TangleError> =>
      Effect.gen(function* () {
        const { root, produced, orphans } = yield* orphanState(from)
        yield* Effect.forEach(orphans, (rel) =>
          fs.remove(resolvePath(root, rel), { force: true }).pipe(Effect.orDie),
        )
        yield* writeLock(root, pruned(produced))
        return Array.map(orphans, (rel) => resolvePath(root, rel))
      })

    return { tangle, orphans, prune }
  }),
}) {
  static readonly layer = Layer.effect(this, this.make).pipe(
    Layer.provide(LoomCompiler.layer),
  )
}
