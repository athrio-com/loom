import { Array, Option, pipe, Schema } from 'effect'
import { type Diagnostic, type Position } from '#ast/LoomNode'
import { type WarpAnchorToken } from '#ast/LoomTokens'
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

export type SinkFault =
  | { readonly kind: 'CollidingTitles'; readonly path: Path; readonly position: Position; readonly name: string }
  | { readonly kind: 'SinkCycle'; readonly path: Path; readonly position: Position; readonly name: string }
  | { readonly kind: 'EmptySink'; readonly path: Path; readonly position: Position; readonly directory: string }
  | { readonly kind: 'UnresolvedReroute'; readonly path: Path; readonly position: Position; readonly directory: string }
  | { readonly kind: 'MisplacedSpecifier'; readonly path: Path; readonly position: Position; readonly specifier: string }

type Located = { readonly path: Path; readonly section: LoomSection }

const located = (modules: Modules): ReadonlyArray<Located> =>
  pipe(
    Array.fromIterable(modules.values()),
    Array.flatMap((m) =>
      Array.map(m.doc.sections, (section) => ({ path: m.path, section })),
    ),
  )

const headingPosition = (section: LoomSection): Position =>
  section.heading.title?.position ??
  section.heading.specifier?.position ??
  section.heading.position

const anchorsOf = (section: LoomSection): ReadonlyArray<WarpAnchorToken> =>
  pipe(
    section.code,
    Array.flatMap((weft) =>
      weft.type === 'ArrowWeft' || weft.type === 'CodeWeft' ? weft.anchors : [],
    ),
  )

const collidingTitles = (
  sections: ReadonlyArray<Located>,
  normalise: (title: string) => string,
): ReadonlyArray<SinkFault> =>
  pipe(
    sections,
    Array.filterMap((loc) =>
      Option.map(Option.fromNullable(loc.section.heading.title), (title) => ({
        loc,
        title,
        name: normalise(title.source),
      })),
    ),
    Array.groupBy((s) => s.name),
    (groups) => Object.values(groups),
    Array.filter((group) => group.length > 1),
    Array.flatMap((group) =>
      Array.map(
        group,
        (s): SinkFault => ({
          kind: 'CollidingTitles',
          path: s.loc.path,
          position: s.title.position,
          name: s.name,
        }),
      ),
    ),
  )

const misplacedSpecifiers = (
  sections: ReadonlyArray<Located>,
): ReadonlyArray<SinkFault> =>
  pipe(
    sections,
    Array.filter((loc) => Option.isNone(dirLabelOf(loc.section))),
    Array.flatMap((loc) =>
      Array.filterMap(anchorsOf(loc.section), (anchor) =>
        Option.map(
          Option.fromNullable(anchor.specifier),
          (specifier): SinkFault => ({
            kind: 'MisplacedSpecifier',
            path: loc.path,
            position: specifier.position,
            specifier: specifier.label.value,
          }),
        ),
      ),
    ),
  )

const emptySinks = (modules: Modules): ReadonlyArray<SinkFault> =>
  Array.filterMap(dirSinks(modules), (ref) =>
    membersOf(ref.section).length === 0
      ? Option.some<SinkFault>({
          kind: 'EmptySink',
          path: ref.module,
          position: headingPosition(ref.section),
          directory: Option.getOrElse(dirLabelOf(ref.section), () => ''),
        })
      : Option.none(),
  )

const unresolvedReroutes = (modules: Modules): ReadonlyArray<SinkFault> => {
  const declared = new Set(
    Array.filterMap(dirSinks(modules), (ref) => dirLabelOf(ref.section)),
  )
  return pipe(
    dirSinks(modules),
    Array.flatMap((ref) =>
      Array.filterMap(anchorsOf(ref.section), (anchor) =>
        anchor.specifier?.type === 'DirSpecifier' &&
        !declared.has(anchor.specifier.label.value)
          ? Option.some<SinkFault>({
              kind: 'UnresolvedReroute',
              path: ref.module,
              position: anchor.specifier.position,
              directory: anchor.specifier.label.value,
            })
          : Option.none(),
      ),
    ),
  )
}

const sinkCycles = (modules: Modules): ReadonlyArray<SinkFault> => {
  const index = sectionTitles(modules)
  const childSinks = (section: LoomSection): ReadonlyArray<SectionRef> =>
    Array.filterMap(membersOf(section), (member) =>
      pipe(
        Option.fromNullable(index.get(member.name)),
        Option.filter((ref) => Option.isSome(dirLabelOf(ref.section))),
      ),
    )
  const reaches = (
    from: LoomSection,
    target: LoomSection,
    seen: ReadonlySet<LoomSection>,
  ): boolean =>
    Array.some(childSinks(from), (ref) =>
      ref.section === target
        ? true
        : seen.has(ref.section)
          ? false
          : reaches(ref.section, target, new Set([...seen, ref.section])),
    )
  return Array.filterMap(dirSinks(modules), (ref) =>
    reaches(ref.section, ref.section, new Set([ref.section]))
      ? Option.some<SinkFault>({
          kind: 'SinkCycle',
          path: ref.module,
          position: headingPosition(ref.section),
          name:
            ref.section.heading.title?.source ??
            Option.getOrElse(dirLabelOf(ref.section), () => ''),
        })
      : Option.none(),
  )
}

export const sinkTreeFaults = (
  corpus: LoomCorpusAst,
  normalise: (title: string) => string,
): ReadonlyArray<SinkFault> => {
  const modules = corpus.modules
  const sections = located(modules)
  return [
    ...collidingTitles(sections, normalise),
    ...misplacedSpecifiers(sections),
    ...emptySinks(modules),
    ...unresolvedReroutes(modules),
    ...sinkCycles(modules),
  ]
}

export type CorpusLocation = { readonly path: Path; readonly position: Position }

const anchorAt = (
  modules: Modules,
  path: Path,
  offset: number,
): Option.Option<WarpAnchorToken> =>
  pipe(
    Option.fromNullable(modules.get(path)),
    Option.flatMap((m) =>
      Array.findFirst(
        Array.flatMap(m.doc.sections, anchorsOf),
        (anchor) =>
          anchor.position.start.offset <= offset &&
          offset <= anchor.position.end.offset,
      ),
    ),
  )

const titledSectionAt = (
  modules: Modules,
  path: Path,
  offset: number,
): Option.Option<LoomSection> =>
  pipe(
    Option.fromNullable(modules.get(path)),
    Option.flatMap((m) =>
      Array.findFirst(m.doc.sections, (section) => {
        const title = section.heading.title
        return (
          title !== undefined &&
          title.position.start.offset <= offset &&
          offset <= title.position.end.offset
        )
      }),
    ),
  )

const titleAt = (
  modules: Modules,
  path: Path,
  offset: number,
): Option.Option<string> =>
  pipe(
    titledSectionAt(modules, path, offset),
    Option.flatMapNullable((section) => section.heading.title),
    Option.map((title) => title.source),
  )

const headingNamed = (
  index: ReadonlyMap<string, SectionRef>,
  name: string,
): Option.Option<CorpusLocation> =>
  pipe(
    Option.fromNullable(index.get(name)),
    Option.flatMap((ref) =>
      Option.map(
        Option.fromNullable(ref.section.heading.title),
        (title): CorpusLocation => ({ path: ref.module, position: title.position }),
      ),
    ),
  )

const anchorsNamed = (
  modules: Modules,
  name: string,
): ReadonlyArray<CorpusLocation> =>
  pipe(
    Array.fromIterable(modules.values()),
    Array.flatMap((m) =>
      Array.filterMap(Array.flatMap(m.doc.sections, anchorsOf), (anchor) =>
        anchor.name.value === name
          ? Option.some<CorpusLocation>({ path: m.path, position: anchor.position })
          : Option.none(),
      ),
    ),
  )

export const definitionAt = (
  corpus: LoomCorpusAst,
  path: Path,
  offset: number,
): Option.Option<CorpusLocation> =>
  pipe(
    anchorAt(corpus.modules, path, offset),
    Option.flatMap((anchor) =>
      headingNamed(sectionTitles(corpus.modules), anchor.name.value),
    ),
  )

export const referencesAt = (
  corpus: LoomCorpusAst,
  path: Path,
  offset: number,
): ReadonlyArray<CorpusLocation> => {
  const modules = corpus.modules
  const name = Option.orElse(titleAt(modules, path, offset), () =>
    Option.map(anchorAt(modules, path, offset), (anchor) => anchor.name.value),
  )
  return Option.match(name, {
    onNone: () => [],
    onSome: (n) => [
      ...Option.match(headingNamed(sectionTitles(modules), n), {
        onNone: () => [],
        onSome: (loc) => [loc],
      }),
      ...anchorsNamed(modules, n),
    ],
  })
}

const headingTitlesNamed = (
  modules: Modules,
  name: string,
): ReadonlyArray<CorpusLocation> =>
  pipe(
    Array.fromIterable(modules.values()),
    Array.flatMap((m) =>
      Array.filterMap(m.doc.sections, (section) => {
        const title = section.heading.title
        return title !== undefined && title.source === name
          ? Option.some<CorpusLocation>({ path: m.path, position: title.position })
          : Option.none()
      }),
    ),
  )

const anchorNamesNamed = (
  modules: Modules,
  name: string,
): ReadonlyArray<CorpusLocation> =>
  pipe(
    Array.fromIterable(modules.values()),
    Array.flatMap((m) =>
      Array.filterMap(Array.flatMap(m.doc.sections, anchorsOf), (anchor) =>
        anchor.name.value === name
          ? Option.some<CorpusLocation>({ path: m.path, position: anchor.name.position })
          : Option.none(),
      ),
    ),
  )

export const renameAt = (
  corpus: LoomCorpusAst,
  path: Path,
  offset: number,
): ReadonlyArray<CorpusLocation> => {
  const modules = corpus.modules
  const name = Option.orElse(titleAt(modules, path, offset), () =>
    Option.map(anchorAt(modules, path, offset), (anchor) => anchor.name.value),
  )
  return Option.match(name, {
    onNone: () => [],
    onSome: (n) => [
      ...headingTitlesNamed(modules, n),
      ...anchorNamesNamed(modules, n),
    ],
  })
}

export const renameRangeAt = (
  corpus: LoomCorpusAst,
  path: Path,
  offset: number,
): Option.Option<CorpusLocation> => {
  const modules = corpus.modules
  const titleSpan = pipe(
    titledSectionAt(modules, path, offset),
    Option.flatMapNullable((section) => section.heading.title),
    Option.map((title): CorpusLocation => ({ path, position: title.position })),
  )
  return Option.orElse(titleSpan, () =>
    Option.map(
      anchorAt(modules, path, offset),
      (anchor): CorpusLocation => ({ path, position: anchor.name.position }),
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
