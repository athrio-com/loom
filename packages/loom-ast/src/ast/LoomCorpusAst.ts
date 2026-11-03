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

type PartRef = {
  readonly number: Option.Option<string>
  readonly name: Option.Option<string>
}

type Chapter = {
  readonly title: string
  readonly number: Option.Option<string>
  readonly part: PartRef
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

const partOf = (names: ReadonlyMap<string, string>, module: LoomModule): PartRef => {
  const frontmatter = Option.fromNullishOr(module.doc.frontmatter)
  const number = pipe(
    frontmatter,
    Option.flatMapNullishOr((fm) => fm.part),
    Option.map((part) => part.value),
  )
  return {
    number,
    name: Option.orElse(
      pipe(
        frontmatter,
        Option.flatMapNullishOr((fm) => fm.partName),
        Option.map((partName) => partName.value),
      ),
      () => Option.flatMap(number, (n) => Option.fromNullishOr(names.get(n))),
    ),
  }
}

const samePart = (part: PartRef, other: PartRef): boolean =>
  Option.match(Option.all([part.number, other.number]), {
    onSome: ([number, otherNumber]) => number === otherNumber,
    onNone: () => Option.exists(part.name, (name) => Option.contains(other.name, name)),
  })

const chaptersIn = (modules: Modules): ReadonlyArray<Chapter> => {
  const names = partNamesIn(modules)
  return Array.getSomes(
    Array.map(Array.fromIterable(modules.values()), (module) =>
      Option.map(chapterTitleToken(module), (title) => ({
        title: title.source,
        number: Option.map(
          Option.fromNullishOr(module.doc.frontmatter?.chapter),
          (chapter) => chapter.value,
        ),
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
  Part: { readonly part: PartRef }
  Chapter: { readonly chapter: Chapter }
  Section: { readonly ref: SectionRef }
}>

const Place = Data.taggedEnum<Place>()

export type Segment = { readonly text: string; readonly start: number; readonly end: number }

export type Step = { readonly segment: Segment; readonly place: Place; readonly numbered: boolean }

export type Trail = Array.NonEmptyReadonlyArray<Step>

const numberIn = (keyword: string, name: string): Option.Option<string> =>
  Option.fromNullishOr(new RegExp(`^${keyword}\\s+(\\S+)$`).exec(name)?.[1])

const chaptersWithin = (
  book: Book,
  scope: Option.Option<PartRef>,
  test: (chapter: Chapter) => boolean,
): ReadonlyArray<Chapter> =>
  Array.filter(
    book.chapters,
    (chapter) =>
      test(chapter) &&
      Option.match(scope, {
        onNone: () => true,
        onSome: (part) => samePart(chapter.part, part),
      }),
  )

const partsWhere = (book: Book, test: (part: PartRef) => boolean): ReadonlyArray<PartRef> =>
  Option.toArray(
    Option.map(
      Array.findFirst(book.chapters, (chapter) => test(chapter.part)),
      (chapter) => chapter.part,
    ),
  )

const sectionTitled = (book: Book, module: Location, title: string): Option.Option<SectionRef> =>
  Option.fromNullishOr(book.titles.get(module)?.get(title))

const stepsNamed = (
  book: Book,
  scope: Option.Option<Place>,
  segment: Segment,
): ReadonlyArray<Step> => {
  const step =
    (numbered: boolean) =>
    (place: Place): Step => ({ segment, place, numbered })
  const chapterSteps = (part: Option.Option<PartRef>): ReadonlyArray<Step> => [
    ...Array.map(
      chaptersWithin(book, part, (chapter) => chapter.title === segment.text),
      (chapter) => step(false)(Place.Chapter({ chapter })),
    ),
    ...Option.match(numberIn('Chapter', segment.text), {
      onNone: (): ReadonlyArray<Step> => [],
      onSome: (number) =>
        Array.map(
          chaptersWithin(book, part, (chapter) => Option.contains(chapter.number, number)),
          (chapter) => step(true)(Place.Chapter({ chapter })),
        ),
    }),
  ]
  return Option.match(scope, {
    onNone: () => [
      ...Array.map(
        partsWhere(book, (part) => Option.contains(part.name, segment.text)),
        (part) => step(false)(Place.Part({ part })),
      ),
      ...Option.match(numberIn('Part', segment.text), {
        onNone: (): ReadonlyArray<Step> => [],
        onSome: (number) =>
          Array.map(
            partsWhere(book, (part) => Option.contains(part.number, number)),
            (part) => step(true)(Place.Part({ part })),
          ),
      }),
      ...chapterSteps(Option.none()),
    ],
    onSome: (place) =>
      Match.value(place).pipe(
        Match.tag('Part', ({ part }) => chapterSteps(Option.some(part))),
        Match.tag('Chapter', ({ chapter }) =>
          Option.toArray(
            Option.map(sectionTitled(book, chapter.module.path, segment.text), (ref) =>
              step(false)(Place.Section({ ref })),
            ),
          ),
        ),
        Match.tag('Section', (): ReadonlyArray<Step> => []),
        Match.exhaustive,
      ),
  })
}

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
        stepsNamed(
          book,
          Option.map(Array.last(trail), (step) => step.place),
          segment,
        ),
        (step) => walk(book, Array.append(trail, step), rest),
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
      { segment: whole(name), place: Place.Section({ ref }), numbered: false },
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

const chapterOf = (book: Book, module: Location): Option.Option<Chapter> =>
  Array.findFirst(book.chapters, (chapter) => chapter.module.path === module)

const throughPart = (
  chapter: Chapter,
  names: ReadonlyArray<string>,
): ReadonlyArray<ReadonlyArray<string>> => [
  names,
  ...Option.toArray(Option.map(chapter.part.name, (part) => [part, ...names])),
]

const namesFor = (book: Book, place: Place): ReadonlyArray<ReadonlyArray<string>> =>
  Match.value(place).pipe(
    Match.tag('Chapter', ({ chapter }) => throughPart(chapter, [chapter.title])),
    Match.tag('Section', ({ ref }) =>
      Option.match(
        Option.all([chapterOf(book, ref.module), Option.fromNullishOr(ref.section.heading.title)]),
        {
          onNone: (): ReadonlyArray<ReadonlyArray<string>> => [],
          onSome: ([chapter, title]) => throughPart(chapter, [chapter.title, title.source]),
        },
      ),
    ),
    Match.tag('Part', (): ReadonlyArray<ReadonlyArray<string>> => []),
    Match.exhaustive,
  )

const samePlace = (place: Place, other: Place): boolean =>
  Match.value(place).pipe(
    Match.tag('Part', ({ part }) => other._tag === 'Part' && samePart(part, other.part)),
    Match.tag(
      'Chapter',
      ({ chapter }) =>
        other._tag === 'Chapter' && other.chapter.module.path === chapter.module.path,
    ),
    Match.tag('Section', ({ ref }) => namesSection(ref)(other)),
    Match.exhaustive,
  )

const leadsTo =
  (book: Book, from: Location, place: Place) =>
  (path: string): boolean =>
    Option.exists(soleTrail(trailsOf(book, from, path)), (trail) =>
      samePlace(Array.lastNonEmpty(trail).place, place),
    )

export const pathsTo = (
  book: Book,
  from: Location,
  trails: ReadonlyArray<Trail>,
): ReadonlyArray<string> =>
  Array.getSomes(
    Array.map(trails, (trail) => {
      const place = Array.lastNonEmpty(trail).place
      return Array.findFirst(
        Array.map(namesFor(book, place), (names) => Array.join(names, ', ')),
        leadsTo(book, from, place),
      )
    }),
  )

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

const anchorStepAt = (
  book: Book,
  modules: Modules,
  path: Location,
  offset: number,
): Option.Option<Step> =>
  Option.flatMap(anchorAt(modules, path, offset), (anchor) =>
    Option.map(soleTrail(anchorTrails(book, path, anchor)), (trail) =>
      stepAt(trail, anchor, offset),
    ),
  )

type Mention = { readonly place: Place; readonly numbered: boolean }

const mentionAt = (
  book: Book,
  modules: Modules,
  path: Location,
  offset: number,
): Option.Option<Mention> =>
  Option.orElse(
    Option.map(sectionRefAt(modules, path, offset), (ref): Mention => ({
      place: Place.Section({ ref }),
      numbered: false,
    })),
    () => anchorStepAt(book, modules, path, offset),
  )

const stepsOf = (book: Book, from: Location, anchor: WarpAnchorToken): ReadonlyArray<Step> =>
  Option.match(soleTrail(anchorTrails(book, from, anchor)), {
    onNone: (): ReadonlyArray<Step> => [],
    onSome: (trail) => trail,
  })

const anchorsNaming = (
  book: Book,
  modules: Modules,
  names: (step: Step) => boolean,
  spanOf: SpanOf,
): ReadonlyArray<CorpusLocation> =>
  Array.flatMap(Array.fromIterable(modules.values()), (m) =>
    pipe(
      m.doc.sections,
      Array.flatMap(anchorsOf),
      Array.flatMap((anchor) =>
        pipe(
          stepsOf(book, m.path, anchor),
          Array.filter(names),
          Array.map((step): CorpusLocation => ({
            path: m.path,
            position: spanOf(anchor, step.segment),
          })),
        ),
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
  (chapter: Chapter) =>
  (place: Place): boolean =>
    place._tag === 'Chapter' && place.chapter.module.path === chapter.module.path

const sectionDefinitionAt = (
  corpus: LoomCorpusAst,
  path: Location,
  offset: number,
): Option.Option<CorpusLocation> =>
  Option.flatMap(anchorStepAt(bookOf(corpus.modules), corpus.modules, path, offset), ({ place }) =>
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
  ...anchorsNaming(book, modules, (step) => namesSection(ref)(step.place), spanOf),
]

const placeNames = (
  book: Book,
  modules: Modules,
  mention: Mention,
  spanOf: SpanOf,
): ReadonlyArray<CorpusLocation> =>
  Match.value(mention.place).pipe(
    Match.tag('Section', ({ ref }) => sectionNames(book, modules, ref, spanOf)),
    Match.tag('Chapter', ({ chapter }) =>
      mention.numbered
        ? chapterNumbers(book, modules, chapter, spanOf)
        : chapterNames(book, modules, chapter, spanOf),
    ),
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
  return Option.match(mentionAt(book, corpus.modules, path, offset), {
    onNone: (): ReadonlyArray<CorpusLocation> => [],
    onSome: (mention) => placeNames(book, corpus.modules, mention, spanOf),
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

const tocEntriesOf = (module: LoomModule): ReadonlyArray<TocWeft> =>
  Array.flatMap(module.doc.sections, (section) => section.entries ?? [])

type PlacedEntry = { readonly title: TocTitleToken; readonly part: Option.Option<PartRef> }

const tocPartRef = (part: TocPartToken): PartRef =>
  Option.match(Option.fromNullishOr(partNumberMarker.exec(part.value)), {
    onNone: () => ({ number: Option.none(), name: Option.some(part.value.trim()) }),
    onSome: (match) => ({
      number: Option.fromNullishOr(match[1]),
      name: Option.fromNullishOr(/[—–-]\s*(.+)$/.exec(part.value)?.[1]?.trim()),
    }),
  })

const placedEntriesOf = (module: LoomModule): ReadonlyArray<PlacedEntry> =>
  Array.flatMap(module.doc.sections, (section) =>
    Array.getSomes(
      Array.mapAccum(
        section.entries ?? [],
        Option.none<PartRef>(),
        (part, entry): readonly [Option.Option<PartRef>, Option.Option<PlacedEntry>] =>
          Option.match(Option.fromNullishOr(entry.part), {
            onSome: (token) => [Option.some(tocPartRef(token)), Option.none()],
            onNone: () => [
              part,
              Option.map(Option.fromNullishOr(entry.title), (title) => ({ title, part })),
            ],
          }),
      )[1],
    ),
  )

const entryChapter = (book: Book, placed: PlacedEntry): Option.Option<Chapter> =>
  Array.findFirst(
    book.chapters,
    (chapter) =>
      chapter.title === placed.title.value &&
      Option.match(placed.part, {
        onNone: () => true,
        onSome: (part) => samePart(chapter.part, part),
      }),
  )

const chapterAt = (
  book: Book,
  modules: Modules,
  path: Location,
  offset: number,
): Option.Option<Chapter> =>
  Option.flatMap(Option.fromNullishOr(modules.get(path)), (module) =>
    Option.orElse(
      Option.flatMap(
        Array.findFirst(placedEntriesOf(module), (placed) => covers(placed.title.position, offset)),
        (placed) => entryChapter(book, placed),
      ),
      () =>
        pipe(
          Option.fromNullishOr(module.doc.frontmatter?.title),
          Option.filter((title) => covers(title.position, offset)),
          Option.flatMap(() => chapterOf(book, path)),
        ),
    ),
  )

const chapterDefinitionAt = (
  corpus: LoomCorpusAst,
  path: Location,
  offset: number,
): Option.Option<CorpusLocation> =>
  Option.flatMap(chapterAt(bookOf(corpus.modules), corpus.modules, path, offset), chapterLocation)

const entriesNaming = (
  book: Book,
  modules: Modules,
  chapter: Chapter,
): ReadonlyArray<CorpusLocation> =>
  Array.flatMap(Array.fromIterable(modules.values()), (module) =>
    pipe(
      placedEntriesOf(module),
      Array.filter((placed) =>
        Option.exists(
          entryChapter(book, placed),
          (found) => found.module.path === chapter.module.path,
        ),
      ),
      Array.map((placed): CorpusLocation => ({
        path: module.path,
        position: placed.title.position,
      })),
    ),
  )

const chapterNames = (
  book: Book,
  modules: Modules,
  chapter: Chapter,
  spanOf: SpanOf,
): ReadonlyArray<CorpusLocation> => [
  ...Option.toArray(chapterLocation(chapter)),
  ...entriesNaming(book, modules, chapter),
  ...anchorsNaming(
    book,
    modules,
    (step) => !step.numbered && namesChapter(chapter)(step.place),
    spanOf,
  ),
]

const chapterNamesAt = (
  corpus: LoomCorpusAst,
  path: Location,
  offset: number,
  spanOf: SpanOf,
): ReadonlyArray<CorpusLocation> => {
  const book = bookOf(corpus.modules)
  return Option.match(chapterAt(book, corpus.modules, path, offset), {
    onNone: (): ReadonlyArray<CorpusLocation> => [],
    onSome: (chapter) => chapterNames(book, corpus.modules, chapter, spanOf),
  })
}

const chapterNumbers = (
  book: Book,
  modules: Modules,
  chapter: Chapter,
  spanOf: SpanOf,
): ReadonlyArray<CorpusLocation> => [
  ...Option.toArray(
    Option.map(
      Option.fromNullishOr(chapter.module.doc.frontmatter?.chapter),
      (number): CorpusLocation => ({ path: chapter.module.path, position: number.position }),
    ),
  ),
  ...anchorsNaming(
    book,
    modules,
    (step) => step.numbered && namesChapter(chapter)(step.place),
    spanOf,
  ),
]

const chapterNumbersAt = (
  corpus: LoomCorpusAst,
  path: Location,
  spanOf: SpanOf,
): ReadonlyArray<CorpusLocation> => {
  const book = bookOf(corpus.modules)
  return Option.match(chapterOf(book, path), {
    onNone: (): ReadonlyArray<CorpusLocation> => [],
    onSome: (chapter) => chapterNumbers(book, corpus.modules, chapter, spanOf),
  })
}

export const unresolvedTocEntriesIn = (
  corpus: LoomCorpusAst,
  module: LoomModule,
): ReadonlyArray<TocTitleToken> => {
  const book = bookOf(corpus.modules)
  return pipe(
    placedEntriesOf(module),
    Array.filter((placed) => Option.isNone(entryChapter(book, placed))),
    Array.map((placed) => placed.title),
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
          Match.when('frontmatterMembership', () => chapterNumbersAt(corpus, path, wholeAnchor)),
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
          Match.when('frontmatterMembership', () =>
            chapterNumbersAt(corpus, path, segmentPosition),
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

export type CorpusHint = { readonly offset: number; readonly label: string }

const labelOf = (place: Place): Option.Option<string> =>
  Match.value(place).pipe(
    Match.tag('Chapter', ({ chapter }) => Option.some(chapter.title)),
    Match.tag('Part', ({ part }) => part.name),
    Match.tag('Section', () => Option.none<string>()),
    Match.exhaustive,
  )

export const hintsAt = (corpus: LoomCorpusAst, path: Location): ReadonlyArray<CorpusHint> => {
  const book = bookOf(corpus.modules)
  return Option.match(Option.fromNullishOr(corpus.modules.get(path)), {
    onNone: (): ReadonlyArray<CorpusHint> => [],
    onSome: (module) =>
      pipe(
        module.doc.sections,
        Array.flatMap(anchorsOf),
        Array.flatMap((anchor) =>
          pipe(
            stepsOf(book, path, anchor),
            Array.filter((step) => step.numbered),
            Array.map((step) =>
              Option.map(labelOf(step.place), (label) => ({
                offset: segmentPosition(anchor, step.segment).end.offset,
                label,
              })),
            ),
            Array.getSomes,
          ),
        ),
      ),
  })
}

export type LabelSlot = {
  readonly start: number
  readonly end: number
  readonly closed: boolean
}

const openSlot = (text: string, brace: number, offset: number): Option.Option<LabelSlot> =>
  text[brace] === '{' && brace < offset && !text.slice(brace, offset).includes('\n')
    ? Option.some({ start: brace + 1, end: offset, closed: false })
    : Option.none()

const slotOf =
  (text: string, offset: number) =>
  (anchor: WarpAnchorToken): Option.Option<LabelSlot> =>
    pipe(
      Match.value(anchor.specifier).pipe(
        Match.when({ type: 'Specifier' }, ({ open, close }) =>
          Option.some({
            start: open.position.end.offset,
            end: close.position.start.offset,
            closed: true,
          }),
        ),
        Match.when({ type: 'Parameters' }, () => Option.none<LabelSlot>()),
        Match.when(Match.undefined, () => openSlot(text, anchor.position.end.offset, offset)),
        Match.exhaustive,
      ),
      Option.filter((slot) => slot.start <= offset && offset <= slot.end),
    )

export const labelSlotAt = (
  corpus: LoomCorpusAst,
  path: Location,
  offset: number,
): Option.Option<LabelSlot> =>
  pipe(
    Option.fromNullishOr(corpus.modules.get(path)),
    Option.flatMap((module) =>
      Array.findFirst(allAnchorsOf(module.doc), slotOf(module.text, offset)),
    ),
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

export type Namesakes = {
  readonly title: { readonly source: string; readonly position: Position }
  readonly looms: ReadonlyArray<Location>
}

export const namesakesOf = (book: Book, module: LoomModule): Option.Option<Namesakes> =>
  pipe(
    Option.all({ chapter: chapterOf(book, module.path), title: chapterTitleToken(module) }),
    Option.flatMap(({ chapter, title }) =>
      pipe(
        book.chapters,
        Array.filter(
          (other) =>
            other.module.path !== module.path &&
            other.title === chapter.title &&
            samePart(chapter.part, other.part),
        ),
        Array.map((other) => other.module.path),
        Option.liftPredicate(Array.isReadonlyArrayNonEmpty),
        Option.map((looms) => ({ title, looms })),
      ),
    ),
  )
