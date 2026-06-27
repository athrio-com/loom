import { Array, Option, pipe, Schema } from 'effect'
import { type Diagnostic } from '#ast/LoomNode'
import { ProductSchema } from '#ast/ProductAst'
import { LoomDocumentSchema } from '#ast/LoomAst'
import { FrameModuleSchema } from '#ast/FrameAst'

export type Path = string

export const LoomModuleSchema = Schema.Struct({
  path: Schema.String,
  text: Schema.String,
  doc: LoomDocumentSchema,
  frame: FrameModuleSchema,
  product: Schema.optional(ProductSchema),
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

const diagnosticsIn = (node: unknown): ReadonlyArray<Diagnostic> => {
  if (Array.isArray(node)) return node.flatMap(diagnosticsIn)
  if (node === null || typeof node !== 'object') return []
  const self =
    'health' in node
      ? (node as { health: { diagnostics: ReadonlyArray<Diagnostic> } }).health
          .diagnostics
      : []
  const nested = Object.entries(node).flatMap(([key, value]) =>
    key === 'health' ? [] : diagnosticsIn(value),
  )
  return [...self, ...nested]
}

export const moduleDiagnostics = (
  module: LoomModule,
): ReadonlyArray<Diagnostic> => [
  ...diagnosticsIn(module.doc),
  ...diagnosticsIn(module.frame),
]

export const corpusErrors = (
  corpus: LoomCorpusAst,
): ReadonlyArray<{
  readonly path: Path
  readonly diagnostics: ReadonlyArray<Diagnostic>
}> =>
  pipe(
    Array.fromIterable(corpus.modules.values()),
    Array.filterMap((m) => {
      const diagnostics = Array.filter(
        moduleDiagnostics(m),
        (d) => d.severity === 'error',
      )
      return diagnostics.length === 0
        ? Option.none()
        : Option.some({ path: m.path, diagnostics })
    }),
  )
