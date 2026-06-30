import { Array, Option, pipe, Schema } from 'effect'
import { type Diagnostic, type Position } from '#ast/LoomNode'
import {
  type SinkToken,
  type SpecifierToken,
  type WarpAnchorToken,
} from '#ast/LoomTokens'
import { ProductSchema } from '#ast/ProductAst'
import { LoomDocumentSchema, type LoomSection } from '#ast/LoomAst'

export type Path = string

export const LoomModuleSchema = Schema.Struct({
  path: Schema.String,
  text: Schema.String,
  doc: LoomDocumentSchema,
  product: ProductSchema,
})
export type LoomModule = typeof LoomModuleSchema.Type

export const LoomCorpusAstSchema = Schema.Struct({
  modules: Schema.ReadonlyMap({ key: Schema.String, value: LoomModuleSchema }),
})
export type LoomCorpusAst = typeof LoomCorpusAstSchema.Type

type Modules = ReadonlyMap<Path, LoomModule>

type SectionRef = { readonly module: Path; readonly section: LoomSection }

const rootAnchored = (dir: string): string => dir.replace(/^\/+/, '')

const dirLabelOf = (section: LoomSection): Option.Option<string> =>
  section.heading.sink !== undefined && section.heading.sink.file === undefined
    ? Option.some(rootAnchored(section.heading.sink.dir.value))
    : Option.none()

const isDirSink = (section: LoomSection): boolean =>
  Option.isSome(dirLabelOf(section))

const tangleSinkOf = (section: LoomSection): Option.Option<SinkToken> => {
  const sink = section.heading.sink
  return sink !== undefined && sink.file !== undefined
    ? Option.some(sink)
    : Option.none()
}

export const sinkPathOf = (sink: SinkToken): string => {
  if (sink.file === undefined) return rootAnchored(sink.dir.value)
  const dir = rootAnchored(sink.dir.value)
  return dir === '.' || dir === ''
    ? sink.file.value
    : `${dir.replace(/\/$/, '')}/${sink.file.value}`
}

const joinDir = (parent: string, child: string): string =>
  parent === '' ? child : `${parent.replace(/\/$/, '')}/${child}`

const headingLevel = (section: LoomSection): number =>
  section.heading.headingStart.source.match(/^#+/)?.[0].length ?? 0

const resolveRelative = (from: Path, rel: string): Path =>
  pipe(
    rel.split('/'),
    Array.filter((seg) => seg !== '' && seg !== '.'),
    Array.reduce(from.split('/').slice(0, -1), (acc, seg) =>
      seg === '..' ? acc.slice(0, -1) : [...acc, seg],
    ),
    Array.join('/'),
  )

const titlesIn = (module: LoomModule): ReadonlyMap<string, SectionRef> =>
  pipe(
    module.doc.sections,
    Array.filterMap((section) =>
      Option.map(
        Option.fromNullable(section.heading.title),
        (title) => [title.source, { module: module.path, section }] as const,
      ),
    ),
    Array.reduce(
      new Map<string, SectionRef>(),
      (index, [title, ref]) =>
        index.has(title) ? index : new Map(index).set(title, ref),
    ),
  )

type TitleIndexes = ReadonlyMap<Path, ReadonlyMap<string, SectionRef>>

const titleIndexes = (modules: Modules): TitleIndexes =>
  new Map(
    Array.fromIterable(modules.values()).map(
      (m) => [m.path, titlesIn(m)] as const,
    ),
  )

const resolveAnchor = (
  indexes: TitleIndexes,
  from: Path,
  anchor: WarpAnchorToken,
): Option.Option<SectionRef> =>
  pipe(
    Option.fromNullable(
      indexes.get(
        anchor.target === undefined
          ? from
          : resolveRelative(from, anchor.target.value),
      ),
    ),
    Option.flatMap((index) =>
      Option.fromNullable(index.get(anchor.name.value)),
    ),
  )

const anchorsOf = (section: LoomSection): ReadonlyArray<WarpAnchorToken> =>
  pipe(
    [...section.preamble, ...section.code],
    Array.flatMap((weft) => weft.anchors),
  )

const dirSinks = (modules: Modules): ReadonlyArray<SectionRef> =>
  pipe(
    Array.fromIterable(modules.values()),
    Array.flatMap((m) =>
      Array.filterMap(m.doc.sections, (section) =>
        isDirSink(section)
          ? Option.some<SectionRef>({ module: m.path, section })
          : Option.none<SectionRef>(),
      ),
    ),
  )

type Pointing = {
  readonly sink: SectionRef
  readonly anchor: WarpAnchorToken
  readonly target: SectionRef
}

const pointings = (modules: Modules): ReadonlyArray<Pointing> => {
  const indexes = titleIndexes(modules)
  return pipe(
    dirSinks(modules),
    Array.flatMap((sink) =>
      Array.filterMap(anchorsOf(sink.section), (anchor) =>
        Option.map(
          resolveAnchor(indexes, sink.module, anchor),
          (target) => ({ sink, anchor, target }),
        ),
      ),
    ),
  )
}

const sinkPrefixes = (modules: Modules): ReadonlyMap<LoomSection, string> => {
  const parentOf = pipe(
    pointings(modules),
    Array.filter((p) => isDirSink(p.target.section)),
    Array.reduce(
      new Map<LoomSection, SectionRef>(),
      (acc, p) => new Map(acc).set(p.target.section, p.sink),
    ),
  )
  const prefixOf = (sink: SectionRef, seen: ReadonlySet<LoomSection>): string => {
    const own = Option.getOrElse(dirLabelOf(sink.section), () => '')
    const parent = parentOf.get(sink.section)
    return parent === undefined || seen.has(sink.section)
      ? own
      : joinDir(prefixOf(parent, new Set([...seen, sink.section])), own)
  }
  return new Map(
    dirSinks(modules).map(
      (sink) => [sink.section, prefixOf(sink, new Set())] as const,
    ),
  )
}

type Chapter = {
  readonly owner: SectionRef
  readonly anchor: WarpAnchorToken
  readonly start: SectionRef
  readonly prefix: string
  readonly sections: ReadonlyArray<LoomSection>
}

const docIndex = (modules: Modules, ref: SectionRef): number =>
  modules.get(ref.module)?.doc.sections.indexOf(ref.section) ?? -1

const bookChapters = (corpus: LoomCorpusAst): ReadonlyArray<Chapter> => {
  const modules = corpus.modules
  const prefixes = sinkPrefixes(modules)
  const starts = Array.filter(
    pointings(modules),
    (p) => !isDirSink(p.target.section),
  )
  const boundariesIn = (module: Path): ReadonlyArray<number> =>
    pipe(
      starts,
      Array.filter((p) => p.target.module === module),
      Array.map((p) => docIndex(modules, p.target)),
    )
  return Array.map(starts, (p): Chapter => {
    const sections = modules.get(p.target.module)?.doc.sections ?? []
    const startAt = docIndex(modules, p.target)
    const next = pipe(
      boundariesIn(p.target.module),
      Array.filter((i) => i > startAt),
      Array.reduce(sections.length, (lo, i) => Math.min(lo, i)),
    )
    return {
      owner: p.sink,
      anchor: p.anchor,
      start: p.target,
      prefix: Option.getOrElse(
        Option.fromNullable(prefixes.get(p.sink.section)),
        () => '',
      ),
      sections: sections.slice(startAt, next),
    }
  })
}

export const sinkTreeRouting = (
  corpus: LoomCorpusAst,
): ReadonlyMap<Path, ReadonlyMap<string, string>> => {
  const placements = pipe(
    bookChapters(corpus),
    Array.flatMap((chapter) =>
      Array.filterMap(chapter.sections, (section) =>
        Option.map(tangleSinkOf(section), (sink) => ({
          module: chapter.start.module,
          path: sinkPathOf(sink),
          prefix: chapter.prefix,
        })),
      ),
    ),
  )
  return new Map(
    Object.entries(Array.groupBy(placements, (place) => place.module)).map(
      ([module, places]) =>
        [
          module,
          new Map(places.map((place) => [place.path, place.prefix])),
        ] as const,
    ),
  )
}

const reach = (
  seeds: ReadonlyArray<Path>,
  step: (module: Path) => ReadonlyArray<Path>,
): ReadonlySet<Path> => {
  const grow = (
    acc: ReadonlySet<Path>,
    frontier: ReadonlyArray<Path>,
  ): ReadonlySet<Path> => {
    const next = pipe(
      frontier,
      Array.flatMap(step),
      Array.filter((p) => !acc.has(p)),
      Array.dedupe,
    )
    return next.length === 0 ? acc : grow(new Set([...acc, ...next]), next)
  }
  return grow(new Set(seeds), seeds)
}

const chapterEdges = (
  modules: Modules,
): ReadonlyArray<{ readonly owner: Path; readonly chapter: Path }> =>
  Array.map(bookChapters({ modules }), (chapter) => ({
    owner: chapter.owner.module,
    chapter: chapter.start.module,
  }))

export const placeReachable = (
  modules: Modules,
  entry: Path,
): ReadonlyArray<Path> => {
  const edges = chapterEdges(modules)
  return Array.fromIterable(
    reach([entry], (module) =>
      Array.filterMap(edges, (edge) =>
        edge.owner === module ? Option.some(edge.chapter) : Option.none(),
      ),
    ),
  )
}

export const transitiveDependents = (
  modules: Modules,
  entry: Path,
): ReadonlyArray<Path> => {
  const edges = chapterEdges(modules)
  return pipe(
    Array.fromIterable(
      reach([entry], (module) =>
        Array.filterMap(edges, (edge) =>
          edge.chapter === module ? Option.some(edge.owner) : Option.none(),
        ),
      ),
    ),
    Array.filter((path) => path !== entry),
  )
}

export const placedModules = (corpus: LoomCorpusAst): ReadonlySet<Path> =>
  new Set(Array.map(bookChapters(corpus), (chapter) => chapter.start.module))

export type TangleSink = {
  readonly module: Path
  readonly position: Position
  readonly path: string
}

export const tangleSinks = (corpus: LoomCorpusAst): ReadonlyArray<TangleSink> =>
  pipe(
    Array.fromIterable(corpus.modules.values()),
    Array.flatMap((m) =>
      Array.filterMap(m.doc.sections, (section) =>
        Option.map(
          tangleSinkOf(section),
          (sink): TangleSink => ({
            module: m.path,
            position: sink.position,
            path: sinkPathOf(sink),
          }),
        ),
      ),
    ),
  )

export type SinkFault =
  | { readonly kind: 'CollidingTitles'; readonly path: Path; readonly position: Position; readonly name: string }
  | { readonly kind: 'SinkCycle'; readonly path: Path; readonly position: Position; readonly name: string }
  | { readonly kind: 'EmptySink'; readonly path: Path; readonly position: Position; readonly directory: string }
  | { readonly kind: 'MisplacedSpecifier'; readonly path: Path; readonly position: Position; readonly specifier: string }
  | { readonly kind: 'SelfRoutingSink'; readonly path: Path; readonly position: Position; readonly name: string }
  | { readonly kind: 'SinklessChapter'; readonly path: Path; readonly position: Position; readonly name: string }
  | { readonly kind: 'PointedNotH1'; readonly path: Path; readonly position: Position; readonly name: string }
  | { readonly kind: 'OrphanedOpening'; readonly path: Path; readonly position: Position; readonly name: string }
  | { readonly kind: 'DuplicateChapter'; readonly path: Path; readonly position: Position; readonly name: string }
  | { readonly kind: 'UnresolvedPointing'; readonly path: Path; readonly position: Position; readonly name: string }

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
  section.heading.sink?.position ??
  section.heading.position

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
    Array.groupBy((s) => `${s.loc.path}\n${s.name}`),
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

const anchorSpecifierText = (spec: SpecifierToken | SinkToken): string =>
  spec.type === 'Specifier'
    ? spec.label.value
    : spec.file === undefined
      ? spec.dir.value
      : `${spec.dir.value}, ${spec.file.value}`

const misplacedSpecifiers = (
  sections: ReadonlyArray<Located>,
): ReadonlyArray<SinkFault> =>
  pipe(
    sections,
    Array.flatMap((loc) =>
      Array.filterMap(anchorsOf(loc.section), (anchor) =>
        Option.map(
          Option.fromNullable(anchor.specifier),
          (specifier): SinkFault => ({
            kind: 'MisplacedSpecifier',
            path: loc.path,
            position: specifier.position,
            specifier: anchorSpecifierText(specifier),
          }),
        ),
      ),
    ),
  )

const emptySinks = (modules: Modules): ReadonlyArray<SinkFault> =>
  Array.filterMap(dirSinks(modules), (ref) =>
    anchorsOf(ref.section).length === 0
      ? Option.some<SinkFault>({
          kind: 'EmptySink',
          path: ref.module,
          position: headingPosition(ref.section),
          directory: Option.getOrElse(dirLabelOf(ref.section), () => ''),
        })
      : Option.none(),
  )

const sinkCycles = (modules: Modules): ReadonlyArray<SinkFault> => {
  const indexes = titleIndexes(modules)
  const childSinks = (ref: SectionRef): ReadonlyArray<SectionRef> =>
    Array.filterMap(anchorsOf(ref.section), (anchor) =>
      pipe(
        resolveAnchor(indexes, ref.module, anchor),
        Option.filter((child) => isDirSink(child.section)),
      ),
    )
  const reaches = (
    from: SectionRef,
    target: LoomSection,
    seen: ReadonlySet<LoomSection>,
  ): boolean =>
    Array.some(
      childSinks(from),
      (child) =>
        child.section === target ||
        (!seen.has(child.section) &&
          reaches(child, target, new Set([...seen, child.section]))),
    )
  return Array.filterMap(dirSinks(modules), (ref) =>
    reaches(ref, ref.section, new Set([ref.section]))
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

const isTangleSink = (section: LoomSection): boolean =>
  Option.isSome(tangleSinkOf(section))

const chapterFaults = (corpus: LoomCorpusAst): ReadonlyArray<SinkFault> => {
  const modules = corpus.modules
  const chapters = bookChapters(corpus)
  const named = (
    kind:
      | 'PointedNotH1'
      | 'SelfRoutingSink'
      | 'SinklessChapter'
      | 'OrphanedOpening'
      | 'DuplicateChapter',
    chapter: Chapter,
  ): SinkFault => ({
    kind,
    path: chapter.owner.module,
    position: chapter.anchor.position,
    name: chapter.anchor.name.value,
  })
  const notH1 = Array.filterMap(chapters, (chapter) =>
    headingLevel(chapter.start.section) === 1
      ? Option.none()
      : Option.some(named('PointedNotH1', chapter)),
  )
  const selfRouting = Array.filterMap(chapters, (chapter) =>
    chapter.start.module === chapter.owner.module
      ? Option.some(named('SelfRoutingSink', chapter))
      : Option.none(),
  )
  const sinkless = Array.filterMap(chapters, (chapter) =>
    Array.some(chapter.sections, isTangleSink)
      ? Option.none()
      : Option.some(named('SinklessChapter', chapter)),
  )
  const duplicate = pipe(
    Array.groupBy(
      chapters,
      (chapter) => `${chapter.start.module}\n${docIndex(modules, chapter.start)}`,
    ),
    (groups) => Object.values(groups),
    Array.filter((group) => group.length > 1),
    Array.flatMap((group) =>
      Array.map(group, (chapter) => named('DuplicateChapter', chapter)),
    ),
  )
  const orphaned = pipe(
    Array.groupBy(chapters, (chapter) => chapter.start.module),
    (groups) => Object.values(groups),
    Array.filterMap((group) => {
      const earliest = group.reduce((a, b) =>
        docIndex(modules, a.start) <= docIndex(modules, b.start) ? a : b,
      )
      return docIndex(modules, earliest.start) > 0
        ? Option.some(named('OrphanedOpening', earliest))
        : Option.none()
    }),
  )
  return [...notH1, ...selfRouting, ...sinkless, ...duplicate, ...orphaned]
}

const unresolvedPointings = (modules: Modules): ReadonlyArray<SinkFault> => {
  const indexes = titleIndexes(modules)
  return pipe(
    dirSinks(modules),
    Array.flatMap((sink) =>
      Array.filterMap(anchorsOf(sink.section), (anchor) =>
        Option.isSome(resolveAnchor(indexes, sink.module, anchor))
          ? Option.none<SinkFault>()
          : Option.some<SinkFault>({
              kind: 'UnresolvedPointing',
              path: sink.module,
              position: anchor.position,
              name: anchor.name.value,
            }),
      ),
    ),
  )
}

export const sinkTreeFaults = (
  corpus: LoomCorpusAst,
  normalise: (title: string) => string,
): ReadonlyArray<SinkFault> => {
  const sections = located(corpus.modules)
  return [
    ...collidingTitles(sections, normalise),
    ...misplacedSpecifiers(sections),
    ...emptySinks(corpus.modules),
    ...sinkCycles(corpus.modules),
    ...unresolvedPointings(corpus.modules),
    ...chapterFaults(corpus),
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

const sectionRefAt = (
  modules: Modules,
  path: Path,
  offset: number,
): Option.Option<SectionRef> =>
  Option.map(titledSectionAt(modules, path, offset), (section) => ({
    module: path,
    section,
  }))

const titleLocation = (ref: SectionRef): Option.Option<CorpusLocation> =>
  Option.map(
    Option.fromNullable(ref.section.heading.title),
    (title): CorpusLocation => ({ path: ref.module, position: title.position }),
  )

const targetAt = (
  indexes: TitleIndexes,
  modules: Modules,
  path: Path,
  offset: number,
): Option.Option<SectionRef> =>
  Option.orElse(sectionRefAt(modules, path, offset), () =>
    Option.flatMap(anchorAt(modules, path, offset), (anchor) =>
      resolveAnchor(indexes, path, anchor),
    ),
  )

const anchorsResolvingTo = (
  indexes: TitleIndexes,
  modules: Modules,
  target: SectionRef,
  spanOf: (anchor: WarpAnchorToken) => Position,
): ReadonlyArray<CorpusLocation> =>
  pipe(
    Array.fromIterable(modules.values()),
    Array.flatMap((m) =>
      Array.filterMap(Array.flatMap(m.doc.sections, anchorsOf), (anchor) =>
        pipe(
          resolveAnchor(indexes, m.path, anchor),
          Option.filter(
            (ref) =>
              ref.module === target.module && ref.section === target.section,
          ),
          Option.map(
            (): CorpusLocation => ({ path: m.path, position: spanOf(anchor) }),
          ),
        ),
      ),
    ),
  )

export const definitionAt = (
  corpus: LoomCorpusAst,
  path: Path,
  offset: number,
): Option.Option<CorpusLocation> => {
  const indexes = titleIndexes(corpus.modules)
  return pipe(
    anchorAt(corpus.modules, path, offset),
    Option.flatMap((anchor) => resolveAnchor(indexes, path, anchor)),
    Option.flatMap(titleLocation),
  )
}

export const referencesAt = (
  corpus: LoomCorpusAst,
  path: Path,
  offset: number,
): ReadonlyArray<CorpusLocation> => {
  const modules = corpus.modules
  const indexes = titleIndexes(modules)
  return Option.match(targetAt(indexes, modules, path, offset), {
    onNone: () => [],
    onSome: (ref) => [
      ...Option.toArray(titleLocation(ref)),
      ...anchorsResolvingTo(indexes, modules, ref, (anchor) => anchor.position),
    ],
  })
}

export const renameAt = (
  corpus: LoomCorpusAst,
  path: Path,
  offset: number,
): ReadonlyArray<CorpusLocation> => {
  const modules = corpus.modules
  const indexes = titleIndexes(modules)
  return Option.match(targetAt(indexes, modules, path, offset), {
    onNone: () => [],
    onSome: (ref) => [
      ...Option.toArray(titleLocation(ref)),
      ...anchorsResolvingTo(
        indexes,
        modules,
        ref,
        (anchor) => anchor.name.position,
      ),
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
  ...diagnosticsIn(module.product.code),
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
