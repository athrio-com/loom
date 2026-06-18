import { Array, Option, pipe, Schema } from 'effect'
import { LoomDocumentSchema } from '#ast/LoomAst'
import { FrameModuleSchema } from '#ast/FrameAst'
import { ComposedCodeSchema } from '#ast/ProductAst'

export type Path = string

export const LoomModuleSchema = Schema.Struct({
  path: Schema.String,
  text: Schema.String,
  doc: LoomDocumentSchema,
  frame: FrameModuleSchema,
  code: Schema.ReadonlyMap({ key: Schema.String, value: ComposedCodeSchema }),
  imports: Schema.Array(Schema.String),
})
export type LoomModule = typeof LoomModuleSchema.Type

export const LoomCorpusAstSchema = Schema.Struct({
  modules: Schema.ReadonlyMap({ key: Schema.String, value: LoomModuleSchema }),
})
export type LoomCorpusAst = typeof LoomCorpusAstSchema.Type

type Modules = ReadonlyMap<Path, LoomModule>

export const dependenciesOf = (
  modules: Modules,
  path: Path,
): ReadonlyArray<Path> =>
  pipe(
    Option.fromNullable(modules.get(path)),
    Option.match({ onNone: () => [], onSome: (m) => m.imports }),
  )

export const dependentsOf = (
  modules: Modules,
  path: Path,
): ReadonlyArray<Path> =>
  pipe(
    Array.fromIterable(modules.values()),
    Array.filter((m) => m.imports.includes(path)),
    Array.map((m) => m.path),
  )

export const transitiveDependents = (
  modules: Modules,
  path: Path,
): ReadonlyArray<Path> => {
  const grow = (
    acc: ReadonlySet<Path>,
    frontier: ReadonlyArray<Path>,
  ): ReadonlySet<Path> => {
    const next = pipe(
      frontier,
      Array.flatMap((p) => dependentsOf(modules, p)),
      Array.filter((d) => !acc.has(d)),
      Array.dedupe,
    )
    return next.length === 0 ? acc : grow(new Set([...acc, ...next]), next)
  }
  return pipe(
    Array.fromIterable(grow(new Set<Path>(), [path])),
    Array.filter((p) => p !== path),
  )
}
