import { Array, Option, pipe, Schema } from 'effect'
import { type Diagnostic } from '#ast/LoomNode'
import { ProductSchema } from '#ast/ProductAst'
import { LoomDocumentSchema, type LoomSection } from '#ast/LoomAst'
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

type SectionRef = { readonly module: Path; readonly section: LoomSection }

const dirLabelOf = (section: LoomSection): Option.Option<string> =>
  section.heading.specifier?.type === 'DirSpecifier'
    ? Option.some(section.heading.specifier.label.value)
    : Option.none()

const joinDir = (parent: string, child: string): string =>
  parent === '' ? child : `${parent.replace(/\/$/, '')}/${child}`

const sectionTitles = (modules: Modules): ReadonlyMap<string, SectionRef> =>
  pipe(
    Array.fromIterable(modules.values()),
    Array.flatMap((m) =>
      Array.filterMap(m.doc.sections, (section) =>
        Option.map(
          Option.fromNullable(section.heading.title),
          (title) => [title.source, { module: m.path, section }] as const,
        ),
      ),
    ),
    Array.reduce(
      new Map<string, SectionRef>(),
      (index, [title, ref]) =>
        index.has(title) ? index : new Map(index).set(title, ref),
    ),
  )

type Member = { readonly name: string; readonly reroute: Option.Option<string> }

const membersOf = (section: LoomSection): ReadonlyArray<Member> =>
  pipe(
    section.code,
    Array.flatMap((weft) =>
      weft.type === 'ArrowWeft' || weft.type === 'CodeWeft'
        ? Array.map(weft.anchors, (a) => ({
            name: a.name.value,
            reroute:
              a.specifier?.type === 'DirSpecifier'
                ? Option.some(a.specifier.label.value)
                : Option.none<string>(),
          }))
        : [],
    ),
  )

const dirSinks = (modules: Modules): ReadonlyArray<SectionRef> =>
  pipe(
    Array.fromIterable(modules.values()),
    Array.flatMap((m) =>
      Array.filterMap(m.doc.sections, (section) =>
        Option.isSome(dirLabelOf(section))
          ? Option.some<SectionRef>({ module: m.path, section })
          : Option.none<SectionRef>(),
      ),
    ),
  )

const rootSinks = (
  modules: Modules,
  index: ReadonlyMap<string, SectionRef>,
): ReadonlyArray<SectionRef> => {
  const sinks = dirSinks(modules)
  const nested = pipe(
    sinks,
    Array.flatMap((d) =>
      Array.filterMap(membersOf(d.section), (member) =>
        pipe(
          Option.fromNullable(index.get(member.name)),
          Option.filter((ref) => Option.isSome(dirLabelOf(ref.section))),
          Option.map((ref) => ref.section),
        ),
      ),
    ),
    (reached) => new Set(reached),
  )
  return Array.filter(sinks, (d) => !nested.has(d.section))
}

export const sinkTreeRouting = (
  corpus: LoomCorpusAst,
): ReadonlyMap<Path, string> => {
  const modules = corpus.modules
  const index = sectionTitles(modules)

  const routeMember = (
    prefix: string,
    seen: ReadonlySet<LoomSection>,
    acc: ReadonlyMap<Path, string>,
    member: Member,
  ): ReadonlyMap<Path, string> => {
    const ref = index.get(member.name)
    if (ref === undefined) return acc
    const at = Option.getOrElse(member.reroute, () => prefix)
    const label = dirLabelOf(ref.section)
    if (Option.isNone(label)) return new Map(acc).set(ref.module, at)
    if (seen.has(ref.section)) return acc
    return walk(
      ref.section,
      joinDir(at, label.value),
      new Set([...seen, ref.section]),
      acc,
    )
  }

  const walk = (
    section: LoomSection,
    prefix: string,
    seen: ReadonlySet<LoomSection>,
    routing: ReadonlyMap<Path, string>,
  ): ReadonlyMap<Path, string> =>
    Array.reduce(membersOf(section), routing, (acc, member) =>
      routeMember(prefix, seen, acc, member),
    )

  return Array.reduce(
    rootSinks(modules, index),
    new Map<Path, string>() as ReadonlyMap<Path, string>,
    (acc, root) =>
      walk(
        root.section,
        Option.getOrElse(dirLabelOf(root.section), () => ''),
        new Set([root.section]),
        acc,
      ),
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
