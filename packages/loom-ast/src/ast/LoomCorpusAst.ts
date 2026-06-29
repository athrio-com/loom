import { Array, Option, pipe, Schema } from 'effect'
import { type Diagnostic, type Position } from '#ast/LoomNode'
import {
  type SinkToken,
  type SpecifierToken,
  type WarpAnchorToken,
} from '#ast/LoomTokens'
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
  section.heading.sink !== undefined && section.heading.sink.file === undefined
    ? Option.some(section.heading.sink.dir.value)
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
  if (sink.file === undefined) return sink.dir.value
  const dir = sink.dir.value
  return dir === '.' || dir === ''
    ? sink.file.value
    : `${dir.replace(/\/$/, '')}/${sink.file.value}`
}

const joinDir = (parent: string, child: string): string =>
  parent === '' ? child : `${parent.replace(/\/$/, '')}/${child}`

const headingLevel = (section: LoomSection): number =>
  section.heading.headingStart.source.match(/^#+/)?.[0].length ?? 0

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

const pointings = (
  modules: Modules,
  index: ReadonlyMap<string, SectionRef>,
): ReadonlyArray<Pointing> =>
  pipe(
    dirSinks(modules),
    Array.flatMap((sink) =>
      Array.filterMap(anchorsOf(sink.section), (anchor) =>
        Option.map(
          Option.fromNullable(index.get(anchor.name.value)),
          (target) => ({ sink, anchor, target }),
        ),
      ),
    ),
  )

const sinkPrefixes = (
  modules: Modules,
  index: ReadonlyMap<string, SectionRef>,
): ReadonlyMap<LoomSection, string> => {
  const parentOf = pipe(
    pointings(modules, index),
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
  const index = sectionTitles(modules)
  const prefixes = sinkPrefixes(modules, index)
  const starts = Array.filter(
    pointings(modules, index),
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
  const index = sectionTitles(modules)
  const childSinks = (section: LoomSection): ReadonlyArray<SectionRef> =>
    Array.filterMap(anchorsOf(section), (anchor) =>
      pipe(
        Option.fromNullable(index.get(anchor.name.value)),
        Option.filter((ref) => isDirSink(ref.section)),
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
  const index = sectionTitles(modules)
  return pipe(
    dirSinks(modules),
    Array.flatMap((sink) =>
      Array.filterMap(anchorsOf(sink.section), (anchor) =>
        index.has(anchor.name.value)
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
