import { Array, Option, pipe, Schema } from 'effect'
import { LoomDocumentSchema } from '#ast/LoomAst'
import { FrameModuleSchema } from '#ast/FrameAst'
import { ComposedCodeSchema } from '#ast/ProductAst'

// =============================================================================
// LoomCorpusAst — the multi-file AST: pure data, no pipeline (that is
// `LoomCorpusAstBuilder`). Every loaded `.loom` is a `LoomModule` keyed by path,
// carrying its whole per-file stack: source, parse (`doc`), the frame pass
// (`frame`), the de re structure (`code` — name → ComposedCode), and its resolved
// import edges. So both
// planes sit together per module — Frame (de dicto) and ComposedCode (de re) — and
// the corpus is uniformly `{ modules }`. The cross-file de re graph is distributed:
// a section's `Ref`s point at other modules by key, followed by `fromProduct`.
//
// Edges live in each module's `imports`; the queries below read them (reverse
// reachability drives invalidation). A derived Effect `Graph` will eventually
// subsume them (cycles / topo / `toMermaid`), per how-frame.
// =============================================================================

export type Path = string // a resolved `.loom` path — the module's identity

export const LoomModuleSchema = Schema.Struct({
  path: Schema.String,
  text: Schema.String, // raw source — the de re slices EmbeddedCode from it by offset
  doc: LoomDocumentSchema, // parse
  frame: FrameModuleSchema, // the frame pass
  code: Schema.ReadonlyMap({ key: Schema.String, value: ComposedCodeSchema }), // the de re structure — name → ComposedCode
  imports: Schema.Array(Schema.String), // resolved `.loom` deps, from the {Loom} imports
})
export type LoomModule = typeof LoomModuleSchema.Type

export const LoomCorpusAstSchema = Schema.Struct({
  modules: Schema.ReadonlyMap({ key: Schema.String, value: LoomModuleSchema }),
})
export type LoomCorpusAst = typeof LoomCorpusAstSchema.Type

// =============================================================================
// Graph queries over the module import edges — pure readers on the module set.
// =============================================================================

type Modules = ReadonlyMap<Path, LoomModule>

// dependenciesOf — the `.loom` files `path` imports (forward edges).
export const dependenciesOf = (
  modules: Modules,
  path: Path,
): ReadonlyArray<Path> =>
  pipe(
    Option.fromNullable(modules.get(path)),
    Option.match({ onNone: () => [], onSome: (m) => m.imports }),
  )

// dependentsOf — the `.loom` files that import `path` (reverse edges).
export const dependentsOf = (
  modules: Modules,
  path: Path,
): ReadonlyArray<Path> =>
  pipe(
    Array.fromIterable(modules.values()),
    Array.filter((m) => m.imports.includes(path)),
    Array.map((m) => m.path),
  )

// transitiveDependents — reverse reachability: every file whose de re must
// re-project when `path` changes (it inlined `path`'s code, transitively).
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
