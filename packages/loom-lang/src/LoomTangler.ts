import { Array, Data, Effect, Option, pipe } from 'effect'
import { FileSystem } from '@effect/platform'
import { dirname, resolve as resolvePath } from 'node:path'
import { type FrameModule } from '#ast/FrameAst'
import { type Diagnostic } from '#ast/LoomNode'
import { corpusErrors, type Path } from '#ast/LoomCorpusAst'
import { fromProduct } from '#ast/LoomVirtualCodeBuilder'
import { codeOf, LoomCompiler } from './LoomCompiler'

export interface TangledFile {
  readonly section: string
  readonly path: Path
}

export class LoomTangler extends Effect.Service<LoomTangler>()('LoomTangler', {
  effect: Effect.gen(function* () {
    const compiler = yield* LoomCompiler
    const fs = yield* FileSystem.FileSystem

    const tangleFile = (
      entry: Path,
    ): Effect.Effect<ReadonlyArray<TangledFile>, TangleError> =>
      Effect.gen(function* () {
        const corpus = yield* compiler.corpus(entry)
        const failures = corpusErrors(corpus)
        if (failures.length > 0) {
          return yield* Effect.fail(new TangleError({ entry, failures }))
        }

        const codeByPath = codeOf(corpus.modules)
        const entryModule = yield* Effect.fromNullable(
          corpus.modules.get(entry),
        ).pipe(Effect.orDie)

        return yield* Effect.forEach(sinksOf(entryModule.frame), (sink) =>
          Effect.gen(function* () {
            const content = fromProduct(codeByPath, {
              path: entry,
              name: sink.name,
            }).code
            const target = resolvePath(dirname(entry), sink.path)
            yield* fs
              .makeDirectory(dirname(target), { recursive: true })
              .pipe(Effect.orDie)
            yield* fs.writeFileString(target, content).pipe(Effect.orDie)
            return { section: sink.name, path: target }
          }),
        )
      })

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

const sinksOf = (
  frame: FrameModule,
): ReadonlyArray<{ readonly name: string; readonly path: string }> =>
  pipe(
    frame.members,
    Array.map((m) => m.value),
    Array.filterMap((v) =>
      v.type === 'ServiceClass' && v.body.type === 'TangleBody'
        ? Option.some({ name: v.name.text, path: v.body.path.text })
        : Option.none(),
    ),
  )

export class TangleError extends Data.TaggedError('TangleError')<{
  readonly entry: Path
  readonly failures: ReadonlyArray<{
    readonly path: Path
    readonly diagnostics: ReadonlyArray<Diagnostic>
  }>
}> {
  get message(): string {
    const count = this.failures.reduce((n, f) => n + f.diagnostics.length, 0)
    const lines = this.failures.flatMap((f) =>
      f.diagnostics.map(
        (d) => `  ${f.path}:${d.position.start.line}: ${d.message}`,
      ),
    )
    return `loom: refusing to tangle ${this.entry} — ${count} error(s) across the corpus:\n${lines.join('\n')}`
  }
}
