import { Array, Data, Match, Option, Order, pipe, Schema } from 'effect'
import { memoize } from 'effect/Function'
import { type Diagnostic, type Point, type Position, shifted } from '#ast/LoomNode'
import {
  boxKind,
  type BoxNameToken,
  type BoxToken,
  chapterKind,
  conceptKind,
  conclusionKind,
  discussionKind,
  type FrontmatterBookToken,
  type FrontmatterEntryToken,
  type FrontmatterKindToken,
  type HeadingTitleToken,
  isLoomKind,
  isPointingKind,
  type LoomKind,
  type ParameterKeyToken,
  type ParametersToken,
  type ParameterToken,
  type ParameterValueToken,
  type PointingKind,
  valueWords,
  type SpecifierToken,
  tropeKind,
  type WarpAnchorToken,
  type WarpToken,
  type Zone,
} from '#ast/LoomTokens'
import {
  boxOf,
  type LoomWeft,
  type PreambleWeft,
  type ProseWeft,
  type SectionBodyWeft,
  standingOf,
  type TildeWeft,
} from '#ast/Weft'
import { ProductSchema, type Provided } from '#ast/ProductAst'
import { type Bearer, LoomDocumentSchema, type LoomDocument, type LoomSection } from '#ast/LoomAst'
import { profileOf, symbolAt, type SymbolKind } from '#ast/LoomSymbol'
import { isNode } from '#ast/TreeFold'

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

const titlesIn: (module: LoomModule) => ReadonlyMap<string, SectionRef> = memoize((module: LoomModule) =>
  pipe(
    module.doc.sections.map((section) =>
      Option.map(
        Option.fromNullishOr(section.heading.title),
        (title) => [title.source, { module: module.path, section }] as const,
      ),
    ),
    Array.getSomes,
    Array.reduce(new Map<string, SectionRef>(), (index, [title, ref]) =>
      index.has(title) ? index : new Map(index).set(title, ref),
    ),
  ),
)

export type TitleIndexes = ReadonlyMap<Location, ReadonlyMap<string, SectionRef>>

export const titleIndexes = (modules: Modules): TitleIndexes =>
  new Map(Array.fromIterable(modules.values()).map((m) => [m.path, titlesIn(m)] as const))

export type PartRef = {
  readonly book: Option.Option<string>
  readonly number: Option.Option<string>
  readonly name: Option.Option<string>
}

export type Chapter = {
  readonly title: string
  readonly number: Option.Option<string>
  readonly kind: string
  readonly book: Option.Option<string>
  readonly part: PartRef
  readonly module: LoomModule
}

export const bookOf = (module: LoomModule): Option.Option<string> =>
  Option.map(Option.fromNullishOr(module.doc.frontmatter?.book), (book) => book.value)

const sameBook = (book: Option.Option<string>, other: Option.Option<string>): boolean =>
  Option.getOrNull(book) === Option.getOrNull(other)

const partKey = (book: Option.Option<string>, number: string): string =>
  JSON.stringify([Option.getOrNull(book), number])

const partNamesIn = (modules: Modules): ReadonlyMap<string, string> =>
  new Map(
    Array.getSomes(
      Array.fromIterable(modules.values()).map((module) =>
        pipe(
          Option.fromNullishOr(module.doc.frontmatter),
          Option.flatMap((fm) =>
            Option.all([Option.fromNullishOr(fm.part), Option.fromNullishOr(fm.partName)]),
          ),
          Option.map(
            ([part, partName]) => [partKey(bookOf(module), part.value), partName.value] as const,
          ),
        ),
      ),
    ),
  )

const partOf = (names: ReadonlyMap<string, string>, module: LoomModule): PartRef => {
  const book = bookOf(module)
  const frontmatter = Option.fromNullishOr(module.doc.frontmatter)
  const number = pipe(
    frontmatter,
    Option.flatMapNullishOr((fm) => fm.part),
    Option.map((part) => part.value),
  )
  return {
    book,
    number,
    name: Option.orElse(
      pipe(
        frontmatter,
        Option.flatMapNullishOr((fm) => fm.partName),
        Option.map((partName) => partName.value),
      ),
      () => Option.flatMap(number, (n) => Option.fromNullishOr(names.get(partKey(book, n)))),
    ),
  }
}

const samePart = (part: PartRef, other: PartRef): boolean =>
  sameBook(part.book, other.book) &&
  Option.match(Option.all([part.number, other.number]), {
    onSome: ([number, otherNumber]) => number === otherNumber,
    onNone: () => Option.exists(part.name, (name) => Option.contains(other.name, name)),
  })

export const isBookLoom = (module: LoomModule): boolean =>
  Option.exists(
    Option.fromNullishOr(module.doc.frontmatter),
    (fm) =>
      fm.book !== undefined &&
      fm.title === undefined &&
      fm.part === undefined &&
      fm.partName === undefined,
  )

export const claimedKind = (module: LoomModule): Option.Option<FrontmatterKindToken> =>
  Option.filter(
    Option.fromNullishOr(module.doc.frontmatter?.kind),
    (named) => named.zone !== undefined,
  )

export const loomKindOf = (module: LoomModule): string =>
  module.doc.frontmatter?.discussion !== undefined
    ? discussionKind
    : Option.getOrElse(
        Option.map(claimedKind(module), (named) => named.value),
        () => chapterKind,
      )

export const zoneOf = (module: LoomModule): Zone =>
  module.doc.frontmatter?.discussion !== undefined
    ? 'back'
    : Option.getOrElse(
        Option.flatMap(claimedKind(module), (named) => Option.fromNullishOr(named.zone)),
        (): Zone => 'body',
      )

export const ordinalOf = (module: LoomModule): Option.Option<string> =>
  pipe(
    Option.fromNullishOr(module.doc.frontmatter?.chapter ?? module.doc.frontmatter?.discussion),
    Option.map((ordinal) => ordinal.value),
    Option.orElse(() => Option.map(claimedKind(module), (named) => named.number)),
    Option.filter((ordinal) => ordinal !== ''),
  )

const chaptersIn = (modules: Modules): ReadonlyArray<Chapter> => {
  const names = partNamesIn(modules)
  return Array.getSomes(
    Array.fromIterable(modules.values())
      .filter((module) => !isBookLoom(module))
      .map((module) =>
        Option.map(chapterTitleToken(module), (title) => ({
          title: title.source,
          number: ordinalOf(module),
          kind: loomKindOf(module),
          book: bookOf(module),
          part: partOf(names, module),
          module,
        })),
      ),
  )
}

const openingSectionOf = (module: LoomModule): Option.Option<LoomSection> =>
  Array.findFirst(module.doc.sections, (section) => section.heading.title !== undefined)

type Filed = ReadonlyMap<string, ReadonlyArray<Chapter>>

type ChapterIndex = {
  readonly loom: ReadonlyMap<Location, Chapter>
  readonly title: Filed
  readonly number: Filed
  readonly partName: Filed
  readonly partNumber: Filed
}

type Entry = readonly [key: string, chapter: Chapter]

const sameKey = (one: Entry, other: Entry): boolean => one[0] === other[0]

const filedOf = (
  entries: Array.NonEmptyReadonlyArray<Entry>,
): readonly [string, ReadonlyArray<Chapter>] => [
  Array.headNonEmpty(entries)[0],
  entries.map(([, chapter]) => chapter),
]

const groupedBy = (
  chapters: ReadonlyArray<Chapter>,
  keysOf: (chapter: Chapter) => ReadonlyArray<string>,
): Filed => {
  const entries = Array.sortWith(
    chapters.flatMap((chapter) => keysOf(chapter).map((key): Entry => [key, chapter])),
    (entry: Entry) => entry[0],
    Order.String,
  )
  return new Map(
    Array.isReadonlyArrayNonEmpty(entries) ? Array.groupWith(entries, sameKey).map(filedOf) : [],
  )
}

const chapterIndexOf = (chapters: ReadonlyArray<Chapter>): ChapterIndex => ({
  loom: new Map(chapters.map((chapter) => [chapter.module.path, chapter] as const)),
  title: groupedBy(chapters, (chapter) => [chapter.title]),
  number: groupedBy(chapters, (chapter) => Option.toArray(chapter.number)),
  partName: groupedBy(chapters, (chapter) => Option.toArray(chapter.part.name)),
  partNumber: groupedBy(chapters, (chapter) => Option.toArray(chapter.part.number)),
})

const filedUnder = (filed: Filed, key: string): ReadonlyArray<Chapter> =>
  Option.getOrElse(Option.fromNullishOr(filed.get(key)), (): ReadonlyArray<Chapter> => [])

export type Catalogue = {
  readonly modules: Modules
  readonly titles: TitleIndexes
  readonly chapters: ReadonlyArray<Chapter>
  readonly chaptersBy: ChapterIndex
  readonly kinds: ReadonlyArray<string>
  readonly boxes: ReadonlyMap<Location, ReadonlyArray<BoxRef>>
  readonly concepts: ReadonlyArray<ConceptRef>
  readonly links: ReadonlySet<string>
  readonly books: ReadonlySet<string>
}

const kindsAmong = (chapters: ReadonlyArray<Chapter>): ReadonlyArray<string> =>
  Array.dedupe(chapters.map((chapter) => chapter.kind))

export const catalogueOf: (modules: Modules) => Catalogue = memoize((modules: Modules) => {
  const chapters = chaptersIn(modules)
  return {
    modules,
    titles: titleIndexes(modules),
    chapters,
    chaptersBy: chapterIndexOf(chapters),
    kinds: kindsAmong(chapters),
    boxes: new Map(
      Array.fromIterable(modules.values()).map((module) => [module.path, pointingBoxesOf(module)]),
    ),
    concepts: Array.fromIterable(modules.values()).flatMap(conceptsOf),
    links: new Set(
      Array.fromIterable(modules.values()).flatMap((module) =>
        linksOf(module).map((anchor) => linkKey(module.path, anchor)),
      ),
    ),
    books: new Set(Array.getSomes(Array.fromIterable(modules.values()).map(bookOf))),
  }
})

const bookAt = (catalogue: Catalogue, from: Location): Option.Option<string> =>
  Option.flatMap(Option.fromNullishOr(catalogue.modules.get(from)), bookOf)

const isBook = (catalogue: Catalogue, name: string): boolean => catalogue.books.has(name)

export type Place = Data.TaggedEnum<{
  Book: { readonly book: string }
  Part: { readonly part: PartRef }
  Chapter: { readonly chapter: Chapter }
  Section: { readonly ref: SectionRef }
  Box: { readonly ref: BoxRef }
}>

const Place = Data.taggedEnum<Place>()

export type Segment = { readonly text: string; readonly start: number; readonly end: number }

export type Step = {
  readonly segment: Segment
  readonly place: Place
  readonly numbered: boolean
  readonly through: Option.Option<BoxRef>
}

export type Trail = Array.NonEmptyReadonlyArray<Step>

const numberedName = /^(.*\S)\s+(\S+)$/

const numberIn = (keyword: string, name: string): Option.Option<string> =>
  pipe(
    Option.fromNullishOr(numberedName.exec(name)),
    Option.filter((found) => found[1] === keyword),
    Option.flatMapNullishOr((found) => found[2]),
  )

const chaptersWithin = (
  chapters: ReadonlyArray<Chapter>,
  book: Option.Option<string>,
  part: Option.Option<PartRef>,
): ReadonlyArray<Chapter> =>
  chapters.filter(
    (chapter) =>
      sameBook(chapter.book, book) &&
      Option.match(part, {
        onNone: () => true,
        onSome: (part) => samePart(chapter.part, part),
      }),
  )

const partAmong = (
  chapters: ReadonlyArray<Chapter>,
  book: Option.Option<string>,
): ReadonlyArray<PartRef> =>
  Option.toArray(
    Option.map(
      Array.findFirst(chapters, (chapter) => sameBook(chapter.book, book)),
      (chapter) => chapter.part,
    ),
  )

const sectionTitled = (
  catalogue: Catalogue,
  module: Location,
  title: string,
): Option.Option<SectionRef> => Option.fromNullishOr(catalogue.titles.get(module)?.get(title))

const numberedSteps = (
  catalogue: Catalogue,
  book: Option.Option<string>,
  part: Option.Option<PartRef>,
  kind: string,
  step: (place: Place) => Step,
  segment: Segment,
): ReadonlyArray<Step> =>
  Option.match(numberIn(kind, segment.text), {
    onNone: (): ReadonlyArray<Step> => [],
    onSome: (number) =>
      chaptersWithin(
        filedUnder(catalogue.chaptersBy.number, number).filter((chapter) => chapter.kind === kind),
        book,
        part,
      ).map((chapter) => step(Place.Chapter({ chapter }))),
  })

const stepsNamed = (
  catalogue: Catalogue,
  own: Option.Option<string>,
  scope: Option.Option<Place>,
  segment: Segment,
): ReadonlyArray<Step> => {
  const step =
    (numbered: boolean) =>
    (place: Place): Step => ({ segment, place, numbered, through: Option.none() })
  const chapterSteps = (
    book: Option.Option<string>,
    part: Option.Option<PartRef>,
  ): ReadonlyArray<Step> => [
    ...chaptersWithin(filedUnder(catalogue.chaptersBy.title, segment.text), book, part).map(
      (chapter) => step(false)(Place.Chapter({ chapter })),
    ),
    ...catalogue.kinds.flatMap((kind) =>
      numberedSteps(catalogue, book, part, kind, step(true), segment),
    ),
  ]
  const bookSteps = (book: Option.Option<string>): ReadonlyArray<Step> => [
    ...partAmong(filedUnder(catalogue.chaptersBy.partName, segment.text), book).map((part) =>
      step(false)(Place.Part({ part })),
    ),
    ...Option.match(numberIn('Part', segment.text), {
      onNone: (): ReadonlyArray<Step> => [],
      onSome: (number) =>
        partAmong(filedUnder(catalogue.chaptersBy.partNumber, number), book).map((part) =>
          step(true)(Place.Part({ part })),
        ),
    }),
    ...chapterSteps(book, Option.none()),
  ]
  return Option.match(scope, {
    onNone: () => [
      ...(isBook(catalogue, segment.text) ? [step(false)(Place.Book({ book: segment.text }))] : []),
      ...bookSteps(own),
    ],
    onSome: (place) =>
      Place.$match(place, {
        Book: ({ book }) => bookSteps(Option.some(book)),
        Part: ({ part }) => chapterSteps(part.book, Option.some(part)),
        Chapter: ({ chapter }) =>
          Option.toArray(
            pipe(
              Option.map(sectionTitled(catalogue, chapter.module.path, segment.text), (ref) =>
                step(false)(Place.Section({ ref })),
              ),
              Option.orElse(() =>
                Option.map(boxNamed(catalogue, chapter.module.path, segment.text), (ref) => ({
                  ...step(false)(boxPlace(catalogue, ref)),
                  through: throughOf(ref),
                })),
              ),
              Option.orElse(() =>
                Option.map(
                  conceptNamedIn(catalogue, chapter.module.path, segment.text),
                  (concept) => step(false)(Place.Section({ ref: conceptSectionOf(concept) })),
                ),
              ),
            ),
          ),
        Section: (): ReadonlyArray<Step> => [],
        Box: (): ReadonlyArray<Step> => [],
      }),
  })
}

const groupsChapters = (place: Place): boolean => place._tag === 'Book' || place._tag === 'Part'

const finished = (trail: ReadonlyArray<Step>): ReadonlyArray<Trail> =>
  Array.isReadonlyArrayNonEmpty(trail) && !groupsChapters(Array.lastNonEmpty(trail).place)
    ? [trail]
    : []

const walk = (
  catalogue: Catalogue,
  own: Option.Option<string>,
  trail: ReadonlyArray<Step>,
  segments: ReadonlyArray<Segment>,
): ReadonlyArray<Trail> =>
  Array.matchLeft(segments, {
    onEmpty: () => finished(trail),
    onNonEmpty: (segment, rest) =>
      stepsNamed(
        catalogue,
        own,
        Option.map(Array.last(trail), (step) => step.place),
        segment,
      ).flatMap((step) => walk(catalogue, own, Array.append(trail, step), rest)),
  })

const whole = (name: string): Segment => ({ text: name, start: 0, end: name.length })

const segmentsOf = (name: string): ReadonlyArray<Segment> =>
  Array.fromIterable(name.matchAll(/[^,]+/g)).map((match) => {
    const text = match[0].trim()
    const start = match.index + match[0].length - match[0].trimStart().length
    return { text, start, end: start + text.length }
  })

const sectionTrail = (catalogue: Catalogue, module: Location, name: string): ReadonlyArray<Trail> =>
  Option.toArray(
    Option.map(sectionTitled(catalogue, module, name), (ref): Trail => [
      {
        segment: whole(name),
        place: Place.Section({ ref }),
        numbered: false,
        through: Option.none(),
      },
    ]),
  )

const nothingFound: ReadonlyArray<Trail> = []

const nearest = (lookups: ReadonlyArray<() => ReadonlyArray<Trail>>): ReadonlyArray<Trail> =>
  lookups.reduce((found, lookup) => (found.length > 0 ? found : lookup()), nothingFound)

const chapterTrails = (
  catalogue: Catalogue,
  own: Option.Option<string>,
  name: string,
): ReadonlyArray<Trail> =>
  nearest([
    () => walk(catalogue, own, [], [whole(name)]),
    () => walk(catalogue, own, [], segmentsOf(name)),
  ])

export const trailsOf = (
  catalogue: Catalogue,
  from: Location,
  name: string,
): ReadonlyArray<Trail> =>
  nearest([
    () => sectionTrail(catalogue, from, name),
    () => boxTrail(catalogue, from, name),
    () => chapterTrails(catalogue, bookAt(catalogue, from), name),
  ])

export const anchorTrails = (
  catalogue: Catalogue,
  from: Location,
  anchor: WarpAnchorToken,
): ReadonlyArray<Trail> =>
  catalogue.links.has(linkKey(from, anchor))
    ? linkTrailsOf(catalogue, from, anchor.name.value)
    : trailsOf(catalogue, from, anchor.name.value)

export const sectionOf = (trail: Trail): Option.Option<SectionRef> =>
  placeSectionOf(Array.lastNonEmpty(trail).place)

const placeSectionOf: (place: Place) => Option.Option<SectionRef> = Match.type<Place>().pipe(
  Match.tag('Section', ({ ref }) => Option.some(ref)),
  Match.tag('Chapter', ({ chapter }) =>
    Option.map(openingSectionOf(chapter.module), (section) => ({
      module: chapter.module.path,
      section,
    })),
  ),
  Match.tag('Book', () => Option.none<SectionRef>()),
  Match.tag('Part', () => Option.none<SectionRef>()),
  Match.tag('Box', () => Option.none<SectionRef>()),
  Match.exhaustive,
)

const soleTrail = (trails: ReadonlyArray<Trail>): Option.Option<Trail> =>
  trails.length === 1 ? Array.head(trails) : Option.none()

export const resolveName = (
  catalogue: Catalogue,
  from: Location,
  name: string,
): Option.Option<SectionRef> =>
  Option.flatMap(soleTrail(trailsOf(catalogue, from, name)), sectionOf)

export const resolveAnchor = (
  catalogue: Catalogue,
  from: Location,
  anchor: WarpAnchorToken,
): Option.Option<SectionRef> =>
  Option.flatMap(soleTrail(anchorTrails(catalogue, from, anchor)), sectionOf)

const tropeEntryChapterOf = (
  catalogue: Catalogue,
  from: Location,
  name: string,
): Option.Option<Chapter> =>
  pipe(
    soleTrail(chapterTrails(catalogue, bookAt(catalogue, from), name)),
    Option.map((trail) => Array.lastNonEmpty(trail).place),
    Option.flatMap((place) =>
      place._tag === 'Chapter' ? Option.some(place.chapter) : Option.none(),
    ),
  )

export const tropeEntryModuleOf = (
  catalogue: Catalogue,
  from: Location,
  name: string,
): Option.Option<LoomModule> =>
  Option.map(tropeEntryChapterOf(catalogue, from, name), (chapter) => chapter.module)

export const chapterOf = (catalogue: Catalogue, module: Location): Option.Option<Chapter> =>
  Option.fromNullishOr(catalogue.chaptersBy.loom.get(module))

const throughPart = (
  chapter: Chapter,
  names: ReadonlyArray<string>,
): ReadonlyArray<ReadonlyArray<string>> => [
  names,
  ...Option.toArray(Option.map(chapter.part.name, (part) => [part, ...names])),
]

const throughBook = (
  chapter: Chapter,
  paths: ReadonlyArray<ReadonlyArray<string>>,
): ReadonlyArray<ReadonlyArray<string>> => [
  ...paths,
  ...Option.match(chapter.book, {
    onNone: (): ReadonlyArray<ReadonlyArray<string>> => [],
    onSome: (book) => paths.map((path) => [book, ...path]),
  }),
]

const namesFor = Match.fn((_catalogue: Catalogue, place: Place) => place).pipe(
  Match.withReturnType<ReadonlyArray<ReadonlyArray<string>>>(),
  Match.tag('Chapter', ({ chapter }) =>
    throughBook(chapter, throughPart(chapter, [chapter.title])),
  ),
  Match.tag('Section', ({ ref }, catalogue) =>
    Option.match(
      Option.all([
        chapterOf(catalogue, ref.module),
        Option.fromNullishOr(ref.section.heading.title),
      ]),
      {
        onNone: (): ReadonlyArray<ReadonlyArray<string>> => [],
        onSome: ([chapter, title]) =>
          throughBook(chapter, throughPart(chapter, [chapter.title, title.source])),
      },
    ),
  ),
  Match.tag('Box', ({ ref }, catalogue) =>
    Option.match(chapterOf(catalogue, ref.module), {
      onNone: (): ReadonlyArray<ReadonlyArray<string>> => [],
      onSome: (chapter) =>
        throughBook(chapter, throughPart(chapter, [chapter.title, ref.name.value])),
    }),
  ),
  Match.tag('Book', (): ReadonlyArray<ReadonlyArray<string>> => []),
  Match.tag('Part', (): ReadonlyArray<ReadonlyArray<string>> => []),
  Match.exhaustive,
)

const samePlace = Match.fn((place: Place, _other: Place) => place).pipe(
  Match.withReturnType<boolean>(),
  Match.tag('Book', ({ book }, _place, other) => other._tag === 'Book' && other.book === book),
  Match.tag('Part', ({ part }, _place, other) =>
    other._tag === 'Part' && samePart(part, other.part),
  ),
  Match.tag(
    'Chapter',
    ({ chapter }, _place, other) =>
      other._tag === 'Chapter' && other.chapter.module.path === chapter.module.path,
    ),
  Match.tag('Section', ({ ref }, _place, other) => namesSection(ref)(other)),
  Match.tag('Box', ({ ref }, _place, other) => namesBox(ref)(other)),
  Match.exhaustive,
)

const leadsTo =
  (catalogue: Catalogue, from: Location, place: Place) =>
  (path: string): boolean =>
    Option.exists(soleTrail(trailsOf(catalogue, from, path)), (trail) =>
      samePlace(Array.lastNonEmpty(trail).place, place),
    )

const formNamesFor = (
  catalogue: Catalogue,
  place: Place,
  said: string,
): ReadonlyArray<ReadonlyArray<string>> =>
  place._tag !== 'Section'
    ? []
    : pipe(
        conceptAt(catalogue, place.ref),
        Option.filter((concept) =>
          conceptNames(concept).some((name) => foldFirst(name) === foldFirst(said)),
        ),
        Option.flatMap((concept) => chapterOf(catalogue, concept.module)),
        Option.match({
          onNone: (): ReadonlyArray<ReadonlyArray<string>> => [],
          onSome: (chapter) => throughBook(chapter, throughPart(chapter, [chapter.title, said])),
        }),
      )

export const pathsTo = (
  catalogue: Catalogue,
  from: Location,
  trails: ReadonlyArray<Trail>,
): ReadonlyArray<string> =>
  Array.getSomes(
    trails.map((trail) => {
      const last = Array.lastNonEmpty(trail)
      return Array.findFirst(
        [
          ...formNamesFor(catalogue, last.place, last.segment.text),
          ...namesFor(catalogue, last.place),
        ].map((names) => names.join(', ')),
        leadsTo(catalogue, from, last.place),
      )
    }),
  )

export const conceptPathOf = (
  catalogue: Catalogue,
  from: Location,
  concept: ConceptRef,
  form: string,
): Option.Option<string> =>
  Array.head(
    pathsTo(catalogue, from, [
      [
        {
          segment: whole(form),
          place: Place.Section({ ref: conceptSectionOf(concept) }),
          numbered: false,
          through: Option.none(),
        },
      ],
    ]),
  )

const anchorsOf = (section: LoomSection): ReadonlyArray<WarpAnchorToken> =>
  [...section.preamble, ...section.code].flatMap((weft) => weft.anchors)

const anchorsIn: (module: LoomModule) => ReadonlyArray<WarpAnchorToken> = memoize(
  (module: LoomModule) => module.doc.sections.flatMap(anchorsOf),
)

export type OpenedBox = {
  readonly box: BoxToken
  readonly opener: LoomWeft
  readonly body: ReadonlyArray<LoomWeft>
  readonly closer: Option.Option<LoomWeft>
}

export type BoxRef = OpenedBox & {
  readonly module: Location
  readonly name: BoxNameToken
  readonly kind: PointingKind
  readonly anchors: Option.Option<ParameterValueToken>
  readonly provides: ReadonlyArray<ParameterValueToken>
}

const linesOf = (doc: LoomDocument): ReadonlyArray<LoomWeft> => [
  ...doc.preamble,
  ...doc.sections.flatMap((section) => [...section.preamble, ...section.code]),
]

type BoxMark = { readonly box: BoxToken; readonly line: LoomWeft; readonly at: number }

const marksIn = (lines: ReadonlyArray<LoomWeft>): ReadonlyArray<BoxMark> =>
  Array.getSomes(
    lines.map((line, at) => Option.map(boxOf(line), (box): BoxMark => ({ box, line, at }))),
  )

const boxAfter =
  (lines: ReadonlyArray<LoomWeft>) =>
  (marks: ReadonlyArray<BoxMark>): Option.Option<readonly [OpenedBox, ReadonlyArray<BoxMark>]> =>
    Array.matchLeft(
      Array.dropWhile(marks, (mark) => mark.box.side !== 'open'),
      {
        onEmpty: () => Option.none(),
        onNonEmpty: (opener, later) => {
          const fromCloser = Array.dropWhile(later, (mark) => mark.box.side !== 'close')
          const closer = Array.head(fromCloser)
          const end = Option.match(closer, {
            onNone: () => lines.length,
            onSome: (mark) => mark.at,
          })
          return Option.some([
            {
              box: opener.box,
              opener: opener.line,
              body: lines.slice(opener.at + 1, end),
              closer: Option.map(closer, (mark) => mark.line),
            },
            Array.drop(fromCloser, 1),
          ] as const)
        },
      },
    )

const boxesAmong = (lines: ReadonlyArray<LoomWeft>): ReadonlyArray<OpenedBox> =>
  Array.unfold(marksIn(lines), boxAfter(lines))

export const openedBoxesOf: (doc: LoomDocument) => ReadonlyArray<OpenedBox> = memoize(
  (doc: LoomDocument) => boxesAmong(linesOf(doc)),
)

export const captionOf = (opened: OpenedBox): string =>
  Option.getOrElse(
    Option.map(Option.fromNullishOr(opened.box.name), (name) => name.value),
    () => boxKind(opened.box),
  )

const parameterValues = (box: BoxToken, key: string): ReadonlyArray<ParameterValueToken> =>
  pipe(
    Option.fromNullishOr(box.specifier),
    Option.flatMap((specifier) =>
      specifier.type === 'Parameters'
        ? Array.findFirst(specifier.parameters, (parameter) => parameter.key.value === key)
        : Option.none(),
    ),
    Option.map((parameter) => parameter.values),
    Option.getOrElse((): ReadonlyArray<ParameterValueToken> => []),
  )

const pointingBoxesOf: (module: LoomModule) => ReadonlyArray<BoxRef> = memoize((module: LoomModule) =>
  Array.getSomes(
    openedBoxesOf(module.doc).map((opened) => {
      const kind = boxKind(opened.box)
      return isPointingKind(kind)
        ? Option.map(Option.fromNullishOr(opened.box.name), (name): BoxRef => ({
            ...opened,
            module: module.path,
            name,
            kind,
            anchors: Array.head(parameterValues(opened.box, 'anchors')),
            provides: parameterValues(opened.box, 'provides'),
          }))
        : Option.none()
    }),
  ),
)

const boxesIn = (catalogue: Catalogue, module: Location): ReadonlyArray<BoxRef> =>
  Option.getOrElse(Option.fromNullishOr(catalogue.boxes.get(module)), () => [])

const boxTarget = (catalogue: Catalogue, ref: BoxRef): Option.Option<Chapter> => {
  const titled = filedUnder(catalogue.chaptersBy.title, ref.name.value).filter(
    (chapter) => chapter.kind === ref.kind,
  )
  return ref.kind === tropeKind
    ? Option.none()
    : Option.orElse(
        Option.flatMap(chapterOf(catalogue, ref.module), (own) =>
          Array.head(chaptersWithin(titled, own.book, Option.some(own.part))),
        ),
        () => Array.head(chaptersWithin(titled, bookAt(catalogue, ref.module), Option.none())),
      )
}

const tropePlaceOf = (catalogue: Catalogue, ref: BoxRef): Option.Option<Place> =>
  pipe(
    ref.anchors,
    Option.flatMap((value) => {
      const trails = trailsOf({ ...catalogue, boxes: new Map() }, ref.module, value.value)
      return trails.length === 1 ? Array.head(trails) : Option.none()
    }),
    Option.map((trail) => Array.lastNonEmpty(trail).place),
    Option.filter((place) => place._tag === 'Section' || place._tag === 'Chapter'),
  )

const boxNamed = (catalogue: Catalogue, module: Location, name: string): Option.Option<BoxRef> =>
  Array.findFirst(boxesIn(catalogue, module), (ref) => ref.name.value === name)

const boxPlace = (catalogue: Catalogue, ref: BoxRef): Place =>
  Option.getOrElse(
    ref.kind === tropeKind
      ? tropePlaceOf(catalogue, ref)
      : Option.map(boxTarget(catalogue, ref), (chapter) => Place.Chapter({ chapter })),
    () => Place.Box({ ref }),
  )

const throughOf = (ref: BoxRef): Option.Option<BoxRef> =>
  ref.kind === tropeKind ? Option.some(ref) : Option.none()

const boxTrail = (catalogue: Catalogue, from: Location, name: string): ReadonlyArray<Trail> =>
  Option.toArray(
    Option.map(boxNamed(catalogue, from, name), (ref): Trail => [
      {
        segment: whole(name),
        place: boxPlace(catalogue, ref),
        numbered: false,
        through: throughOf(ref),
      },
    ]),
  )

const boxLocation = (ref: BoxRef): CorpusLocation => ({
  path: ref.module,
  position: ref.name.position,
})

const namesBox =
  (target: BoxRef) =>
  (place: Place): boolean =>
    place._tag === 'Box' &&
    place.ref.module === target.module &&
    place.ref.name.position.start.offset === target.name.position.start.offset

const sameBox =
  (target: BoxRef) =>
  (other: BoxRef): boolean =>
    other.module === target.module &&
    other.name.position.start.offset === target.name.position.start.offset

export const promisedThrough = (
  catalogue: Catalogue,
  from: Location,
  name: string,
): ReadonlyArray<Provided> =>
  pipe(
    soleTrail(trailsOf(catalogue, from, name)),
    Option.map(Array.lastNonEmpty),
    Option.filter((step) => step.place._tag === 'Box'),
    Option.flatMap((step) => step.through),
    Option.map((ref) => providedOf(ref)),
    Option.getOrElse((): ReadonlyArray<Provided> => []),
  )

export type TropeContract = {
  readonly trope: string
  readonly entry: SectionRef
  readonly provides: ReadonlyArray<Provided>
}

export const tropeContractsIn = (
  catalogue: Catalogue,
  path: Location,
): ReadonlyArray<TropeContract> =>
  boxesIn(catalogue, path)
    .filter((ref) => ref.kind === tropeKind && Array.isReadonlyArrayNonEmpty(ref.provides))
    .flatMap((ref) =>
      Option.toArray(
        Option.map(
          Option.flatMap(tropePlaceOf(catalogue, ref), placeSectionOf),
          (entry): TropeContract => ({ trope: ref.name.value, entry, provides: providedOf(ref) }),
        ),
      ),
    )

const providedOf = (ref: BoxRef): ReadonlyArray<Provided> =>
  ref.provides.map((value): Provided => ({ name: value.value, at: value.position }))

const boxesPointingTo = (catalogue: Catalogue, chapter: Chapter): ReadonlyArray<BoxRef> =>
  Array.fromIterable(catalogue.boxes.values())
    .flat()
    .filter((ref) =>
      Option.exists(
        boxTarget(catalogue, ref),
        (found) => found.module.path === chapter.module.path,
      ),
    )

const boxesNaming = (catalogue: Catalogue, chapter: Chapter): ReadonlyArray<CorpusLocation> => [
  ...boxesPointingTo(catalogue, chapter).map(boxLocation),
  ...referencesNaming(
    catalogue,
    (step) => !step.numbered && Option.isNone(step.through) && namesChapter(chapter)(step.place),
  ),
]

export type HeldReference = {
  readonly on: 'heading' | 'anchor' | 'box'
  readonly key: string
  readonly value: ParameterValueToken
  readonly section: Option.Option<LoomSection>
}

type Braces = SpecifierToken | ParametersToken

const referringIn =
  (on: HeldReference['on'], section: Option.Option<LoomSection>) =>
  (braces: Braces | undefined): ReadonlyArray<HeldReference> =>
    parametersIn(braces)
      .filter((parameter) => parameter.refers === true)
      .flatMap((parameter) =>
        parameter.values.map((value): HeldReference => ({
          on,
          key: parameter.key.value,
          value,
          section,
        })),
      )

const referencesAmong = (
  section: Option.Option<LoomSection>,
  lines: ReadonlyArray<PreambleWeft | SectionBodyWeft>,
): ReadonlyArray<HeldReference> =>
  lines.flatMap((line) => [
    ...line.anchors.flatMap((anchor) => referringIn('anchor', section)(anchor.specifier)),
    ...Option.match(boxOf(line), {
      onNone: (): ReadonlyArray<HeldReference> => [],
      onSome: (box) => referringIn('box', section)(box.specifier),
    }),
  ])

export const referencesOf: (module: LoomModule) => ReadonlyArray<HeldReference> = memoize(
  (module: LoomModule) => [
    ...referencesAmong(Option.none(), module.doc.preamble),
    ...module.doc.sections.flatMap((section) => [
      ...referringIn('heading', Option.some(section))(section.heading.specifier),
      ...referencesAmong(Option.some(section), [...section.preamble, ...section.code]),
    ]),
  ],
)

export const isTropeEntry = (held: HeldReference): boolean =>
  held.on === 'box' && held.key === 'anchors'

export const referenceTrails = (
  catalogue: Catalogue,
  from: Location,
  held: HeldReference,
): ReadonlyArray<Trail> =>
  trailsOf(isTropeEntry(held) ? { ...catalogue, boxes: new Map() } : catalogue, from, held.value.value)

export const resolveReference = (
  catalogue: Catalogue,
  from: Location,
  held: HeldReference,
): Option.Option<SectionRef> =>
  Option.flatMap(soleTrail(referenceTrails(catalogue, from, held)), sectionOf)

const valueSpan = (
  path: Location,
  value: ParameterValueToken,
  segment: Segment,
): Option.Option<CorpusLocation> => {
  const words = valueWords(value)
  return textWithin(value) === value.value
    ? Option.some({
        path,
        position: {
          start: shifted(words.start, segment.start),
          end: shifted(words.start, segment.end),
        },
      })
    : Option.none()
}

const textWithin = (value: ParameterValueToken): string => {
  const words = valueWords(value)
  return value.source.slice(
    words.start.offset - value.position.start.offset,
    value.source.length - (value.position.end.offset - words.end.offset),
  )
}

const referencesNaming = (
  catalogue: Catalogue,
  names: (step: Step) => boolean,
): ReadonlyArray<CorpusLocation> =>
  Array.fromIterable(catalogue.modules.values()).flatMap((module) =>
    referencesOf(module).flatMap((held) =>
      Option.match(soleTrail(referenceTrails(catalogue, module.path, held)), {
        onNone: (): ReadonlyArray<Step> => [],
        onSome: (trail) => trail,
      })
        .filter(names)
        .flatMap((step) => Option.toArray(valueSpan(module.path, held.value, step.segment))),
    ),
  )

export type ConceptForm = { readonly value: string; readonly position: Position }

export type ConceptRef = {
  readonly module: Location
  readonly section: LoomSection
  readonly name: { readonly source: string; readonly position: Position }
  readonly forms: ReadonlyArray<ConceptForm>
  readonly definition: string
}

export const isConceptSection = (section: LoomSection): boolean => section.kind === conceptKind

const isFormsLine = (line: LoomWeft): boolean => /^Lexical forms:\s*$/.test(line.source.trim())

const formItem = /^[-*]\s+(\S.*?)\s*$/

const formsLineOf = (section: LoomSection): Option.Option<PreambleWeft> =>
  Array.findFirst(section.preamble, isFormsLine)

export const definitionLinesOf = (section: LoomSection): ReadonlyArray<PreambleWeft> =>
  pipe(
    outsideBoxes(section.preamble),
    Array.dropWhile((line) => line.source.trim() === ''),
    Array.takeWhile((line) => line.source.trim() !== '' && !isFormsLine(line)),
  )

const plainSource = (line: PreambleWeft): string =>
  pipe(
    line.anchors,
    Array.sort(
      Order.mapInput(Order.Number, (anchor: WarpAnchorToken) => -anchor.position.start.offset),
    ),
    Array.reduce(line.source, (text, anchor) => {
      const from = anchor.position.start.offset - line.position.start.offset
      const to = anchor.position.end.offset - line.position.start.offset
      return text.slice(0, from) + anchor.name.value + text.slice(to)
    }),
  )

const definitionOf = (section: LoomSection): string =>
  tidy(definitionLinesOf(section).map(plainSource).join(''))

const formOf = (line: LoomWeft): Option.Option<ConceptForm> =>
  Option.map(Option.fromNullishOr(formItem.exec(line.source.trim())?.[1]), (value) => {
    const start = line.position.start.offset + line.source.indexOf(value)
    return {
      value,
      position: {
        start: { line: line.position.start.line, offset: start },
        end: { line: line.position.start.line, offset: start + value.length },
      },
    }
  })

const formItemsOf = (section: LoomSection): ReadonlyArray<PreambleWeft> =>
  pipe(
    Array.findFirstIndex(section.preamble, isFormsLine),
    Option.map((at) =>
      Array.takeWhile(Array.drop(section.preamble, at + 1), (line) =>
        formItem.test(line.source.trim()),
      ),
    ),
    Option.getOrElse((): ReadonlyArray<PreambleWeft> => []),
  )

const formsOf = (section: LoomSection): ReadonlyArray<ConceptForm> =>
  Array.getSomes(formItemsOf(section).map(formOf))

export const formLinesOf = (section: LoomSection): ReadonlyArray<PreambleWeft> => [
  ...Option.toArray(formsLineOf(section)),
  ...formItemsOf(section),
]

const conceptsOf: (module: LoomModule) => ReadonlyArray<ConceptRef> = memoize((module: LoomModule) =>
  Array.getSomes(
    module.doc.sections.map((section) =>
      isConceptSection(section)
        ? Option.map(Option.fromNullishOr(section.heading.title), (title): ConceptRef => ({
            module: module.path,
            section,
            name: title,
            forms: formsOf(section),
            definition: definitionOf(section),
          }))
        : Option.none(),
    ),
  ),
)

const isProseLine = (weft: LoomWeft): weft is PreambleWeft | TildeWeft | ProseWeft =>
  weft.type === 'PreambleWeft' || weft.type === 'TildeWeft' || weft.type === 'ProseWeft'

const proseAnchorsOf = (wefts: ReadonlyArray<LoomWeft>): ReadonlyArray<WarpAnchorToken> =>
  wefts.flatMap((weft) => (isProseLine(weft) ? weft.anchors : []))

export const sectionLinksOf = (section: LoomSection): ReadonlyArray<WarpAnchorToken> =>
  proseAnchorsOf([...section.preamble, ...section.code])

export const linksOf: (module: LoomModule) => ReadonlyArray<WarpAnchorToken> = memoize(
  (module: LoomModule) => [
    ...proseAnchorsOf(module.doc.preamble),
    ...module.doc.sections.flatMap(sectionLinksOf),
  ],
)

const linkKey = (path: Location, anchor: WarpAnchorToken): string =>
  `${path}#${anchor.name.position.start.offset}`

export const conceptNames = (concept: ConceptRef): ReadonlyArray<string> => [
  concept.name.source,
  ...concept.forms.map((form) => form.value),
]

export const foldFirst = (name: string): string => name.charAt(0).toLowerCase() + name.slice(1)

export const conceptsCalled = (catalogue: Catalogue, name: string): ReadonlyArray<ConceptRef> =>
  catalogue.concepts.filter((concept) =>
    conceptNames(concept).some((form) => foldFirst(form) === foldFirst(name)),
  )

export const conceptSectionOf = (concept: ConceptRef): SectionRef => ({
  module: concept.module,
  section: concept.section,
})

const conceptNamedIn = (
  catalogue: Catalogue,
  module: Location,
  name: string,
): Option.Option<ConceptRef> =>
  Array.findFirst(conceptsCalled(catalogue, name), (concept) => concept.module === module)

const conceptTrails = (catalogue: Catalogue, name: string): ReadonlyArray<Trail> =>
  conceptsCalled(catalogue, name).map((concept): Trail => [
    {
      segment: whole(name),
      place: Place.Section({ ref: conceptSectionOf(concept) }),
      numbered: false,
      through: Option.none(),
    },
  ])

const linkTrailsOf = (catalogue: Catalogue, from: Location, name: string): ReadonlyArray<Trail> =>
  nearest([() => conceptTrails(catalogue, name), () => trailsOf(catalogue, from, name)])

export const conceptAt = (catalogue: Catalogue, ref: SectionRef): Option.Option<ConceptRef> =>
  Array.findFirst(
    catalogue.concepts,
    (concept) => concept.module === ref.module && concept.section === ref.section,
  )

type Seen = ReadonlyArray<ReadonlySet<Location>>

const seenIn = (seen: Seen, module: Location): boolean => seen.some((set) => set.has(module))

const withLevel = (seen: Seen, level: ReadonlySet<Location>): Seen =>
  Option.match(
    Option.filter(Array.last(seen), (before) => before.size <= level.size),
    {
      onNone: () => [...seen, level],
      onSome: (before) => withLevel(Array.dropRight(seen, 1), new Set([...before, ...level])),
    },
  )

export const reach = (
  seeds: ReadonlyArray<Location>,
  step: (module: Location) => ReadonlyArray<Location>,
): ReadonlySet<Location> => {
  const grow = (seen: Seen, level: ReadonlySet<Location>): Seen => {
    if (level.size === 0) return seen
    const reached = withLevel(seen, level)
    return grow(
      reached,
      new Set(
        Array.fromIterable(level)
          .flatMap(step)
          .filter((module) => !seenIn(reached, module)),
      ),
    )
  }
  return new Set(grow([], new Set(seeds)).flatMap((set) => Array.fromIterable(set)))
}

const placeModuleOf: (place: Place) => Option.Option<Location> = Match.type<Place>().pipe(
  Match.tag('Section', ({ ref }) => Option.some(ref.module)),
  Match.tag('Chapter', ({ chapter }) => Option.some(chapter.module.path)),
  Match.tag('Book', () => Option.none<Location>()),
  Match.tag('Part', () => Option.none<Location>()),
  Match.tag('Box', () => Option.none<Location>()),
  Match.exhaustive,
)

const moduleOf = (trail: Trail): Option.Option<Location> =>
  placeModuleOf(Array.lastNonEmpty(trail).place)

export type Reach = { readonly target: Location; readonly at: Position }

const boxReachAt = (ref: BoxRef): Position =>
  Option.getOrElse(
    Option.map(ref.anchors, (value) => value.position),
    () => ref.name.position,
  )

export const reachesOf = (catalogue: Catalogue, module: LoomModule): ReadonlyArray<Reach> => [
  ...anchorsIn(module).flatMap((anchor) =>
    Array.getSomes(
      anchorTrails(catalogue, module.path, anchor).map((trail) =>
        Option.map(moduleOf(trail), (target): Reach => ({ target, at: anchor.name.position })),
      ),
    ),
  ),
  ...Array.getSomes(
    boxesIn(catalogue, module.path).map((ref) =>
      Option.map(placeModuleOf(boxPlace(catalogue, ref)), (target): Reach => ({
        target,
        at: boxReachAt(ref),
      })),
    ),
  ),
  ...referencesOf(module)
    .filter((held) => !isTropeEntry(held))
    .flatMap((held) =>
      Array.getSomes(
        referenceTrails(catalogue, module.path, held).map((trail) =>
          Option.map(moduleOf(trail), (target): Reach => ({ target, at: held.value.position })),
        ),
      ),
    ),
]

type Edge = { readonly owner: Location; readonly target: Location }

type EdgesAt = Record<Location, ReadonlyArray<Edge>>

const anchorEdges: (modules: Modules) => ReadonlyArray<Edge> = memoize((modules: Modules) => {
  const catalogue = catalogueOf(modules)
  return Array.fromIterable(modules.values()).flatMap((m) =>
    reachesOf(catalogue, m).map(({ target }): Edge => ({ owner: m.path, target })),
  )
})

const edgesOut: (modules: Modules) => EdgesAt = memoize((modules: Modules) =>
  Array.groupBy(anchorEdges(modules), (edge) => edge.owner),
)

const edgesIn: (modules: Modules) => EdgesAt = memoize((modules: Modules) =>
  Array.groupBy(anchorEdges(modules), (edge) => edge.target),
)

const edgesAt = (edges: EdgesAt, module: Location): ReadonlyArray<Edge> =>
  Option.getOrElse(Option.fromNullishOr(edges[module]), (): ReadonlyArray<Edge> => [])

export const reachable = (modules: Modules, entry: Location): ReadonlyArray<Location> => {
  const out = edgesOut(modules)
  return Array.fromIterable(
    reach([entry], (module) => edgesAt(out, module).map((edge) => edge.target)),
  )
}

export const dependentsOf = (
  modules: Modules,
  entries: ReadonlyArray<Location>,
): ReadonlyArray<Location> => {
  const into = edgesIn(modules)
  const seeds = new Set(entries)
  return Array.fromIterable(
    reach(entries, (module) => edgesAt(into, module).map((edge) => edge.owner)),
  ).filter((path) => !seeds.has(path))
}

export const transitiveDependents = (modules: Modules, entry: Location): ReadonlyArray<Location> =>
  dependentsOf(modules, [entry])

export type CorpusLocation = { readonly path: Location; readonly position: Position }

const anchorAt = (modules: Modules, path: Location, offset: number): Option.Option<WarpAnchorToken> =>
  pipe(
    Option.fromNullishOr(modules.get(path)),
    Option.flatMap((m) =>
      Array.findFirst(
        anchorsIn(m),
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
  catalogue: Catalogue,
  modules: Modules,
  path: Location,
  offset: number,
): Option.Option<Step> =>
  Option.flatMap(anchorAt(modules, path, offset), (anchor) =>
    Option.map(soleTrail(anchorTrails(catalogue, path, anchor)), (trail) =>
      stepAt(trail, anchor, offset),
    ),
  )

const referenceAt = (module: LoomModule, offset: number): Option.Option<HeldReference> =>
  Array.findFirst(referencesOf(module), (held) => covers(held.value.position, offset))

const referenceStepAt = (
  catalogue: Catalogue,
  modules: Modules,
  path: Location,
  offset: number,
): Option.Option<Step> =>
  pipe(
    Option.fromNullishOr(modules.get(path)),
    Option.flatMap((module) => referenceAt(module, offset)),
    Option.flatMap((held) =>
      Option.map(soleTrail(referenceTrails(catalogue, path, held)), (trail) =>
        Option.getOrElse(
          Array.findFirst(trail, (step) =>
            Option.exists(valueSpan(path, held.value, step.segment), (at) =>
              covers(at.position, offset),
            ),
          ),
          () => Array.lastNonEmpty(trail),
        ),
      ),
    ),
  )

const nameStepAt = (
  catalogue: Catalogue,
  modules: Modules,
  path: Location,
  offset: number,
): Option.Option<Step> =>
  Option.orElse(anchorStepAt(catalogue, modules, path, offset), () =>
    referenceStepAt(catalogue, modules, path, offset),
  )

type Mention = { readonly place: Place; readonly numbered: boolean }

const mentionAt = (
  catalogue: Catalogue,
  modules: Modules,
  path: Location,
  offset: number,
): Option.Option<Mention> =>
  Option.orElse(
    Option.map(sectionRefAt(modules, path, offset), (ref): Mention => ({
      place: Place.Section({ ref }),
      numbered: false,
    })),
    () => nameStepAt(catalogue, modules, path, offset),
  )

const stepsOf = (
  catalogue: Catalogue,
  from: Location,
  anchor: WarpAnchorToken,
): ReadonlyArray<Step> =>
  Option.match(soleTrail(anchorTrails(catalogue, from, anchor)), {
    onNone: (): ReadonlyArray<Step> => [],
    onSome: (trail) => trail,
  })

const anchorsNaming = (
  catalogue: Catalogue,
  modules: Modules,
  names: (step: Step) => boolean,
  spanOf: SpanOf,
): ReadonlyArray<CorpusLocation> =>
  Array.fromIterable(modules.values()).flatMap((m) =>
    anchorsIn(m).flatMap((anchor) =>
      stepsOf(catalogue, m.path, anchor)
        .filter(names)
        .map((step): CorpusLocation => ({
          path: m.path,
          position: spanOf(anchor, step.segment),
        })),
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
  Option.flatMap(
    nameStepAt(catalogueOf(corpus.modules), corpus.modules, path, offset),
    ({ place }) => placeLocation(corpus.modules, place),
  )

const placeLocation = Match.fn((_modules: Modules, place: Place) => place).pipe(
  Match.withReturnType<Option.Option<CorpusLocation>>(),
  Match.tag('Section', ({ ref }) => titleLocation(ref)),
  Match.tag('Chapter', ({ chapter }) => chapterLocation(chapter)),
  Match.tag('Box', ({ ref }) => Option.some(boxLocation(ref))),
  Match.tag('Book', ({ book }, modules) => bookLoomLocation(modules, book)),
  Match.tag('Part', () => Option.none<CorpusLocation>()),
  Match.exhaustive,
)

const chapterTitledBy = (catalogue: Catalogue, ref: SectionRef): Option.Option<Chapter> =>
  Option.filter(
    chapterOf(catalogue, ref.module),
    (chapter) =>
      chapter.module.doc.frontmatter?.title === undefined &&
      Option.exists(openingSectionOf(chapter.module), (opening) => opening === ref.section),
  )

const sectionNames = (
  catalogue: Catalogue,
  modules: Modules,
  ref: SectionRef,
  spanOf: SpanOf,
): ReadonlyArray<CorpusLocation> => [
  ...Option.toArray(titleLocation(ref)),
  ...anchorsNaming(
    catalogue,
    modules,
    (step) => Option.isNone(step.through) && namesSection(ref)(step.place),
    spanOf,
  ),
  ...referencesNaming(
    catalogue,
    (step) => Option.isNone(step.through) && namesSection(ref)(step.place),
  ),
  ...Option.match(chapterTitledBy(catalogue, ref), {
    onNone: (): ReadonlyArray<CorpusLocation> => [],
    onSome: (chapter) => [
      ...boxesNaming(catalogue, chapter),
      ...tropeEntriesNaming(catalogue, modules, chapter),
      ...rootedInNaming(catalogue, modules, chapter),
      ...anchorsNaming(
        catalogue,
        modules,
        (step) =>
          !step.numbered && Option.isNone(step.through) && namesChapter(chapter)(step.place),
        spanOf,
      ),
    ],
  }),
]

const placeNames = Match.fn(
  (_catalogue: Catalogue, _modules: Modules, mention: Mention, _spanOf: SpanOf) => mention.place,
).pipe(
  Match.withReturnType<ReadonlyArray<CorpusLocation>>(),
  Match.tag('Section', ({ ref }, catalogue, modules, _mention, spanOf) =>
    sectionNames(catalogue, modules, ref, spanOf),
  ),
  Match.tag('Chapter', ({ chapter }, catalogue, modules, mention, spanOf) =>
    mention.numbered
      ? chapterNumbers(catalogue, modules, chapter, spanOf)
      : chapterNames(catalogue, modules, chapter, spanOf),
    ),
  Match.tag('Box', ({ ref }, catalogue, modules, _mention, spanOf) => [
    boxLocation(ref),
    ...anchorsNaming(catalogue, modules, (step) => namesBox(ref)(step.place), spanOf),
  ]),
  Match.tag('Book', ({ book }, catalogue, modules, _mention, spanOf) =>
    bookNames(catalogue, modules, book, spanOf),
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
  const catalogue = catalogueOf(corpus.modules)
  return Option.match(mentionAt(catalogue, corpus.modules, path, offset), {
    onNone: (): ReadonlyArray<CorpusLocation> => [],
    onSome: (mention) => placeNames(catalogue, corpus.modules, mention, spanOf),
  })
}

const covers = (position: Position, offset: number): boolean =>
  position.start.offset <= offset && offset <= position.end.offset

const valueWarpsIn = (
  preamble: ReadonlyArray<{ readonly warps: ReadonlyArray<WarpToken> }>,
): ReadonlyArray<WarpToken> =>
  preamble.flatMap((weft) => weft.warps).filter((warp) => warp.name.value !== 'lang')

const allValueWarpsOf = (doc: LoomDocument): ReadonlyArray<WarpToken> => [
  ...valueWarpsIn(doc.preamble),
  ...doc.sections.flatMap((section) => valueWarpsIn(section.preamble)),
]

const allAnchorsOf = (doc: LoomDocument): ReadonlyArray<WarpAnchorToken> => [
  ...doc.preamble.flatMap((weft) => weft.anchors),
  ...doc.sections.flatMap(anchorsOf),
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
        anchors: allAnchorsOf(module.doc).filter(
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
      ...binding.anchors.map((anchor): CorpusLocation => ({
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

const chapterAt = (
  catalogue: Catalogue,
  modules: Modules,
  path: Location,
  offset: number,
): Option.Option<Chapter> =>
  Option.flatMap(Option.fromNullishOr(modules.get(path)), (module) =>
    pipe(
      Option.flatMap(
        Array.findFirst(boxesIn(catalogue, path), (ref) => covers(ref.name.position, offset)),
        (ref) => boxTarget(catalogue, ref),
      ),
      Option.orElse(() =>
        Option.flatMap(
          Array.findFirst(tropeEntriesOf(module), (name) => covers(name.position, offset)),
          (name) => tropeEntryChapterOf(catalogue, path, name.value),
        ),
      ),
      Option.orElse(() =>
        pipe(
          Option.fromNullishOr(module.doc.frontmatter?.rootedIn),
          Option.filter((line) => covers(line.position, offset)),
          Option.flatMap((line) => tropeChapterOf(catalogue, line.value)),
        ),
      ),
      Option.orElse(() =>
        pipe(
          Option.fromNullishOr(module.doc.frontmatter?.title),
          Option.filter((title) => covers(title.position, offset)),
          Option.flatMap(() => chapterOf(catalogue, path)),
        ),
      ),
    ),
  )

const tropeEntriesOf = (module: LoomModule): ReadonlyArray<FrontmatterEntryToken> =>
  Option.getOrElse(Option.fromNullishOr(module.doc.frontmatter?.entries), () => [])

const tropeChapterOf = (catalogue: Catalogue, name: string): Option.Option<Chapter> => {
  const roots = catalogue.chapters.filter(
    (chapter) => chapter.module.doc.frontmatter?.trope?.value === name,
  )
  return roots.length === 1 ? Array.head(roots) : Option.none()
}

const chapterDefinitionAt = (
  corpus: LoomCorpusAst,
  path: Location,
  offset: number,
): Option.Option<CorpusLocation> =>
  Option.flatMap(
    chapterAt(catalogueOf(corpus.modules), corpus.modules, path, offset),
    chapterLocation,
  )

const tropeEntriesNaming = (
  catalogue: Catalogue,
  modules: Modules,
  chapter: Chapter,
): ReadonlyArray<CorpusLocation> =>
  Array.fromIterable(modules.values()).flatMap((module) =>
    tropeEntriesOf(module)
      .filter(
        (name) =>
          name.value === chapter.title &&
          Option.exists(
            tropeEntryChapterOf(catalogue, module.path, name.value),
            (found) => found.module.path === chapter.module.path,
          ),
      )
      .map((name): CorpusLocation => ({ path: module.path, position: name.position })),
  )

const rootedInNaming = (
  catalogue: Catalogue,
  modules: Modules,
  chapter: Chapter,
): ReadonlyArray<CorpusLocation> =>
  Array.fromIterable(modules.values()).flatMap((module) =>
    pipe(
      Option.fromNullishOr(module.doc.frontmatter?.rootedIn),
      Option.filter((line) =>
        Option.exists(
          tropeChapterOf(catalogue, line.value),
          (found) => found.module.path === chapter.module.path,
        ),
      ),
      Option.map((line): CorpusLocation => ({ path: module.path, position: line.position })),
      Option.toArray,
    ),
  )

const chapterNames = (
  catalogue: Catalogue,
  modules: Modules,
  chapter: Chapter,
  spanOf: SpanOf,
): ReadonlyArray<CorpusLocation> => [
  ...Option.toArray(chapterLocation(chapter)),
  ...boxesNaming(catalogue, chapter),
  ...tropeEntriesNaming(catalogue, modules, chapter),
  ...rootedInNaming(catalogue, modules, chapter),
  ...anchorsNaming(
    catalogue,
    modules,
    (step) => !step.numbered && Option.isNone(step.through) && namesChapter(chapter)(step.place),
    spanOf,
  ),
]

const tropeBoxAt = (catalogue: Catalogue, path: Location, offset: number): Option.Option<BoxRef> =>
  Array.findFirst(
    boxesIn(catalogue, path),
    (ref) => ref.kind === tropeKind && covers(ref.name.position, offset),
  )

const tropeNames = (
  catalogue: Catalogue,
  modules: Modules,
  ref: BoxRef,
  spanOf: SpanOf,
): ReadonlyArray<CorpusLocation> => [
  boxLocation(ref),
  ...anchorsNaming(catalogue, modules, (step) => Option.exists(step.through, sameBox(ref)), spanOf),
]

const boxDefinitionAt = (
  corpus: LoomCorpusAst,
  path: Location,
  offset: number,
): Option.Option<CorpusLocation> => {
  const catalogue = catalogueOf(corpus.modules)
  return Option.match(tropeBoxAt(catalogue, path, offset), {
    onSome: (ref) =>
      Option.flatMap(tropePlaceOf(catalogue, ref), (place) => placeLocation(corpus.modules, place)),
    onNone: () => chapterDefinitionAt(corpus, path, offset),
  })
}

const boxNamesAt = (
  corpus: LoomCorpusAst,
  path: Location,
  offset: number,
  spanOf: SpanOf,
): ReadonlyArray<CorpusLocation> => {
  const catalogue = catalogueOf(corpus.modules)
  return Option.match(tropeBoxAt(catalogue, path, offset), {
    onSome: (ref) => tropeNames(catalogue, corpus.modules, ref, spanOf),
    onNone: () => chapterNamesAt(corpus, path, offset, spanOf),
  })
}

const chapterNamesAt = (
  corpus: LoomCorpusAst,
  path: Location,
  offset: number,
  spanOf: SpanOf,
): ReadonlyArray<CorpusLocation> => {
  const catalogue = catalogueOf(corpus.modules)
  return Option.match(chapterAt(catalogue, corpus.modules, path, offset), {
    onNone: (): ReadonlyArray<CorpusLocation> => [],
    onSome: (chapter) => chapterNames(catalogue, corpus.modules, chapter, spanOf),
  })
}

const numberToken = (module: LoomModule): Option.Option<{ readonly position: Position }> =>
  Option.orElse(
    Option.fromNullishOr(module.doc.frontmatter?.chapter ?? module.doc.frontmatter?.discussion),
    () => claimedKind(module),
  )

const chapterNumbers = (
  catalogue: Catalogue,
  modules: Modules,
  chapter: Chapter,
  spanOf: SpanOf,
): ReadonlyArray<CorpusLocation> => [
  ...Option.toArray(
    Option.map(
      numberToken(chapter.module),
      (number): CorpusLocation => ({ path: chapter.module.path, position: number.position }),
    ),
  ),
  ...anchorsNaming(
    catalogue,
    modules,
    (step) => step.numbered && namesChapter(chapter)(step.place),
    spanOf,
  ),
  ...referencesNaming(catalogue, (step) => step.numbered && namesChapter(chapter)(step.place)),
]

const chapterNumbersAt = (
  corpus: LoomCorpusAst,
  path: Location,
  spanOf: SpanOf,
): ReadonlyArray<CorpusLocation> => {
  const catalogue = catalogueOf(corpus.modules)
  return Option.match(chapterOf(catalogue, path), {
    onNone: (): ReadonlyArray<CorpusLocation> => [],
    onSome: (chapter) => chapterNumbers(catalogue, corpus.modules, chapter, spanOf),
  })
}

const partOpenerIndex = (modules: Modules): ReadonlyMap<string, CorpusLocation> =>
  pipe(
    Array.fromIterable(modules.values()).map((module) =>
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
            [
              partKey(bookOf(module), part.value),
              { path: module.path, position: partName.position },
            ] as const,
        ),
      ),
    ),
    Array.getSomes,
    Array.reduce(new Map<string, CorpusLocation>(), (index, [key, location]) =>
      index.has(key) ? index : new Map(index).set(key, location),
    ),
  )

const onToken = (token: { readonly position: Position } | undefined, offset: number): boolean =>
  Option.match(Option.fromNullishOr(token), {
    onNone: () => false,
    onSome: (t) => covers(t.position, offset),
  })

const frontmatterPartKeyAt = (module: LoomModule, offset: number): Option.Option<string> =>
  pipe(
    Option.fromNullishOr(module.doc.frontmatter),
    Option.filter((fm) => onToken(fm.part, offset) || onToken(fm.partName, offset)),
    Option.flatMap((fm) => Option.fromNullishOr(fm.part)),
    Option.map((part) => partKey(bookOf(module), part.value)),
  )

const partKeyAt = (modules: Modules, path: Location, offset: number): Option.Option<string> =>
  pipe(
    Option.fromNullishOr(modules.get(path)),
    Option.flatMap((module) => frontmatterPartKeyAt(module, offset)),
  )

const partDefinitionAt = (
  corpus: LoomCorpusAst,
  path: Location,
  offset: number,
): Option.Option<CorpusLocation> =>
  Option.flatMap(partKeyAt(corpus.modules, path, offset), (key) =>
    Option.fromNullishOr(partOpenerIndex(corpus.modules).get(key)),
  )

const frontmatterPartLocations = (module: LoomModule, key: string): ReadonlyArray<CorpusLocation> =>
  pipe(
    Option.fromNullishOr(module.doc.frontmatter?.part),
    Option.filter((part) => partKey(bookOf(module), part.value) === key),
    Option.map((part) => ({ path: module.path, position: part.position })),
    Option.toArray,
  )

const partGroup = (modules: Modules, key: string): ReadonlyArray<CorpusLocation> => [
  ...Option.toArray(Option.fromNullishOr(partOpenerIndex(modules).get(key))),
  ...Array.fromIterable(modules.values()).flatMap((module) => [
    ...frontmatterPartLocations(module, key),
  ]),
]

const partGroupAt = (
  corpus: LoomCorpusAst,
  path: Location,
  offset: number,
): ReadonlyArray<CorpusLocation> =>
  Option.match(partKeyAt(corpus.modules, path, offset), {
    onNone: (): ReadonlyArray<CorpusLocation> => [],
    onSome: (key) => partGroup(corpus.modules, key),
  })

const bookLoomsOf = (modules: Modules, book: string): ReadonlyArray<LoomModule> =>
  Array.fromIterable(modules.values()).filter(
    (module) => isBookLoom(module) && Option.contains(bookOf(module), book),
  )

const bookLoomLocation = (modules: Modules, book: string): Option.Option<CorpusLocation> =>
  pipe(
    Array.head(bookLoomsOf(modules, book)),
    Option.flatMap((module) =>
      Option.map(Option.fromNullishOr(module.doc.frontmatter?.book), (line): CorpusLocation => ({
        path: module.path,
        position: line.position,
      })),
    ),
  )

const bookLines = (modules: Modules, book: string): ReadonlyArray<CorpusLocation> =>
  Array.fromIterable(modules.values()).flatMap((module) =>
    pipe(
      Option.fromNullishOr(module.doc.frontmatter?.book),
      Option.filter((line) => line.value === book),
      Option.map((line): CorpusLocation => ({ path: module.path, position: line.position })),
      Option.toArray,
    ),
  )

const bookNameAt = (module: LoomModule, offset: number): Option.Option<string> =>
  pipe(
    Option.fromNullishOr(module.doc.frontmatter?.book),
    Option.filter((line) => covers(line.position, offset)),
    Option.map((line) => line.value),
  )

const bookDefinitionAt = (
  corpus: LoomCorpusAst,
  path: Location,
  offset: number,
): Option.Option<CorpusLocation> =>
  pipe(
    Option.fromNullishOr(corpus.modules.get(path)),
    Option.flatMap((module) => bookNameAt(module, offset)),
    Option.flatMap((book) => bookLoomLocation(corpus.modules, book)),
  )

const namesBook =
  (book: string) =>
  (place: Place): boolean =>
    place._tag === 'Book' && place.book === book

const bookNames = (
  catalogue: Catalogue,
  modules: Modules,
  book: string,
  spanOf: SpanOf,
): ReadonlyArray<CorpusLocation> => [
  ...bookLines(modules, book),
  ...anchorsNaming(catalogue, modules, (step) => namesBook(book)(step.place), spanOf),
]

const bookNamesAt = (
  corpus: LoomCorpusAst,
  path: Location,
  offset: number,
  spanOf: SpanOf,
): ReadonlyArray<CorpusLocation> =>
  Option.match(
    Option.flatMap(Option.fromNullishOr(corpus.modules.get(path)), (module) =>
      bookNameAt(module, offset),
    ),
    {
      onNone: (): ReadonlyArray<CorpusLocation> => [],
      onSome: (book) => bookNames(catalogueOf(corpus.modules), corpus.modules, book, spanOf),
    },
  )

const definitionByKind = Match.fn(
  (
    _within: {
      readonly corpus: LoomCorpusAst
      readonly module: LoomModule
      readonly path: Location
      readonly offset: number
    },
    kind: SymbolKind,
  ) => kind,
).pipe(
  Match.withReturnType<Option.Option<CorpusLocation>>(),
  Match.when('warpAnchor', (_kind, { module, path, offset }) =>
    warpDefLocation(module, path, offset),
  ),
  Match.whenOr('sectionAnchor', 'referenceValue', (_kind, { corpus, path, offset }) =>
    sectionDefinitionAt(corpus, path, offset),
  ),
  Match.when('boxName', (_kind, { corpus, path, offset }) => boxDefinitionAt(corpus, path, offset)),
  Match.whenOr(
    'frontmatterTitle',
    'frontmatterEntry',
    'frontmatterRootedIn',
    (_kind, { corpus, path, offset }) => chapterDefinitionAt(corpus, path, offset),
  ),
  Match.whenOr('frontmatterPart', 'frontmatterPartName', (_kind, { corpus, path, offset }) =>
    partDefinitionAt(corpus, path, offset),
  ),
  Match.when('frontmatterBook', (_kind, { corpus, path, offset }) =>
    bookDefinitionAt(corpus, path, offset),
  ),
  Match.orElse(() => Option.none<CorpusLocation>()),
)

export const definitionAt = (
  corpus: LoomCorpusAst,
  path: Location,
  offset: number,
): Option.Option<CorpusLocation> =>
  pipe(
    Option.fromNullishOr(corpus.modules.get(path)),
    Option.flatMap((module) =>
      Option.flatMap(symbolAt(module.doc, offset), (symbol) =>
        definitionByKind({ corpus, module, path, offset }, symbol.kind),
      ),
    ),
  )

const referencesByKind = Match.fn(
  (
    _within: {
      readonly corpus: LoomCorpusAst
      readonly module: LoomModule
      readonly path: Location
      readonly offset: number
    },
    kind: SymbolKind,
  ) => kind,
).pipe(
  Match.withReturnType<ReadonlyArray<CorpusLocation>>(),
  Match.whenOr('warpAnchor', 'warpDef', (_kind, { module, path, offset }) =>
    warpReferences(module, path, offset, (anchor) => anchor.position),
  ),
  Match.whenOr(
    'headingTitle',
    'sectionAnchor',
    'referenceValue',
    (_kind, { corpus, path, offset }) => placeNamesAt(corpus, path, offset, wholeAnchor),
  ),
  Match.when('boxName', (_kind, { corpus, path, offset }) =>
    boxNamesAt(corpus, path, offset, wholeAnchor),
  ),
  Match.whenOr(
    'frontmatterTitle',
    'frontmatterEntry',
    'frontmatterRootedIn',
    (_kind, { corpus, path, offset }) => chapterNamesAt(corpus, path, offset, wholeAnchor),
  ),
  Match.when('frontmatterMembership', (_kind, { corpus, path }) =>
    chapterNumbersAt(corpus, path, wholeAnchor),
  ),
  Match.whenOr('frontmatterPart', 'frontmatterPartName', (_kind, { corpus, path, offset }) =>
    partGroupAt(corpus, path, offset),
  ),
  Match.when('frontmatterBook', (_kind, { corpus, path, offset }) =>
    bookNamesAt(corpus, path, offset, wholeAnchor),
  ),
  Match.orElse((): ReadonlyArray<CorpusLocation> => []),
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
        referencesByKind({ corpus, module, path, offset }, symbol.kind),
    },
  )

const renamedByKind = Match.fn(
  (
    _within: {
      readonly corpus: LoomCorpusAst
      readonly module: LoomModule
      readonly path: Location
      readonly offset: number
    },
    kind: SymbolKind,
  ) => kind,
).pipe(
  Match.withReturnType<ReadonlyArray<CorpusLocation>>(),
  Match.whenOr('warpAnchor', 'warpDef', (_kind, { module, path, offset }) =>
    warpReferences(module, path, offset, (anchor) => anchor.name.position),
  ),
  Match.whenOr(
    'headingTitle',
    'sectionAnchor',
    'referenceValue',
    (_kind, { corpus, path, offset }) =>
      Option.match(conceptRenameAt(corpus, path, offset), {
        onSome: (rename): ReadonlyArray<CorpusLocation> => [
          rename.heading,
          ...rename.chapter,
        ],
        onNone: () => placeNamesAt(corpus, path, offset, segmentPosition),
      }),
  ),
  Match.when('boxName', (_kind, { corpus, path, offset }) =>
    boxNamesAt(corpus, path, offset, segmentPosition),
  ),
  Match.whenOr(
    'frontmatterTitle',
    'frontmatterEntry',
    'frontmatterRootedIn',
    (_kind, { corpus, path, offset }) => chapterNamesAt(corpus, path, offset, segmentPosition),
  ),
  Match.when('frontmatterMembership', (_kind, { corpus, path }) =>
    chapterNumbersAt(corpus, path, segmentPosition),
  ),
  Match.when('frontmatterBook', (_kind, { corpus, path, offset }) =>
    bookNamesAt(corpus, path, offset, segmentPosition),
  ),
  Match.orElse((): ReadonlyArray<CorpusLocation> => []),
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
        renamedByKind({ corpus, module, path, offset }, symbol.kind),
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

export type CorpusHover = { readonly position: Position; readonly markdown: string }

export type ConceptRename = {
  readonly heading: CorpusLocation
  readonly kept: CorpusEdit
  readonly chapter: ReadonlyArray<CorpusLocation>
}

export const conceptMentionedAt = (
  catalogue: Catalogue,
  modules: Modules,
  path: Location,
  offset: number,
): Option.Option<ConceptRef> =>
  Option.flatMap(mentionAt(catalogue, modules, path, offset), (mention) =>
    mention.place._tag === 'Section' ? conceptAt(catalogue, mention.place.ref) : Option.none(),
  )

export const cardOf = (concept: ConceptRef): string =>
  [
    `**${concept.name.source}**`,
    ...(concept.definition === '' ? [] : [concept.definition]),
    ...(concept.forms.length === 0
      ? []
      : [`Also: ${concept.forms.map((form) => form.value).join(', ')}`]),
  ].join('\n\n')

export const hoverAt = (
  corpus: LoomCorpusAst,
  path: Location,
  offset: number,
): Option.Option<CorpusHover> =>
  Option.flatMap(
    conceptMentionedAt(catalogueOf(corpus.modules), corpus.modules, path, offset),
    (concept) =>
    Option.map(navigationRangeAt(corpus, path, offset), (range) => ({
      position: range.position,
      markdown: cardOf(concept),
    })),
  )

const pointSpan = (point: Point): Position => ({ start: point, end: point })

const keptNameOf = (concept: ConceptRef): CorpusEdit =>
  Option.match(formsLineOf(concept.section), {
    onSome: (line) => ({
      path: concept.module,
      at: pointSpan(contentEnd(line)),
      text: `\n- ${concept.name.source}`,
    }),
    onNone: () => ({
      path: concept.module,
      at: pointSpan(
        Option.getOrElse(
          Option.map(Array.last(definitionLinesOf(concept.section)), contentEnd),
          () => concept.section.heading.position.end,
        ),
      ),
      text: `\n\nLexical forms:\n- ${concept.name.source}`,
    }),
  })

export type CorpusSymbol = {
  readonly name: string
  readonly container: string
  readonly location: CorpusLocation
}

const matching =
  (query: string) =>
  (name: string): boolean =>
    name.toLowerCase().includes(query.toLowerCase())

export const conceptSymbolsIn = (
  corpus: LoomCorpusAst,
  query: string,
): ReadonlyArray<CorpusSymbol> => {
  const catalogue = catalogueOf(corpus.modules)
  return catalogue.concepts
    .filter((concept) => conceptNames(concept).some(matching(query)))
    .map((concept): CorpusSymbol => ({
      name: concept.name.source,
      container: Option.getOrElse(
        Option.map(chapterOf(catalogue, concept.module), (chapter) => chapter.title),
        () => concept.module,
      ),
      location: { path: concept.module, position: concept.name.position },
    }))
}

export const conceptRenameAt = (
  corpus: LoomCorpusAst,
  path: Location,
  offset: number,
): Option.Option<ConceptRename> => {
  const catalogue = catalogueOf(corpus.modules)
  return Option.map(conceptMentionedAt(catalogue, corpus.modules, path, offset), (concept) => ({
    heading: { path: concept.module, position: concept.name.position },
    kept: keptNameOf(concept),
    chapter: Option.match(
      chapterTitledBy(catalogue, { module: concept.module, section: concept.section }),
      {
        onNone: (): ReadonlyArray<CorpusLocation> => [],
        onSome: (chapter) =>
          chapterNames(catalogue, corpus.modules, chapter, segmentPosition).filter(
            (location) =>
              location.path !== concept.module ||
              location.position.start.offset !== concept.name.position.start.offset,
          ),
      },
    ),
  }))
}

export type CorpusHint = { readonly offset: number; readonly label: string }

const labelOf: (place: Place) => Option.Option<string> = Match.type<Place>().pipe(
  Match.tag('Chapter', ({ chapter }) => Option.some(chapter.title)),
  Match.tag('Part', ({ part }) => part.name),
  Match.tag('Book', () => Option.none<string>()),
  Match.tag('Section', () => Option.none<string>()),
  Match.tag('Box', () => Option.none<string>()),
  Match.exhaustive,
)

export const hintsAt = (corpus: LoomCorpusAst, path: Location): ReadonlyArray<CorpusHint> => {
  const catalogue = catalogueOf(corpus.modules)
  return Option.match(Option.fromNullishOr(corpus.modules.get(path)), {
    onNone: (): ReadonlyArray<CorpusHint> => [],
    onSome: (module) =>
      anchorsIn(module).flatMap((anchor) =>
        Array.getSomes(
          stepsOf(catalogue, path, anchor)
            .filter((step) => step.numbered)
            .map((step) =>
              Option.map(labelOf(step.place), (label) => ({
                offset: segmentPosition(anchor, step.segment).end.offset,
                label,
              })),
            ),
        ),
      ),
  })
}

const bearersAmong = (
  lines: ReadonlyArray<PreambleWeft | SectionBodyWeft>,
): ReadonlyArray<Bearer> =>
  lines.flatMap((line) => [
    ...line.anchors.map((anchor): Bearer => ({ on: 'anchor', anchor, standing: standingOf(line) })),
    ...Option.toArray(boxOf(line)).map((box): Bearer => ({ on: 'box', box })),
  ])

const bearersOf: (doc: LoomDocument) => ReadonlyArray<Bearer> = memoize((doc: LoomDocument) => [
  ...bearersAmong(doc.preamble),
  ...doc.sections.flatMap((section): ReadonlyArray<Bearer> => [
    { on: 'heading', section },
    ...bearersAmong([...section.preamble, ...section.code]),
  ]),
])

const bracesOf = Match.type<Bearer>().pipe(
  Match.withReturnType<Braces | undefined>(),
  Match.when({ on: 'heading' }, ({ section }) => section.heading.specifier),
  Match.when({ on: 'anchor' }, ({ anchor }) => anchor.specifier),
  Match.when({ on: 'box' }, ({ box }) => box.specifier),
  Match.exhaustive,
)

const bearsOpened = Match.type<Bearer>().pipe(
  Match.withReturnType<(brace: number) => boolean>(),
  Match.when({ on: 'heading' }, () => () => false),
  Match.when(
    { on: 'anchor' },
    ({ anchor }) =>
      (brace) =>
        anchor.position.end.offset === brace,
  ),
  Match.when(
    { on: 'box' },
    ({ box }) =>
      (brace) =>
        box.side === 'open' && covers(box.position, brace),
  ),
  Match.exhaustive,
)

const bears =
  (brace: number) =>
  (bearer: Bearer): boolean =>
    Option.match(Option.fromNullishOr(bracesOf(bearer)), {
      onSome: (braces) => braces.open.position.start.offset === brace,
      onNone: () => bearsOpened(bearer)(brace),
    })

export const bearerAt = (
  corpus: LoomCorpusAst,
  path: Location,
  brace: number,
): Option.Option<Bearer> =>
  Option.flatMap(Option.fromNullishOr(corpus.modules.get(path)), (module) =>
    Array.findFirst(bearersOf(module.doc), bears(brace)),
  )

export type KeyUnder = { readonly bearer: Bearer; readonly key: ParameterKeyToken }

const parametersIn = (braces: Braces | undefined): ReadonlyArray<ParameterToken> =>
  pipe(
    Option.fromNullishOr(braces),
    Option.flatMap((held) =>
      held.type === 'Parameters' ? Option.some(held.parameters) : Option.none(),
    ),
    Option.getOrElse((): ReadonlyArray<ParameterToken> => []),
  )

const keyUnder =
  (offset: number) =>
  (bearer: Bearer): Option.Option<KeyUnder> =>
    pipe(
      Array.findFirst(
        parametersIn(bracesOf(bearer)),
        (parameter) => parameter.key.source !== '' && covers(parameter.key.position, offset),
      ),
      Option.map((parameter) => ({ bearer, key: parameter.key })),
    )

export const keyAt = (
  corpus: LoomCorpusAst,
  path: Location,
  offset: number,
): Option.Option<KeyUnder> =>
  Option.flatMap(Option.fromNullishOr(corpus.modules.get(path)), (module) =>
    Array.findFirst(bearersOf(module.doc), keyUnder(offset)),
  )

const tidy = (text: string): string =>
  text
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

const textOf = (lines: ReadonlyArray<LoomWeft>): string =>
  tidy(lines.map((line) => line.source).join(''))

const stillInBox = Match.fn((_inBox: boolean, box: BoxToken) => box.side).pipe(
  Match.withReturnType<boolean>(),
  Match.when('open', () => true),
  Match.when('close', () => false),
  Match.when('stray', (_side, inBox) => inBox),
  Match.exhaustive,
)

const outsideBoxes = <Line extends LoomWeft>(lines: ReadonlyArray<Line>): ReadonlyArray<Line> =>
  Array.getSomes(
    Array.mapAccum(lines, false, (inBox, line): readonly [boolean, Option.Option<Line>] =>
      Option.match(boxOf(line), {
        onNone: () => [inBox, inBox ? Option.none() : Option.some(line)],
        onSome: (box) => [stillInBox(inBox, box), Option.none()],
      }),
    )[1],
  )

const openingLinesOf = (section: LoomSection): ReadonlyArray<LoomWeft> =>
  Array.takeWhile([...section.preamble, ...section.code], (line) => line.type !== 'ArrowWeft')

const openingProseOf = (module: LoomModule): string =>
  Option.match(openingSectionOf(module), {
    onNone: () => '',
    onSome: (section) => textOf(outsideBoxes(openingLinesOf(section))),
  })

const isDiscussion = (module: LoomModule): boolean =>
  module.doc.frontmatter?.discussion !== undefined

const discussionOpeningOf = (module: LoomModule): string =>
  Option.match(openingSectionOf(module), {
    onNone: () => '',
    onSome: (section) =>
      textOf(
        outsideBoxes(
          Array.takeWhile(
            [...section.preamble, ...section.code],
            (line) => line.type !== 'TildeWeft',
          ),
        ),
      ),
  })

const topicsOf = (module: LoomModule): ReadonlyArray<LoomSection> =>
  module.doc.sections.filter((section) => section.heading.marker.type === 'Divider')

const conclusionOf = (topic: LoomSection): Option.Option<string> =>
  pipe(
    boxesAmong([...topic.preamble, ...topic.code]),
    Array.findFirst((opened) => boxKind(opened.box) === conclusionKind),
    Option.map((opened) => textOf(opened.body)),
  )

const discussionSummaryOf = (module: LoomModule): string =>
  [discussionOpeningOf(module), ...Array.getSomes(topicsOf(module).map(conclusionOf))]
    .filter((paragraph) => paragraph !== '')
    .join('\n\n')

const summaryOf = (module: LoomModule): string =>
  isDiscussion(module) ? discussionSummaryOf(module) : openingProseOf(module)

export type Opening = { readonly file: string; readonly text: string }

const noPartIn = (book: Option.Option<string>): PartRef => ({
  book,
  number: Option.none(),
  name: Option.none(),
})

const slugOf = (title: string): string =>
  title
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

const folderOf = (path: Location): string => path.slice(0, path.lastIndexOf('/') + 1)

const discussionsFolderOf = (path: Location): string => {
  const folder = folderOf(path)
  return folder.endsWith('/discussions/') ? folder : `${folder}discussions/`
}

const numberOf = (chapter: Chapter): number =>
  Option.getOrElse(
    Option.map(chapter.number, (written) => Number.parseInt(written, 10) || 0),
    () => 0,
  )

const nextNumber = (catalogue: Catalogue, part: PartRef, kind: LoomKind): Option.Option<number> =>
  Option.map(
    part.number,
    () =>
      1 +
      Math.max(
        0,
        ...chaptersWithin(
          catalogue.chapters.filter((chapter) => chapter.kind === kind),
          part.book,
          Option.some(part),
        ).map(numberOf),
      ),
  )

const membership = (
  part: PartRef,
  number: Option.Option<number>,
  title: string,
  kind: LoomKind,
): ReadonlyArray<string> =>
  Option.match(Option.all([part.number, number]), {
    onSome: ([numeral, next]) => [`Part ${numeral}, ${kind} ${next}: ${title}`],
    onNone: () => [
      ...Option.toArray(Option.map(part.name, (name) => `Part: ${name}`)),
      `${kind}: ${title}`,
    ],
  })

const fileOf = Match.fn(
  (_ref: BoxRef, kind: LoomKind, _number: Option.Option<number>) => kind,
).pipe(
  Match.withReturnType<string>(),
  Match.when(chapterKind, (_matched, ref, _kind, number) => {
    const numbered = Option.match(number, {
      onNone: () => '',
      onSome: (next) => `${String(next).padStart(2, '0')}-`,
    })
    return `${folderOf(ref.module)}${numbered}${slugOf(ref.name.value)}.loom`
  }),
  Match.when(
    discussionKind,
    (_kind, ref) => `${discussionsFolderOf(ref.module)}${slugOf(ref.name.value)}.loom`,
  ),
  Match.exhaustive,
)

const kindFields = Match.fn(
  (
    _within: {
      readonly own: Option.Option<Chapter>
    },
    kind: LoomKind,
  ) => kind,
).pipe(
  Match.withReturnType<ReadonlyArray<string>>(),
  Match.when(chapterKind, (_kind, { own }) =>
    Option.toArray(
      Option.map(
        Option.flatMap(own, (chapter) =>
          Option.fromNullishOr(chapter.module.doc.frontmatter?.language),
        ),
        (written) => `Language: ${written.value}`,
      ),
    ),
  ),
  Match.when(discussionKind, (): ReadonlyArray<string> => []),
  Match.exhaustive,
)

const fieldsOf = (
  kind: LoomKind,
  book: Option.Option<string>,
  own: Option.Option<Chapter>,
): ReadonlyArray<string> => [
  ...Option.toArray(Option.map(book, (name) => `Book: ${name}`)),
  ...kindFields({ own }, kind),
]

const openingOf = (catalogue: Catalogue, ref: BoxRef, kind: LoomKind): Opening => {
  const own = chapterOf(catalogue, ref.module)
  const book = bookAt(catalogue, ref.module)
  const part = Option.match(own, {
    onNone: () => noPartIn(book),
    onSome: (chapter) => chapter.part,
  })
  const number = nextNumber(catalogue, part, kind)
  const title = ref.name.value
  const body = textOf(ref.body)
  return {
    file: fileOf(ref, kind, number),
    text: [
      '---',
      ...membership(part, number, title, kind),
      ...fieldsOf(kind, book, own),
      '---',
      '',
      `# ${title}`,
      '',
      ...(body === '' ? [] : [body, '']),
    ].join('\n'),
  }
}

export type CopiedFrom = 'chapter' | 'discussion' | 'section'

export type BoxNotice = Data.TaggedEnum<{
  Unwritten: { readonly name: BoxNameToken; readonly kind: LoomKind; readonly opening: Opening }
  Unsettled: { readonly name: BoxNameToken; readonly target: Option.Option<string> }
  Stale: {
    readonly name: BoxNameToken
    readonly of: CopiedFrom
    readonly title: string
    readonly summary: string
    readonly body: Position
  }
}>

export const BoxNotice = Data.taggedEnum<BoxNotice>()

type StaleBox = Data.TaggedEnum.Value<BoxNotice, 'Stale'>

const bodySpan = (ref: BoxRef, closer: LoomWeft): Position => ({
  start: { line: ref.opener.position.start.line + 1, offset: ref.opener.position.end.offset },
  end: closer.position.start,
})

type Copied = { readonly of: CopiedFrom; readonly title: string; readonly summary: string }

const sectionOpeningOf = (section: LoomSection): string =>
  textOf(outsideBoxes(openingLinesOf(section)))

const copiedFromChapter = (chapter: Chapter): Copied => ({
  of: chapter.kind === discussionKind ? 'discussion' : 'chapter',
  title: chapter.title,
  summary: summaryOf(chapter.module),
})

const copiedFromPlace: (place: Place) => Option.Option<Copied> = Match.type<Place>().pipe(
  Match.tag('Section', ({ ref }) =>
    Option.some<Copied>({
      of: 'section',
      title: ref.section.heading.title?.source ?? '',
      summary: sectionOpeningOf(ref.section),
    }),
  ),
  Match.tag('Chapter', ({ chapter }) => Option.some(copiedFromChapter(chapter))),
  Match.orElse(() => Option.none<Copied>()),
)

const staleOf = (ref: BoxRef, copied: Copied): Option.Option<BoxNotice> =>
  pipe(
    ref.closer,
    Option.filter(() => textOf(ref.body) !== copied.summary),
    Option.map((closer) =>
      BoxNotice.Stale({
        name: ref.name,
        of: copied.of,
        title: copied.title,
        summary: copied.summary === '' ? '' : `${copied.summary}\n`,
        body: bodySpan(ref, closer),
      }),
    ),
  )

const loomNoticeOf = (
  catalogue: Catalogue,
  ref: BoxRef,
  kind: LoomKind,
): Option.Option<BoxNotice> =>
  Option.match(boxTarget(catalogue, ref), {
    onNone: () =>
      Option.some(
        BoxNotice.Unwritten({ name: ref.name, kind, opening: openingOf(catalogue, ref, kind) }),
      ),
    onSome: (target) => staleOf(ref, copiedFromChapter(target)),
  })

const tropeNoticeOf = (catalogue: Catalogue, ref: BoxRef): Option.Option<BoxNotice> =>
  Option.match(Option.flatMap(tropePlaceOf(catalogue, ref), copiedFromPlace), {
    onNone: () =>
      Option.some(
        BoxNotice.Unsettled({
          name: ref.name,
          target: Option.map(ref.anchors, (value) => value.value),
        }),
      ),
    onSome: (copied) => staleOf(ref, copied),
  })

const noticeOf = (catalogue: Catalogue, ref: BoxRef): Option.Option<BoxNotice> => {
  const kind = ref.kind
  return isLoomKind(kind) ? loomNoticeOf(catalogue, ref, kind) : tropeNoticeOf(catalogue, ref)
}

const noticesOf = (catalogue: Catalogue, module: Location): ReadonlyArray<BoxNotice> =>
  Array.getSomes(boxesIn(catalogue, module).map((ref) => noticeOf(catalogue, ref)))

export const boxNoticesIn = (corpus: LoomCorpusAst, module: LoomModule): ReadonlyArray<BoxNotice> =>
  noticesOf(catalogueOf(corpus.modules), module.path)

const withSummaries = (text: string, stale: ReadonlyArray<StaleBox>): string =>
  Array.sort(
    stale,
    Order.mapInput(Order.Number, (box: StaleBox) => -box.body.start.offset),
  ).reduce(
    (written, box) =>
      written.slice(0, box.body.start.offset) + box.summary + written.slice(box.body.end.offset),
    text,
  )

export const refreshedSummaries = (
  corpus: LoomCorpusAst,
): ReadonlyArray<{ readonly path: Location; readonly text: string }> => {
  const catalogue = catalogueOf(corpus.modules)
  return Array.fromIterable(corpus.modules.values())
    .map((module) => ({
      module,
      stale: noticesOf(catalogue, module.path).filter(BoxNotice.$is('Stale')),
    }))
    .filter(({ stale }) => stale.length > 0)
    .map(({ module, stale }) => ({
      path: module.path,
      text: withSummaries(module.text, stale),
    }))
}

export type CorpusEdit = { readonly path: Location; readonly at: Position; readonly text: string }

const contentEnd = (line: LoomWeft): Point => ({
  line: line.position.start.line,
  offset: line.position.start.offset + line.source.replace(/\r?\n$/, '').length,
})

const openingEditOf = (
  section: LoomSection,
  body: string,
): Option.Option<{ readonly at: Position; readonly text: string }> => {
  const lines = openingLinesOf(section)
  const written = lines.filter((line) => line.source.trim() !== '')
  return lines.some((line) => Option.isSome(boxOf(line)))
    ? Option.none()
    : Option.some(
        Array.match(written, {
          onEmpty: () => ({
            at: { start: section.heading.position.end, end: section.heading.position.end },
            text: body === '' ? '' : `\n${body}\n`,
          }),
          onNonEmpty: (all) => ({
            at: {
              start: Array.headNonEmpty(all).position.start,
              end: contentEnd(Array.lastNonEmpty(all)),
            },
            text: body,
          }),
        }),
      )
}

type Copy = { readonly module: LoomModule; readonly section: LoomSection }

const chapterCopy = (chapter: Chapter): Option.Option<Copy> =>
  Option.map(openingSectionOf(chapter.module), (section) => ({ module: chapter.module, section }))

const copyOf = Match.fn((_catalogue: Catalogue, _modules: Modules, ref: BoxRef) => ref.kind).pipe(
  Match.withReturnType<Option.Option<Copy>>(),
  Match.when(chapterKind, (_kind, catalogue, _modules, ref) =>
    Option.flatMap(boxTarget(catalogue, ref), chapterCopy),
  ),
  Match.when(discussionKind, () => Option.none<Copy>()),
  Match.when(tropeKind, (_kind, catalogue, modules, ref) =>
    Option.flatMap(tropePlaceOf(catalogue, ref), (place) =>
      Place.$match(place, {
        Section: ({ ref: at }) =>
          Option.map(Option.fromNullishOr(modules.get(at.module)), (module) => ({
            module,
            section: at.section,
          })),
        Chapter: ({ chapter }) =>
          chapter.kind === discussionKind ? Option.none<Copy>() : chapterCopy(chapter),
        Box: () => Option.none<Copy>(),
        Book: () => Option.none<Copy>(),
        Part: () => Option.none<Copy>(),
      }),
    ),
  ),
  Match.exhaustive,
)

const boxToTarget = (
  catalogue: Catalogue,
  modules: Modules,
  was: LoomModule,
  ref: BoxRef,
): Option.Option<CorpusEdit> =>
  pipe(
    Option.all({
      copy: Option.filter(
        copyOf(catalogue, modules, ref),
        (copy) => copy.module.path !== ref.module,
      ),
      before: Array.findFirst(
        pointingBoxesOf(was),
        (old) => old.kind === ref.kind && old.name.value === ref.name.value,
      ),
    }),
    Option.filter(({ copy, before }) => {
      const summary = sectionOpeningOf(copy.section)
      return (
        Option.isSome(before.closer) &&
        Option.isSome(ref.closer) &&
        textOf(before.body) === summary &&
        textOf(ref.body) !== summary
      )
    }),
    Option.flatMap(({ copy }) =>
      Option.map(openingEditOf(copy.section, textOf(ref.body)), (edit) => ({
        path: copy.module.path,
        ...edit,
      })),
    ),
  )

const loomToBoxes = (
  catalogue: Catalogue,
  was: LoomModule,
  now: LoomModule,
): ReadonlyArray<CorpusEdit> => {
  const before = summaryOf(was)
  const after = summaryOf(now)
  return before === after
    ? []
    : Array.getSomes(
        Option.toArray(chapterOf(catalogue, now.path))
          .flatMap((chapter) => boxesPointingTo(catalogue, chapter))
          .filter((ref) => ref.module !== now.path && textOf(ref.body) === before)
          .map((ref) =>
            Option.map(ref.closer, (closer) => ({
              path: ref.module,
              at: bodySpan(ref, closer),
              text: after === '' ? '' : `${after}\n`,
            })),
          ),
      )
}

const openingsOf = Match.fn((place: Place, _was: LoomModule) => place).pipe(
  Match.withReturnType<Option.Option<{ readonly before: string; readonly after: string }>>(),
  Match.tag('Section', ({ ref }, _place, was) =>
    Option.map(
      Array.findFirst(
        was.doc.sections,
        (old) => old.heading.title?.source === ref.section.heading.title?.source,
      ),
      (old) => ({ before: sectionOpeningOf(old), after: sectionOpeningOf(ref.section) }),
    ),
  ),
  Match.tag('Chapter', ({ chapter }, _place, was) =>
    Option.some({ before: summaryOf(was), after: summaryOf(chapter.module) }),
  ),
  Match.orElse(() => Option.none()),
)

const tropesToBoxes = (
  catalogue: Catalogue,
  was: LoomModule,
  now: LoomModule,
): ReadonlyArray<CorpusEdit> =>
  Array.fromIterable(catalogue.boxes.values())
    .flat()
    .filter((ref) => ref.kind === tropeKind && ref.module !== now.path)
    .flatMap((ref) =>
      pipe(
        tropePlaceOf(catalogue, ref),
        Option.filter((place) => Option.contains(placeModuleOf(place), now.path)),
        Option.flatMap((place) => openingsOf(place, was)),
        Option.filter(({ before, after }) => before !== after && textOf(ref.body) === before),
        Option.flatMap(({ after }) =>
          Option.map(ref.closer, (closer) => ({
            path: ref.module,
            at: bodySpan(ref, closer),
            text: after === '' ? '' : `${after}\n`,
          })),
        ),
        Option.toArray,
      ),
    )

export const syncedSummaries = (
  corpus: LoomCorpusAst,
  was: LoomModule,
  now: LoomModule,
): ReadonlyArray<CorpusEdit> => {
  const modules = new Map(corpus.modules).set(now.path, now)
  const catalogue = catalogueOf(modules)
  return [
    ...Array.getSomes(
      boxesIn(catalogue, now.path).map((ref) => boxToTarget(catalogue, modules, was, ref)),
    ),
    ...loomToBoxes(catalogue, was, now),
    ...tropesToBoxes(catalogue, was, now),
  ]
}

type Judged = { readonly health: { readonly diagnostics: ReadonlyArray<Diagnostic> } }

const foundIn = (found: ReadonlyArray<Diagnostic>, value: unknown): ReadonlyArray<Diagnostic> => {
  if (Array.isArray(value)) return value.reduce(foundIn, found)
  if (!isNode(value)) return found
  const own = 'health' in value ? (value as unknown as Judged).health.diagnostics : []
  return Object.values(value).reduce(foundIn, own.length === 0 ? found : [...found, ...own])
}

const diagnosticsIn = (node: unknown): ReadonlyArray<Diagnostic> => foundIn([], node)

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
  Array.getSomes(
    Array.fromIterable(corpus.modules.values()).map((m) => {
      const diagnostics = diagnosticsOf(m).filter((d) => d.severity === 'error')
      return diagnostics.length === 0 ? Option.none() : Option.some({ path: m.path, diagnostics })
    }),
  )

export type Namesakes = {
  readonly title: { readonly source: string; readonly position: Position }
  readonly looms: ReadonlyArray<Location>
}

export const namesakesOf = (catalogue: Catalogue, module: LoomModule): Option.Option<Namesakes> =>
  pipe(
    Option.all({ chapter: chapterOf(catalogue, module.path), title: chapterTitleToken(module) }),
    Option.flatMap(({ chapter, title }) =>
      pipe(
        filedUnder(catalogue.chaptersBy.title, chapter.title)
          .filter(
            (other) => other.module.path !== module.path && samePart(chapter.part, other.part),
          )
          .map((other) => other.module.path),
        Option.liftPredicate(Array.isReadonlyArrayNonEmpty),
        Option.map((looms) => ({ title, looms })),
      ),
    ),
  )

export const bookTwinsOf = (catalogue: Catalogue, module: LoomModule): Option.Option<Namesakes> =>
  pipe(
    Option.fromNullishOr(module.doc.frontmatter?.book),
    Option.filter(() => isBookLoom(module)),
    Option.flatMap((line) =>
      pipe(
        bookLoomsOf(catalogue.modules, line.value)
          .filter((other) => other.path !== module.path)
          .map((other) => other.path),
        Option.liftPredicate(Array.isReadonlyArrayNonEmpty),
        Option.map((looms): Namesakes => ({
          title: { source: line.value, position: line.position },
          looms,
        })),
      ),
    ),
  )

export const unopenedBookOf = (
  catalogue: Catalogue,
  module: LoomModule,
): Option.Option<FrontmatterBookToken> =>
  Option.filter(
    Option.fromNullishOr(module.doc.frontmatter?.book),
    (line) => bookLoomsOf(catalogue.modules, line.value).length === 0,
  )
