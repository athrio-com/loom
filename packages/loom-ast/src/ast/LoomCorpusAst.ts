import { Array, Data, Match, Option, pipe, Schema } from 'effect'
import { type Diagnostic, type Point, type Position } from '#ast/LoomNode'
import {
  type HeadingTitleToken,
  type TocPartToken,
  type TocTitleToken,
  type WarpAnchorToken,
  type WarpToken,
} from '#ast/LoomTokens'
import { type TocWeft } from '#ast/Weft'
import { ProductSchema } from '#ast/ProductAst'
import { LoomDocumentSchema, type LoomDocument, type LoomSection } from '#ast/LoomAst'
import { profileOf, symbolAt } from '#ast/LoomSymbol'

export type Location = string

export const LoomModuleSchema = Schema.Struct({
  path: Schema.String,
  text: Schema.String,
  doc: LoomDocumentSchema,
  product: ProductSchema,
})
export type LoomModule = typeof LoomModuleSchema.Type

export const LoomCorpusAstSchema = Schema.Struct({
  modules: Schema.ReadonlyMap(Schema.String, LoomModuleSchema),
})
export type LoomCorpusAst = typeof LoomCorpusAstSchema.Type

type Modules = ReadonlyMap<Location, LoomModule>

export type SectionRef = { readonly module: Location; readonly section: LoomSection }

const resolveRelative = (from: Location, rel: string): Location =>
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
    Array.map((section) =>
      Option.map(
        Option.fromNullishOr(section.heading.title),
        (title) => [title.source, { module: module.path, section }] as const,
      ),
    ),
    Array.getSomes,
    Array.reduce(new Map<string, SectionRef>(), (index, [title, ref]) =>
      index.has(title) ? index : new Map(index).set(title, ref),
    ),
  )

export type TitleIndexes = ReadonlyMap<Location, ReadonlyMap<string, SectionRef>>

export const titleIndexes = (modules: Modules): TitleIndexes =>
  new Map(Array.fromIterable(modules.values()).map((m) => [m.path, titlesIn(m)] as const))

export const anchorModule = (from: Location, anchor: WarpAnchorToken): Location =>
  anchor.target === undefined ? from : resolveRelative(from, anchor.target.value)

type Chapter = {
  readonly title: string
  readonly part: Option.Option<string>
  readonly module: LoomModule
}

const partNamesIn = (modules: Modules): ReadonlyMap<string, string> =>
  new Map(
    Array.getSomes(
      Array.map(Array.fromIterable(modules.values()), (module) =>
        pipe(
          Option.fromNullishOr(module.doc.frontmatter),
          Option.flatMap((fm) =>
            Option.all([Option.fromNullishOr(fm.part), Option.fromNullishOr(fm.partName)]),
          ),
          Option.map(([part, partName]) => [part.value, partName.value] as const),
        ),
      ),
    ),
  )

const partOf = (names: ReadonlyMap<string, string>, module: LoomModule): Option.Option<string> =>
  pipe(
    Option.fromNullishOr(module.doc.frontmatter),
    Option.flatMap((fm) =>
      Option.orElse(
        Option.map(Option.fromNullishOr(fm.partName), (partName) => partName.value),
        () =>
          Option.flatMap(Option.fromNullishOr(fm.part), (part) =>
            Option.fromNullishOr(names.get(part.value)),
          ),
      ),
    ),
  )

const chaptersIn = (modules: Modules): ReadonlyArray<Chapter> => {
  const names = partNamesIn(modules)
  return Array.getSomes(
    Array.map(Array.fromIterable(modules.values()), (module) =>
      Option.map(chapterTitleToken(module), (title) => ({
        title: title.source,
        part: partOf(names, module),
        module,
      })),
    ),
  )
}

const openingSectionOf = (module: LoomModule): Option.Option<LoomSection> =>
  Array.findFirst(module.doc.sections, (section) => section.heading.title !== undefined)

export type Book = {
  readonly titles: TitleIndexes
  readonly chapters: ReadonlyArray<Chapter>
}

export const bookOf = (modules: Modules): Book => ({
  titles: titleIndexes(modules),
  chapters: chaptersIn(modules),
})

export type Place = Data.TaggedEnum<{
  Part: { readonly name: string }
  Chapter: { readonly chapter: Chapter }
  Section: { readonly ref: SectionRef }
}>

const Place = Data.taggedEnum<Place>()

export type Segment = { readonly text: string; readonly start: number; readonly end: number }

export type Step = { readonly segment: Segment; readonly place: Place }

export type Trail = Array.NonEmptyReadonlyArray<Step>

const chaptersTitled = (
  book: Book,
  title: string,
  part: Option.Option<string>,
): ReadonlyArray<Chapter> =>
  Array.filter(
    book.chapters,
    (chapter) =>
      chapter.title === title &&
      Option.match(part, {
        onNone: () => true,
        onSome: (name) => Option.contains(chapter.part, name),
      }),
  )

const sectionTitled = (book: Book, module: Location, title: string): Option.Option<SectionRef> =>
  Option.fromNullishOr(book.titles.get(module)?.get(title))

const placesNamed = (book: Book, scope: Option.Option<Place>, name: string): ReadonlyArray<Place> =>
  Option.match(scope, {
    onNone: () => [
      ...(Array.some(book.chapters, (chapter) => Option.contains(chapter.part, name))
        ? [Place.Part({ name })]
        : []),
      ...Array.map(chaptersTitled(book, name, Option.none()), (chapter) =>
        Place.Chapter({ chapter }),
      ),
    ],
    onSome: (place) =>
      Match.value(place).pipe(
        Match.tag('Part', (part) =>
          Array.map(chaptersTitled(book, name, Option.some(part.name)), (chapter) =>
            Place.Chapter({ chapter }),
          ),
        ),
        Match.tag('Chapter', ({ chapter }) =>
          Option.toArray(
            Option.map(sectionTitled(book, chapter.module.path, name), (ref) =>
              Place.Section({ ref }),
            ),
          ),
        ),
        Match.tag('Section', (): ReadonlyArray<Place> => []),
        Match.exhaustive,
      ),
  })

const finished = (trail: ReadonlyArray<Step>): ReadonlyArray<Trail> =>
  Array.isReadonlyArrayNonEmpty(trail) && Array.lastNonEmpty(trail).place._tag !== 'Part'
    ? [trail]
    : []

const walk = (
  book: Book,
  trail: ReadonlyArray<Step>,
  segments: ReadonlyArray<Segment>,
): ReadonlyArray<Trail> =>
  Array.matchLeft(segments, {
    onEmpty: () => finished(trail),
    onNonEmpty: (segment, rest) =>
      Array.flatMap(
        placesNamed(
          book,
          Option.map(Array.last(trail), (step) => step.place),
          segment.text,
        ),
        (place) => walk(book, Array.append(trail, { segment, place }), rest),
      ),
  })

const whole = (name: string): Segment => ({ text: name, start: 0, end: name.length })

const segmentsOf = (name: string): ReadonlyArray<Segment> =>
  Array.map(Array.fromIterable(name.matchAll(/[^,]+/g)), (match) => {
    const text = match[0].trim()
    const start = match.index + match[0].length - match[0].trimStart().length
    return { text, start, end: start + text.length }
  })

const sectionTrail = (book: Book, module: Location, name: string): ReadonlyArray<Trail> =>
  Option.toArray(
    Option.map(sectionTitled(book, module, name), (ref): Trail => [
      { segment: whole(name), place: Place.Section({ ref }) },
    ]),
  )

const nothingFound: ReadonlyArray<Trail> = []

const nearest = (lookups: ReadonlyArray<() => ReadonlyArray<Trail>>): ReadonlyArray<Trail> =>
  Array.reduce(lookups, nothingFound, (found, lookup) => (found.length > 0 ? found : lookup()))

export const trailsOf = (book: Book, from: Location, name: string): ReadonlyArray<Trail> =>
  nearest([
    () => sectionTrail(book, from, name),
    () => walk(book, [], [whole(name)]),
    () => walk(book, [], segmentsOf(name)),
  ])

export const anchorTrails = (
  book: Book,
  from: Location,
  anchor: WarpAnchorToken,
): ReadonlyArray<Trail> =>
  anchor.target === undefined
    ? trailsOf(book, from, anchor.name.value)
    : sectionTrail(book, anchorModule(from, anchor), anchor.name.value)

export const sectionOf = (trail: Trail): Option.Option<SectionRef> =>
  Match.value(Array.lastNonEmpty(trail).place).pipe(
    Match.tag('Section', ({ ref }) => Option.some(ref)),
    Match.tag('Chapter', ({ chapter }) =>
      Option.map(openingSectionOf(chapter.module), (section) => ({
        module: chapter.module.path,
        section,
      })),
    ),
    Match.tag('Part', () => Option.none<SectionRef>()),
    Match.exhaustive,
  )

const soleTrail = (trails: ReadonlyArray<Trail>): Option.Option<Trail> =>
  trails.length === 1 ? Array.head(trails) : Option.none()

export const resolveName = (book: Book, from: Location, name: string): Option.Option<SectionRef> =>
  Option.flatMap(soleTrail(trailsOf(book, from, name)), sectionOf)

export const resolveAnchor = (
  book: Book,
  from: Location,
  anchor: WarpAnchorToken,
): Option.Option<SectionRef> =>
  Option.flatMap(soleTrail(anchorTrails(book, from, anchor)), sectionOf)

const anchorsOf = (section: LoomSection): ReadonlyArray<WarpAnchorToken> =>
  pipe(
    [...section.preamble, ...section.code],
    Array.flatMap((weft) => weft.anchors),
  )

const reach = (
  seeds: ReadonlyArray<Location>,
  step: (module: Location) => ReadonlyArray<Location>,
): ReadonlySet<Location> => {
  const grow = (acc: ReadonlySet<Location>, frontier: ReadonlyArray<Location>): ReadonlySet<Location> => {
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

const moduleOf = (trail: Trail): Option.Option<Location> =>
  Match.value(Array.lastNonEmpty(trail).place).pipe(
    Match.tag('Section', ({ ref }) => Option.some(ref.module)),
    Match.tag('Chapter', ({ chapter }) => Option.some(chapter.module.path)),
    Match.tag('Part', () => Option.none<Location>()),
    Match.exhaustive,
  )

const anchorEdges = (
  modules: Modules,
): ReadonlyArray<{ readonly owner: Location; readonly target: Location }> => {
  const book = bookOf(modules)
  return pipe(
    Array.fromIterable(modules.values()),
    Array.flatMap((m) =>
      pipe(
        m.doc.sections,
        Array.flatMap(anchorsOf),
        Array.flatMap((anchor) =>
          Array.getSomes(
            Array.map(anchorTrails(book, m.path, anchor), (trail) =>
              Option.map(moduleOf(trail), (target) => ({ owner: m.path, target })),
            ),
          ),
        ),
      ),
    ),
  )
}

export const reachable = (modules: Modules, entry: Location): ReadonlyArray<Location> => {
  const edges = anchorEdges(modules)
  return Array.fromIterable(
    reach([entry], (module) =>
      Array.getSomes(
        Array.map(edges, (edge) =>
          edge.owner === module ? Option.some(edge.target) : Option.none(),
        ),
      ),
    ),
  )
}

export const dependentsOf = (
  modules: Modules,
  entries: ReadonlyArray<Location>,
): ReadonlyArray<Location> => {
  const edges = anchorEdges(modules)
  const seeds = new Set(entries)
  return pipe(
    Array.fromIterable(
      reach(entries, (module) =>
        Array.getSomes(
          Array.map(edges, (edge) =>
            edge.target === module ? Option.some(edge.owner) : Option.none(),
          ),
        ),
      ),
    ),
    Array.filter((path) => !seeds.has(path)),
  )
}

export const transitiveDependents = (modules: Modules, entry: Location): ReadonlyArray<Location> =>
  dependentsOf(modules, [entry])

export type CorpusLocation = { readonly path: Location; readonly position: Position }

const anchorAt = (modules: Modules, path: Location, offset: number): Option.Option<WarpAnchorToken> =>
  pipe(
    Option.fromNullishOr(modules.get(path)),
    Option.flatMap((m) =>
      Array.findFirst(
        Array.flatMap(m.doc.sections, anchorsOf),
        (anchor) => anchor.position.start.offset <= offset && offset <= anchor.position.end.offset,
      ),
    ),
  )

const titledSectionAt = (
  modules: Modules,
  path: Location,
  offset: number,
): Option.Option<LoomSection> =>
  pipe(
    Option.fromNullishOr(modules.get(path)),
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

const sectionRefAt = (modules: Modules, path: Location, offset: number): Option.Option<SectionRef> =>
  Option.map(titledSectionAt(modules, path, offset), (section) => ({
    module: path,
    section,
  }))

type SpanOf = (anchor: WarpAnchorToken, segment: Segment) => Position

const titleLocation = (ref: SectionRef): Option.Option<CorpusLocation> =>
  Option.map(Option.fromNullishOr(ref.section.heading.title), (title): CorpusLocation => ({
    path: ref.module,
    position: title.position,
  }))

const chapterLocation = (chapter: Chapter): Option.Option<CorpusLocation> =>
  Option.map(chapterTitleToken(chapter.module), (title): CorpusLocation => ({
    path: chapter.module.path,
    position: title.position,
  }))

const shifted = (point: Point, by: number): Point =>
  Option.match(Option.fromNullishOr(point.column), {
    onNone: () => ({ ...point, offset: point.offset + by }),
    onSome: (column) => ({ ...point, offset: point.offset + by, column: column + by }),
  })

const segmentPosition: SpanOf = (anchor, segment) => ({
  start: shifted(anchor.name.position.start, segment.start),
  end: shifted(anchor.name.position.start, segment.end),
})

const wholeAnchor: SpanOf = (anchor) => anchor.position

const stepAt = (trail: Trail, anchor: WarpAnchorToken, offset: number): Step =>
  Option.getOrElse(
    Array.findFirst(trail, (step) => covers(segmentPosition(anchor, step.segment), offset)),
    () => Array.lastNonEmpty(trail),
  )

const anchorPlaceAt = (
  book: Book,
  modules: Modules,
  path: Location,
  offset: number,
): Option.Option<Place> =>
  Option.flatMap(anchorAt(modules, path, offset), (anchor) =>
    Option.map(
      soleTrail(anchorTrails(book, path, anchor)),
      (trail) => stepAt(trail, anchor, offset).place,
    ),
  )

const placeAt = (
  book: Book,
  modules: Modules,
  path: Location,
  offset: number,
): Option.Option<Place> =>
  Option.orElse(
    Option.map(sectionRefAt(modules, path, offset), (ref) => Place.Section({ ref })),
    () => anchorPlaceAt(book, modules, path, offset),
  )

const anchorsNaming = (
  book: Book,
  modules: Modules,
  names: (place: Place) => boolean,
  spanOf: SpanOf,
): ReadonlyArray<CorpusLocation> =>
  Array.flatMap(Array.fromIterable(modules.values()), (m) =>
    pipe(
      m.doc.sections,
      Array.flatMap(anchorsOf),
      Array.flatMap((anchor) =>
        Option.match(soleTrail(anchorTrails(book, m.path, anchor)), {
          onNone: (): ReadonlyArray<CorpusLocation> => [],
          onSome: (trail) =>
            pipe(
              trail,
              Array.filter((step) => names(step.place)),
              Array.map((step): CorpusLocation => ({
                path: m.path,
                position: spanOf(anchor, step.segment),
              })),
            ),
        }),
      ),
    ),
  )

const namesSection =
  (target: SectionRef) =>
  (place: Place): boolean =>
    place._tag === 'Section' &&
    place.ref.module === target.module &&
    place.ref.section === target.section

const namesChapter =
  (title: string) =>
  (place: Place): boolean =>
    place._tag === 'Chapter' && place.chapter.title === title

const sectionDefinitionAt = (
  corpus: LoomCorpusAst,
  path: Location,
  offset: number,
): Option.Option<CorpusLocation> =>
  Option.flatMap(anchorPlaceAt(bookOf(corpus.modules), corpus.modules, path, offset), (place) =>
    Match.value(place).pipe(
      Match.tag('Section', ({ ref }) => titleLocation(ref)),
      Match.tag('Chapter', ({ chapter }) => chapterLocation(chapter)),
      Match.tag('Part', () => Option.none<CorpusLocation>()),
      Match.exhaustive,
    ),
  )

const sectionNames = (
  book: Book,
  modules: Modules,
  ref: SectionRef,
  spanOf: SpanOf,
): ReadonlyArray<CorpusLocation> => [
  ...Option.toArray(titleLocation(ref)),
  ...anchorsNaming(book, modules, namesSection(ref), spanOf),
]

const placeNames = (
  book: Book,
  modules: Modules,
  place: Place,
  spanOf: SpanOf,
): ReadonlyArray<CorpusLocation> =>
  Match.value(place).pipe(
    Match.tag('Section', ({ ref }) => sectionNames(book, modules, ref, spanOf)),
    Match.tag('Chapter', ({ chapter }) => chapterNames(book, modules, chapter.title, spanOf)),
    Match.tag('Part', (): ReadonlyArray<CorpusLocation> => []),
    Match.exhaustive,
  )

const placeNamesAt = (
  corpus: LoomCorpusAst,
  path: Location,
  offset: number,
  spanOf: SpanOf,
): ReadonlyArray<CorpusLocation> => {
  const book = bookOf(corpus.modules)
  return Option.match(placeAt(book, corpus.modules, path, offset), {
    onNone: (): ReadonlyArray<CorpusLocation> => [],
    onSome: (place) => placeNames(book, corpus.modules, place, spanOf),
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

const sectionCovering = (module: LoomModule, offset: number): Option.Option<LoomSection> =>
  Array.findFirst(module.doc.sections, (section) => covers(section.position, offset))

const warpDefFor = (
  module: LoomModule,
  section: Option.Option<LoomSection>,
  name: string,
): Option.Option<WarpToken> =>
  pipe(
    section,
    Option.flatMap((s) => Array.findFirst(valueWarpsIn(s.preamble), (w) => w.name.value === name)),
    Option.orElse(() =>
      Array.findFirst(valueWarpsIn(module.doc.preamble), (w) => w.name.value === name),
    ),
  )

const warpNameAt = (module: LoomModule, offset: number): Option.Option<string> =>
  Option.orElse(
    Option.map(
      Array.findFirst(allValueWarpsOf(module.doc), (w) => covers(w.name.position, offset)),
      (w) => w.name.value,
    ),
    () =>
      Option.map(
        Array.findFirst(allAnchorsOf(module.doc), (a) => covers(a.name.position, offset)),
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
      Option.map(warpDefFor(module, sectionCovering(module, offset), name), (def) => ({
        def,
        anchors: Array.filter(
          allAnchorsOf(module.doc),
          (anchor) =>
            anchor.name.value === name &&
            Option.getOrUndefined(
              warpDefFor(module, sectionCovering(module, anchor.position.start.offset), name),
            ) === def,
        ),
      })),
    ),
  )

const warpDefLocation = (
  module: LoomModule,
  path: Location,
  offset: number,
): Option.Option<CorpusLocation> =>
  Option.map(warpBindingAt(module, offset), (binding): CorpusLocation => ({
    path,
    position: binding.def.name.position,
  }))

const warpReferences = (
  module: LoomModule,
  path: Location,
  offset: number,
  spanOf: (anchor: WarpAnchorToken) => Position,
): ReadonlyArray<CorpusLocation> =>
  Option.match(warpBindingAt(module, offset), {
    onNone: () => [],
    onSome: (binding) => [
      { path, position: binding.def.name.position },
      ...Array.map(binding.anchors, (anchor): CorpusLocation => ({
        path,
        position: spanOf(anchor),
      })),
    ],
  })

const firstHeadingTitleOf = (module: LoomModule): Option.Option<HeadingTitleToken> =>
  Option.flatMap(openingSectionOf(module), (section) => Option.fromNullishOr(section.heading.title))

const chapterTitleToken = (
  module: LoomModule,
): Option.Option<{ readonly source: string; readonly position: Position }> =>
  Option.orElse(Option.fromNullishOr(module.doc.frontmatter?.title), () =>
    firstHeadingTitleOf(module),
  )

const chapterIndex = (modules: Modules): ReadonlyMap<string, CorpusLocation> =>
  pipe(
    Array.fromIterable(modules.values()),
    Array.map((module) =>
      Option.map(
        chapterTitleToken(module),
        (title) => [title.source, { path: module.path, position: title.position }] as const,
      ),
    ),
    Array.getSomes,
    Array.reduce(new Map<string, CorpusLocation>(), (index, [title, location]) =>
      index.has(title) ? index : new Map(index).set(title, location),
    ),
  )

const tocEntriesOf = (module: LoomModule): ReadonlyArray<TocWeft> =>
  Array.flatMap(module.doc.sections, (section) => section.entries ?? [])

const tocEntryTitleAt = (modules: Modules, path: Location, offset: number): Option.Option<string> =>
  pipe(
    Option.fromNullishOr(modules.get(path)),
    Option.flatMap((module) =>
      Array.findFirst(
        tocEntriesOf(module),
        (entry) => entry.title !== undefined && covers(entry.title.position, offset),
      ),
    ),
    Option.flatMap((entry) => Option.fromNullishOr(entry.title)),
    Option.map((title) => title.value),
  )

const frontmatterTitleAt = (modules: Modules, path: Location, offset: number): Option.Option<string> =>
  pipe(
    Option.fromNullishOr(modules.get(path)),
    Option.flatMap((module) => Option.fromNullishOr(module.doc.frontmatter?.title)),
    Option.filter((title) => covers(title.position, offset)),
    Option.map((title) => title.value),
  )

const chapterNameAt = (modules: Modules, path: Location, offset: number): Option.Option<string> =>
  Option.orElse(tocEntryTitleAt(modules, path, offset), () =>
    frontmatterTitleAt(modules, path, offset),
  )

const chapterDefinitionAt = (
  corpus: LoomCorpusAst,
  path: Location,
  offset: number,
): Option.Option<CorpusLocation> =>
  Option.flatMap(chapterNameAt(corpus.modules, path, offset), (title) =>
    Option.fromNullishOr(chapterIndex(corpus.modules).get(title)),
  )

const isChapterTitled = (module: LoomModule, title: string): boolean =>
  Option.getOrElse(
    Option.map(chapterTitleToken(module), (token) => token.source === title),
    () => false,
  )

const titleDeclarationsOf = (module: LoomModule): ReadonlyArray<CorpusLocation> =>
  Option.toArray(
    Option.map(chapterTitleToken(module), (token) => ({
      path: module.path,
      position: token.position,
    })),
  )

const tocMentionsOf = (module: LoomModule, title: string): ReadonlyArray<CorpusLocation> =>
  Array.getSomes(
    Array.map(tocEntriesOf(module), (entry) =>
      pipe(
        Option.fromNullishOr(entry.title),
        Option.filter((token) => token.value === title),
        Option.map((token) => ({ path: module.path, position: token.position })),
      ),
    ),
  )

const tocNameGroup = (modules: Modules, title: string): ReadonlyArray<CorpusLocation> =>
  Array.flatMap(Array.fromIterable(modules.values()), (module) => [
    ...(isChapterTitled(module, title) ? titleDeclarationsOf(module) : []),
    ...tocMentionsOf(module, title),
  ])

const chapterNames = (
  book: Book,
  modules: Modules,
  title: string,
  spanOf: SpanOf,
): ReadonlyArray<CorpusLocation> => [
  ...tocNameGroup(modules, title),
  ...anchorsNaming(book, modules, namesChapter(title), spanOf),
]

const chapterNamesAt = (
  corpus: LoomCorpusAst,
  path: Location,
  offset: number,
  spanOf: SpanOf,
): ReadonlyArray<CorpusLocation> =>
  Option.match(chapterNameAt(corpus.modules, path, offset), {
    onNone: (): ReadonlyArray<CorpusLocation> => [],
    onSome: (title) => chapterNames(bookOf(corpus.modules), corpus.modules, title, spanOf),
  })

export const unresolvedTocEntriesIn = (
  corpus: LoomCorpusAst,
  module: LoomModule,
): ReadonlyArray<TocTitleToken> => {
  const index = chapterIndex(corpus.modules)
  return Array.getSomes(
    Array.map(tocEntriesOf(module), (entry) =>
      pipe(
        Option.fromNullishOr(entry.title),
        Option.filter((title) => !index.has(title.value)),
      ),
    ),
  )
}

const partOpenerIndex = (modules: Modules): ReadonlyMap<string, CorpusLocation> =>
  pipe(
    Array.fromIterable(modules.values()),
    Array.map((module) =>
      pipe(
        Option.fromNullishOr(module.doc.frontmatter),
        Option.flatMap((fm) =>
          Option.all({
            part: Option.fromNullishOr(fm.part),
            partName: Option.fromNullishOr(fm.partName),
          }),
        ),
        Option.map(
          ({ part, partName }) =>
            [part.value, { path: module.path, position: partName.position }] as const,
        ),
      ),
    ),
    Array.getSomes,
    Array.reduce(new Map<string, CorpusLocation>(), (index, [num, location]) =>
      index.has(num) ? index : new Map(index).set(num, location),
    ),
  )

const onToken = (token: { readonly position: Position } | undefined, offset: number): boolean =>
  Option.match(Option.fromNullishOr(token), {
    onNone: () => false,
    onSome: (t) => covers(t.position, offset),
  })

const frontmatterPartNumberAt = (module: LoomModule, offset: number): Option.Option<string> =>
  pipe(
    Option.fromNullishOr(module.doc.frontmatter),
    Option.filter((fm) => onToken(fm.part, offset) || onToken(fm.partName, offset)),
    Option.flatMap((fm) => Option.fromNullishOr(fm.part)),
    Option.map((part) => part.value),
  )

const tocPartsOf = (module: LoomModule): ReadonlyArray<TocPartToken> =>
  Array.getSomes(Array.map(tocEntriesOf(module), (entry) => Option.fromNullishOr(entry.part)))

const partNumberMarker = /^Part\s+(\S+)/

const tocPartNumberAt = (module: LoomModule, offset: number): Option.Option<string> =>
  pipe(
    Array.findFirst(tocPartsOf(module), (part) => covers(part.position, offset)),
    Option.flatMap((part) => Option.fromNullishOr(partNumberMarker.exec(part.value)?.[1])),
  )

const partNumberAt = (modules: Modules, path: Location, offset: number): Option.Option<string> =>
  pipe(
    Option.fromNullishOr(modules.get(path)),
    Option.flatMap((module) =>
      Option.orElse(frontmatterPartNumberAt(module, offset), () => tocPartNumberAt(module, offset)),
    ),
  )

const partDefinitionAt = (
  corpus: LoomCorpusAst,
  path: Location,
  offset: number,
): Option.Option<CorpusLocation> =>
  Option.flatMap(partNumberAt(corpus.modules, path, offset), (num) =>
    Option.fromNullishOr(partOpenerIndex(corpus.modules).get(num)),
  )

const frontmatterPartLocations = (module: LoomModule, num: string): ReadonlyArray<CorpusLocation> =>
  pipe(
    Option.fromNullishOr(module.doc.frontmatter?.part),
    Option.filter((part) => part.value === num),
    Option.map((part) => ({ path: module.path, position: part.position })),
    Option.toArray,
  )

const tocPartLocations = (module: LoomModule, num: string): ReadonlyArray<CorpusLocation> =>
  Array.getSomes(
    Array.map(tocPartsOf(module), (part) =>
      pipe(
        Option.fromNullishOr(partNumberMarker.exec(part.value)?.[1]),
        Option.filter((n) => n === num),
        Option.map(() => ({ path: module.path, position: part.position })),
      ),
    ),
  )

const partGroup = (modules: Modules, num: string): ReadonlyArray<CorpusLocation> => [
  ...Option.toArray(Option.fromNullishOr(partOpenerIndex(modules).get(num))),
  ...Array.flatMap(Array.fromIterable(modules.values()), (module) => [
    ...frontmatterPartLocations(module, num),
    ...tocPartLocations(module, num),
  ]),
]

const partGroupAt = (
  corpus: LoomCorpusAst,
  path: Location,
  offset: number,
): ReadonlyArray<CorpusLocation> =>
  Option.match(partNumberAt(corpus.modules, path, offset), {
    onNone: (): ReadonlyArray<CorpusLocation> => [],
    onSome: (num) => partGroup(corpus.modules, num),
  })

export const definitionAt = (
  corpus: LoomCorpusAst,
  path: Location,
  offset: number,
): Option.Option<CorpusLocation> =>
  pipe(
    Option.fromNullishOr(corpus.modules.get(path)),
    Option.flatMap((module) =>
      Option.flatMap(symbolAt(module.doc, offset), (symbol) =>
        Match.value(symbol.kind).pipe(
          Match.when('warpAnchor', () => warpDefLocation(module, path, offset)),
          Match.when('sectionAnchor', () => sectionDefinitionAt(corpus, path, offset)),
          Match.whenOr('tocEntry', 'frontmatterTitle', () =>
            chapterDefinitionAt(corpus, path, offset),
          ),
          Match.whenOr('tocPart', 'frontmatterPart', 'frontmatterPartName', () =>
            partDefinitionAt(corpus, path, offset),
          ),
          Match.orElse(() => Option.none<CorpusLocation>()),
        ),
      ),
    ),
  )

export const referencesAt = (
  corpus: LoomCorpusAst,
  path: Location,
  offset: number,
): ReadonlyArray<CorpusLocation> =>
  Option.match(
    pipe(
      Option.fromNullishOr(corpus.modules.get(path)),
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
            placeNamesAt(corpus, path, offset, wholeAnchor),
          ),
          Match.whenOr('tocEntry', 'frontmatterTitle', () =>
            chapterNamesAt(corpus, path, offset, wholeAnchor),
          ),
          Match.whenOr('tocPart', 'frontmatterPart', 'frontmatterPartName', () =>
            partGroupAt(corpus, path, offset),
          ),
          Match.orElse((): ReadonlyArray<CorpusLocation> => []),
        ),
    },
  )

export const renameAt = (
  corpus: LoomCorpusAst,
  path: Location,
  offset: number,
): ReadonlyArray<CorpusLocation> =>
  Option.match(
    pipe(
      Option.fromNullishOr(corpus.modules.get(path)),
      Option.flatMap((module) =>
        Option.map(symbolAt(module.doc, offset), (symbol) => ({ module, symbol })),
      ),
    ),
    {
      onNone: () => [],
      onSome: ({ module, symbol }) =>
        Match.value(symbol.kind).pipe(
          Match.whenOr('warpAnchor', 'warpDef', () =>
            warpReferences(module, path, offset, (anchor) => anchor.name.position),
          ),
          Match.whenOr('headingTitle', 'sectionAnchor', () =>
            placeNamesAt(corpus, path, offset, segmentPosition),
          ),
          Match.whenOr('tocEntry', 'frontmatterTitle', () =>
            chapterNamesAt(corpus, path, offset, segmentPosition),
          ),
          Match.orElse((): ReadonlyArray<CorpusLocation> => []),
        ),
    },
  )

export const navigationRangeAt = (
  corpus: LoomCorpusAst,
  path: Location,
  offset: number,
): Option.Option<CorpusLocation> =>
  pipe(
    Option.fromNullishOr(corpus.modules.get(path)),
    Option.flatMap((module) => symbolAt(module.doc, offset)),
    Option.filter((symbol) => profileOf(symbol.kind).features.navigation === true),
    Option.map((symbol): CorpusLocation => ({ path, position: symbol.position })),
  )

export const renameRangeAt = (
  corpus: LoomCorpusAst,
  path: Location,
  offset: number,
): Option.Option<CorpusLocation> =>
  Option.filter(
    navigationRangeAt(corpus, path, offset),
    () => renameAt(corpus, path, offset).length > 0,
  )

const diagnosticsIn = (node: unknown): ReadonlyArray<Diagnostic> => {
  if (Array.isArray(node)) return node.flatMap(diagnosticsIn)
  if (node === null || typeof node !== 'object') return []
  const self =
    'health' in node
      ? (node as { health: { diagnostics: ReadonlyArray<Diagnostic> } }).health.diagnostics
      : []
  const nested = Object.entries(node).flatMap(([key, value]) =>
    key === 'health' ? [] : diagnosticsIn(value),
  )
  return [...self, ...nested]
}

export const moduleDiagnostics = (module: LoomModule): ReadonlyArray<Diagnostic> => [
  ...diagnosticsIn(module.doc),
  ...diagnosticsIn(module.product.code),
]

export const corpusErrors = (
  corpus: LoomCorpusAst,
  diagnosticsOf: (module: LoomModule) => ReadonlyArray<Diagnostic> = moduleDiagnostics,
): ReadonlyArray<{
  readonly path: Location
  readonly diagnostics: ReadonlyArray<Diagnostic>
}> =>
  pipe(
    Array.fromIterable(corpus.modules.values()),
    Array.map((m) => {
      const diagnostics = Array.filter(diagnosticsOf(m), (d) => d.severity === 'error')
      return diagnostics.length === 0 ? Option.none() : Option.some({ path: m.path, diagnostics })
    }),
    Array.getSomes,
  )
