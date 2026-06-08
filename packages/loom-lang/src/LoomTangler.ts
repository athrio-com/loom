import { Array, Effect, Option, pipe } from 'effect'
import { FileSystem } from '@effect/platform'
import { dirname, resolve as resolvePath } from 'node:path'
import { type FrameModule } from '#ast/FrameAst'
import { type Path } from '#ast/LoomCorpusAst'
import { fromProduct } from '#ast/LoomVirtualCodeBuilder'
import { codeOf, LoomCompiler } from './LoomCompiler'

// =============================================================================
// LoomTangler — the filesystem surface of the de re plane. `tangle(path)` takes a
// `.loom` file or a directory: for a file it builds the corpus reachable from it,
// finds its `{path}` sinks, composes each — anchors and Warps resolved across
// imports by `fromProduct` — and writes the result to disk; for a directory it
// does the same for every `.loom` beneath it. This is the half of the pipeline the
// editor never runs: the editor projects to Volar virtual code, the tangler emits
// real source files. It is the one place that both reads and writes files.
//
// Sink paths are written relative to each `.loom` file's own directory: a doc that
// declares `{src/main.ts}` emits `<dir-of-doc>/src/main.ts`.
// =============================================================================

// TangledFile — one emitted file: the sink section that produced it, and where it
// landed on disk.
export interface TangledFile {
  readonly section: string
  readonly path: Path
}

export class LoomTangler extends Effect.Service<LoomTangler>()('LoomTangler', {
  effect: Effect.gen(function* () {
    const compiler = yield* LoomCompiler
    const fs = yield* FileSystem.FileSystem

    // tangle one `.loom`: build its corpus, compose each `{path}` sink, write it.
    const tangleFile = (
      entry: Path,
    ): Effect.Effect<ReadonlyArray<TangledFile>> =>
      Effect.gen(function* () {
        // build the corpus (entry + its `{Loom}` imports) once, then read the
        // entry's frame to find its sinks.
        const { modules } = yield* compiler.corpus(entry)
        const codeByPath = codeOf(modules)
        const entryModule = yield* Effect.fromNullable(modules.get(entry)).pipe(
          Effect.orDie,
        )

        return yield* Effect.forEach(sinksOf(entryModule.frame), (sink) =>
          Effect.gen(function* () {
            // fromProduct flattens the sink's composition — following each anchor
            // across the corpus — to the file's text.
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

    // loomsUnder — every `.loom` beneath a directory, recursively.
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

    // tangle — a single `.loom`, or every `.loom` under a directory.
    const tangle = (
      path: Path,
    ): Effect.Effect<ReadonlyArray<TangledFile>> =>
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

// sinksOf — a frame's tangle sinks: each ServiceClass whose body is a TangleBody,
// paired with its output `{path}` and the section name to compose for it.
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
