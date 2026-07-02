import { Array, Match, Option, pipe, Schema } from 'effect'
import { type Diagnostic, type Position } from '#ast/LoomNode'
import {
  type HeadingTitleToken,
  type TocTitleToken,
  type WarpAnchorToken,
  type WarpToken,
} from '#ast/LoomTokens'
import { type TocWeft } from '#ast/Weft'
import { ProductSchema } from '#ast/ProductAst'
import {
  LoomDocumentSchema,
  type LoomDocument,
  type LoomSection,
} from '#ast/LoomAst'
import { profileOf, symbolAt } from '#ast/LoomSymbol'

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

const anchorEdges = (
  modules: Modules,
): ReadonlyArray<{ readonly owner: Path; readonly target: Path }> => {
  const indexes = titleIndexes(modules)
  return pipe(
    Array.fromIterable(modules.values()),
    Array.flatMap((m) =>
      Array.filterMap(Array.flatMap(m.doc.sections, anchorsOf), (anchor) =>
        Option.map(resolveAnchor(indexes, m.path, anchor), (target) => ({
          owner: m.path,
          target: target.module,
        })),
      ),
    ),
  )
}

export const reachable = (
  modules: Modules,
  entry: Path,
): ReadonlyArray<Path> => {
  const edges = anchorEdges(modules)
  return Array.fromIterable(
    reach([entry], (module) =>
      Array.filterMap(edges, (edge) =>
        edge.owner === module ? Option.some(edge.target) : Option.none(),
      ),
    ),
  )
}

export const transitiveDependents = (
  modules: Modules,
  entry: Path,
): ReadonlyArray<Path> => {
  const edges = anchorEdges(modules)
  return pipe(
    Array.fromIterable(
      reach([entry], (module) =>
        Array.filterMap(edges, (edge) =>
          edge.target === module ? Option.some(edge.owner) : Option.none(),
        ),
      ),
    ),
    Array.filter((path) => path !== entry),
  )
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

const sectionDefinitionAt = (
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

const sectionReferencesAt = (
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

const covers = (position: Position, offset: number): boolean =>
  position.start.offset <= offset && offset <= position.end.offset

const valueWarpsIn = (
  preamble: ReadonlyArray<{ readonly warps: ReadonlyArray<WarpToken> }>,
): ReadonlyArray<WarpToken> =>
  Array.filter(
    Array.flatMap(preamble, (weft) => weft.warps),
    (warp) => warp.name.value !== 'lang',
  )

const allValueWarpsOf = (doc: LoomDocument): ReadonlyArray<WarpToken> => [
  ...valueWarpsIn(doc.preamble),
  ...Array.flatMap(doc.sections, (section) => valueWarpsIn(section.preamble)),
]

const allAnchorsOf = (doc: LoomDocument): ReadonlyArray<WarpAnchorToken> => [
  ...Array.flatMap(doc.preamble, (weft) => weft.anchors),
  ...Array.flatMap(doc.sections, anchorsOf),
]

const sectionCovering = (
  module: LoomModule,
  offset: number,
): Option.Option<LoomSection> =>
  Array.findFirst(module.doc.sections, (section) =>
    covers(section.position, offset),
  )

const warpDefFor = (
  module: LoomModule,
  section: Option.Option<LoomSection>,
  name: string,
): Option.Option<WarpToken> =>
  pipe(
    section,
    Option.flatMap((s) =>
      Array.findFirst(valueWarpsIn(s.preamble), (w) => w.name.value === name),
    ),
    Option.orElse(() =>
      Array.findFirst(
        valueWarpsIn(module.doc.preamble),
        (w) => w.name.value === name,
      ),
    ),
  )

const warpNameAt = (module: LoomModule, offset: number): Option.Option<string> =>
  Option.orElse(
    Option.map(
      Array.findFirst(allValueWarpsOf(module.doc), (w) =>
        covers(w.name.position, offset),
      ),
      (w) => w.name.value,
    ),
    () =>
      Option.map(
        Array.findFirst(allAnchorsOf(module.doc), (a) =>
          covers(a.name.position, offset),
        ),
        (a) => a.name.value,
      ),
  )

const warpBindingAt = (
  module: LoomModule,
  offset: number,
): Option.Option<{
  readonly def: WarpToken
  readonly anchors: ReadonlyArray<WarpAnchorToken>
}> =>
  pipe(
    warpNameAt(module, offset),
    Option.flatMap((name) =>
      Option.map(
        warpDefFor(module, sectionCovering(module, offset), name),
        (def) => ({
          def,
          anchors: Array.filter(
            allAnchorsOf(module.doc),
            (anchor) =>
              anchor.name.value === name &&
              Option.getOrUndefined(
                warpDefFor(
                  module,
                  sectionCovering(module, anchor.position.start.offset),
                  name,
                ),
              ) === def,
          ),
        }),
      ),
    ),
  )

const warpDefLocation = (
  module: LoomModule,
  path: Path,
  offset: number,
): Option.Option<CorpusLocation> =>
  Option.map(
    warpBindingAt(module, offset),
    (binding): CorpusLocation => ({ path, position: binding.def.name.position }),
  )

const warpReferences = (
  module: LoomModule,
  path: Path,
  offset: number,
  spanOf: (anchor: WarpAnchorToken) => Position,
): ReadonlyArray<CorpusLocation> =>
  Option.match(warpBindingAt(module, offset), {
    onNone: () => [],
    onSome: (binding) => [
      { path, position: binding.def.name.position },
      ...Array.map(
        binding.anchors,
        (anchor): CorpusLocation => ({ path, position: spanOf(anchor) }),
      ),
    ],
  })

const firstHeadingTitleOf = (
  module: LoomModule,
): Option.Option<HeadingTitleToken> =>
  Option.flatMap(
    Array.findFirst(
      module.doc.sections,
      (section) => section.heading.title !== undefined,
    ),
    (section) => Option.fromNullable(section.heading.title),
  )

const chapterTitleToken = (
  module: LoomModule,
): Option.Option<{ readonly source: string; readonly position: Position }> =>
  Option.orElse(firstHeadingTitleOf(module), () =>
    Option.fromNullable(module.doc.frontmatter?.title),
  )

const chapterIndex = (modules: Modules): ReadonlyMap<string, CorpusLocation> =>
  pipe(
    Array.fromIterable(modules.values()),
    Array.filterMap((module) =>
      Option.map(
        chapterTitleToken(module),
        (title) =>
          [
            title.source,
            { path: module.path, position: title.position },
          ] as const,
      ),
    ),
    Array.reduce(
      new Map<string, CorpusLocation>(),
      (index, [title, location]) =>
        index.has(title) ? index : new Map(index).set(title, location),
    ),
  )

const tocEntriesOf = (module: LoomModule): ReadonlyArray<TocWeft> =>
  Array.flatMap(module.doc.sections, (section) => section.entries ?? [])

const tocEntryTitleAt = (
  modules: Modules,
  path: Path,
  offset: number,
): Option.Option<string> =>
  pipe(
    Option.fromNullable(modules.get(path)),
    Option.flatMap((module) =>
      Array.findFirst(
        tocEntriesOf(module),
        (entry) =>
          entry.title !== undefined && covers(entry.title.position, offset),
      ),
    ),
    Option.flatMap((entry) => Option.fromNullable(entry.title)),
    Option.map((title) => title.value),
  )

const tocEntryDefinitionAt = (
  corpus: LoomCorpusAst,
  path: Path,
  offset: number,
): Option.Option<CorpusLocation> =>
  Option.flatMap(tocEntryTitleAt(corpus.modules, path, offset), (title) =>
    Option.fromNullable(chapterIndex(corpus.modules).get(title)),
  )

const isChapterTitled = (module: LoomModule, title: string): boolean =>
  Option.getOrElse(
    Option.map(chapterTitleToken(module), (token) => token.source === title),
    () => false,
  )

const titleDeclarationsOf = (
  module: LoomModule,
): ReadonlyArray<CorpusLocation> => [
  ...Option.toArray(
    Option.map(firstHeadingTitleOf(module), (token) => ({
      path: module.path,
      position: token.position,
    })),
  ),
  ...Option.toArray(
    Option.map(Option.fromNullable(module.doc.frontmatter?.title), (token) => ({
      path: module.path,
      position: token.position,
    })),
  ),
]

const tocMentionsOf = (
  module: LoomModule,
  title: string,
): ReadonlyArray<CorpusLocation> =>
  Array.filterMap(tocEntriesOf(module), (entry) =>
    pipe(
      Option.fromNullable(entry.title),
      Option.filter((token) => token.value === title),
      Option.map((token) => ({ path: module.path, position: token.position })),
    ),
  )

const tocNameGroup = (
  modules: Modules,
  title: string,
): ReadonlyArray<CorpusLocation> =>
  Array.flatMap(Array.fromIterable(modules.values()), (module) => [
    ...(isChapterTitled(module, title) ? titleDeclarationsOf(module) : []),
    ...tocMentionsOf(module, title),
  ])

const tocNameGroupAt = (
  corpus: LoomCorpusAst,
  path: Path,
  offset: number,
): ReadonlyArray<CorpusLocation> =>
  Option.match(tocEntryTitleAt(corpus.modules, path, offset), {
    onNone: (): ReadonlyArray<CorpusLocation> => [],
    onSome: (title) => tocNameGroup(corpus.modules, title),
  })

export const unresolvedTocEntriesIn = (
  corpus: LoomCorpusAst,
  module: LoomModule,
): ReadonlyArray<TocTitleToken> => {
  const index = chapterIndex(corpus.modules)
  return Array.filterMap(tocEntriesOf(module), (entry) =>
    pipe(
      Option.fromNullable(entry.title),
      Option.filter((title) => !index.has(title.value)),
    ),
  )
}

export const definitionAt = (
  corpus: LoomCorpusAst,
  path: Path,
  offset: number,
): Option.Option<CorpusLocation> =>
  pipe(
    Option.fromNullable(corpus.modules.get(path)),
    Option.flatMap((module) =>
      Option.flatMap(symbolAt(module.doc, offset), (symbol) =>
        Match.value(symbol.kind).pipe(
          Match.when('warpAnchor', () => warpDefLocation(module, path, offset)),
          Match.when('sectionAnchor', () =>
            sectionDefinitionAt(corpus, path, offset),
          ),
          Match.when('tocEntry', () =>
            tocEntryDefinitionAt(corpus, path, offset),
          ),
          Match.orElse(() => Option.none<CorpusLocation>()),
        ),
      ),
    ),
  )

export const referencesAt = (
  corpus: LoomCorpusAst,
  path: Path,
  offset: number,
): ReadonlyArray<CorpusLocation> =>
  Option.match(
    pipe(
      Option.fromNullable(corpus.modules.get(path)),
      Option.flatMap((module) =>
        Option.map(symbolAt(module.doc, offset), (symbol) => ({ module, symbol })),
      ),
    ),
    {
      onNone: () => [],
      onSome: ({ module, symbol }) =>
        Match.value(symbol.kind).pipe(
          Match.whenOr('warpAnchor', 'warpDef', () =>
            warpReferences(module, path, offset, (anchor) => anchor.position),
          ),
          Match.whenOr('headingTitle', 'sectionAnchor', () =>
            sectionReferencesAt(corpus, path, offset),
          ),
          Match.when('tocEntry', () => tocNameGroupAt(corpus, path, offset)),
          Match.orElse((): ReadonlyArray<CorpusLocation> => []),
        ),
    },
  )

const sectionRenameAt = (
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

export const renameAt = (
  corpus: LoomCorpusAst,
  path: Path,
  offset: number,
): ReadonlyArray<CorpusLocation> =>
  Option.match(
    pipe(
      Option.fromNullable(corpus.modules.get(path)),
      Option.flatMap((module) =>
        Option.map(symbolAt(module.doc, offset), (symbol) => ({ module, symbol })),
      ),
    ),
    {
      onNone: () => [],
      onSome: ({ module, symbol }) =>
        Match.value(symbol.kind).pipe(
          Match.whenOr('warpAnchor', 'warpDef', () =>
            warpReferences(
              module,
              path,
              offset,
              (anchor) => anchor.name.position,
            ),
          ),
          Match.whenOr('headingTitle', 'sectionAnchor', () =>
            sectionRenameAt(corpus, path, offset),
          ),
          Match.when('tocEntry', () => tocNameGroupAt(corpus, path, offset)),
          Match.orElse((): ReadonlyArray<CorpusLocation> => []),
        ),
    },
  )

export const renameRangeAt = (
  corpus: LoomCorpusAst,
  path: Path,
  offset: number,
): Option.Option<CorpusLocation> =>
  pipe(
    Option.fromNullable(corpus.modules.get(path)),
    Option.flatMap((module) => symbolAt(module.doc, offset)),
    Option.filter((symbol) => profileOf(symbol.kind).features.navigation === true),
    Option.map((symbol): CorpusLocation => ({ path, position: symbol.position })),
  )

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
