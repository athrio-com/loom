import { Array, Data, Match, Option, Order, pipe, Schema } from 'effect'
import { type Diagnostic, type Point, type Position } from '#ast/LoomNode'
import {
  boxKind,
  type BoxNameToken,
  type BoxToken,
  chapterKind,
  conclusionKind,
  discussionKind,
  type FrontmatterBookToken,
  type FrontmatterEntryToken,
  type HeadingTitleToken,
  isLoomKind,
  isPointingKind,
  type LoomKind,
  type ParameterValueToken,
  type PointingKind,
  tropeKind,
  type WarpAnchorToken,
  type WarpToken,
} from '#ast/LoomTokens'
import { boxOf, type LoomWeft } from '#ast/Weft'
import { ProductSchema, type Provided } from '#ast/ProductAst'
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

type PartRef = {
  readonly book: Option.Option<string>
  readonly number: Option.Option<string>
  readonly name: Option.Option<string>
}

type Chapter = {
  readonly title: string
  readonly number: Option.Option<string>
  readonly discussion: boolean
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
      Array.map(Array.fromIterable(modules.values()), (module) =>
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

const chaptersIn = (modules: Modules): ReadonlyArray<Chapter> => {
  const names = partNamesIn(modules)
  return pipe(
    Array.fromIterable(modules.values()),
    Array.filter((module) => !isBookLoom(module)),
    Array.map((module) =>
      Option.map(chapterTitleToken(module), (title) => ({
        title: title.source,
        number: pipe(
          Option.fromNullishOr(
            module.doc.frontmatter?.chapter ?? module.doc.frontmatter?.discussion,
          ),
          Option.map((ordinal) => ordinal.value),
          Option.filter((ordinal) => ordinal !== ''),
        ),
        discussion: module.doc.frontmatter?.discussion !== undefined,
        book: bookOf(module),
        part: partOf(names, module),
        module,
      })),
    ),
    Array.getSomes,
  )
}

const openingSectionOf = (module: LoomModule): Option.Option<LoomSection> =>
  Array.findFirst(module.doc.sections, (section) => section.heading.title !== undefined)

export type Catalogue = {
  readonly modules: Modules
  readonly titles: TitleIndexes
  readonly chapters: ReadonlyArray<Chapter>
  readonly boxes: ReadonlyMap<Location, ReadonlyArray<BoxRef>>
}

export const catalogueOf = (modules: Modules): Catalogue => ({
  modules,
  titles: titleIndexes(modules),
  chapters: chaptersIn(modules),
  boxes: new Map(
    Array.map(Array.fromIterable(modules.values()), (module) => [
      module.path,
      pointingBoxesOf(module),
    ]),
  ),
})

const bookAt = (catalogue: Catalogue, from: Location): Option.Option<string> =>
  Option.flatMap(Option.fromNullishOr(catalogue.modules.get(from)), bookOf)

const isBook = (catalogue: Catalogue, name: string): boolean =>
  Array.some(Array.fromIterable(catalogue.modules.values()), (module) =>
    Option.contains(bookOf(module), name),
  )

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

const numberIn = (keyword: string, name: string): Option.Option<string> =>
  Option.fromNullishOr(new RegExp(`^${keyword}\\s+(\\S+)$`).exec(name)?.[1])

const chaptersWithin = (
  catalogue: Catalogue,
  book: Option.Option<string>,
  part: Option.Option<PartRef>,
  test: (chapter: Chapter) => boolean,
): ReadonlyArray<Chapter> =>
  Array.filter(
    catalogue.chapters,
    (chapter) =>
      test(chapter) &&
      sameBook(chapter.book, book) &&
      Option.match(part, {
        onNone: () => true,
        onSome: (part) => samePart(chapter.part, part),
      }),
  )

const partsWhere = (
  catalogue: Catalogue,
  book: Option.Option<string>,
  test: (part: PartRef) => boolean,
): ReadonlyArray<PartRef> =>
  Option.toArray(
    Option.map(
      Array.findFirst(
        catalogue.chapters,
        (chapter) => sameBook(chapter.book, book) && test(chapter.part),
      ),
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
  keyword: string,
  discussion: boolean,
  step: (place: Place) => Step,
  segment: Segment,
): ReadonlyArray<Step> =>
  Option.match(numberIn(keyword, segment.text), {
    onNone: (): ReadonlyArray<Step> => [],
    onSome: (number) =>
      Array.map(
        chaptersWithin(
          catalogue,
          book,
          part,
          (chapter) => chapter.discussion === discussion && Option.contains(chapter.number, number),
        ),
        (chapter) => step(Place.Chapter({ chapter })),
      ),
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
    ...Array.map(
      chaptersWithin(catalogue, book, part, (chapter) => chapter.title === segment.text),
      (chapter) => step(false)(Place.Chapter({ chapter })),
    ),
    ...numberedSteps(catalogue, book, part, 'Chapter', false, step(true), segment),
    ...numberedSteps(catalogue, book, part, 'Discussion', true, step(true), segment),
  ]
  const bookSteps = (book: Option.Option<string>): ReadonlyArray<Step> => [
    ...Array.map(
      partsWhere(catalogue, book, (part) => Option.contains(part.name, segment.text)),
      (part) => step(false)(Place.Part({ part })),
    ),
    ...Option.match(numberIn('Part', segment.text), {
      onNone: (): ReadonlyArray<Step> => [],
      onSome: (number) =>
        Array.map(
          partsWhere(catalogue, book, (part) => Option.contains(part.number, number)),
          (part) => step(true)(Place.Part({ part })),
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
      Match.value(place).pipe(
        Match.tag('Book', ({ book }) => bookSteps(Option.some(book))),
        Match.tag('Part', ({ part }) => chapterSteps(part.book, Option.some(part))),
        Match.tag('Chapter', ({ chapter }) =>
          Option.toArray(
            Option.orElse(
              Option.map(sectionTitled(catalogue, chapter.module.path, segment.text), (ref) =>
                step(false)(Place.Section({ ref })),
              ),
              () =>
                Option.map(boxNamed(catalogue, chapter.module.path, segment.text), (ref) => ({
                  ...step(false)(boxPlace(catalogue, ref)),
                  through: throughOf(ref),
                })),
            ),
          ),
        ),
        Match.tag('Section', (): ReadonlyArray<Step> => []),
        Match.tag('Box', (): ReadonlyArray<Step> => []),
        Match.exhaustive,
      ),
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
      Array.flatMap(
        stepsNamed(
          catalogue,
          own,
          Option.map(Array.last(trail), (step) => step.place),
          segment,
        ),
        (step) => walk(catalogue, own, Array.append(trail, step), rest),
      ),
  })

const whole = (name: string): Segment => ({ text: name, start: 0, end: name.length })

const segmentsOf = (name: string): ReadonlyArray<Segment> =>
  Array.map(Array.fromIterable(name.matchAll(/[^,]+/g)), (match) => {
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
  Array.reduce(lookups, nothingFound, (found, lookup) => (found.length > 0 ? found : lookup()))

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
): ReadonlyArray<Trail> => trailsOf(catalogue, from, anchor.name.value)

export const sectionOf = (trail: Trail): Option.Option<SectionRef> =>
  placeSectionOf(Array.lastNonEmpty(trail).place)

const placeSectionOf = (place: Place): Option.Option<SectionRef> =>
  Match.value(place).pipe(
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

const chapterOf = (catalogue: Catalogue, module: Location): Option.Option<Chapter> =>
  Array.findFirst(catalogue.chapters, (chapter) => chapter.module.path === module)

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
    onSome: (book) => Array.map(paths, (path) => [book, ...path]),
  }),
]

const namesFor = (catalogue: Catalogue, place: Place): ReadonlyArray<ReadonlyArray<string>> =>
  Match.value(place).pipe(
    Match.tag('Chapter', ({ chapter }) =>
      throughBook(chapter, throughPart(chapter, [chapter.title])),
    ),
    Match.tag('Section', ({ ref }) =>
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
    Match.tag('Box', ({ ref }) =>
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

const samePlace = (place: Place, other: Place): boolean =>
  Match.value(place).pipe(
    Match.tag('Book', ({ book }) => other._tag === 'Book' && other.book === book),
    Match.tag('Part', ({ part }) => other._tag === 'Part' && samePart(part, other.part)),
    Match.tag(
      'Chapter',
      ({ chapter }) =>
        other._tag === 'Chapter' && other.chapter.module.path === chapter.module.path,
    ),
    Match.tag('Section', ({ ref }) => namesSection(ref)(other)),
    Match.tag('Box', ({ ref }) => namesBox(ref)(other)),
    Match.exhaustive,
  )

const leadsTo =
  (catalogue: Catalogue, from: Location, place: Place) =>
  (path: string): boolean =>
    Option.exists(soleTrail(trailsOf(catalogue, from, path)), (trail) =>
      samePlace(Array.lastNonEmpty(trail).place, place),
    )

export const pathsTo = (
  catalogue: Catalogue,
  from: Location,
  trails: ReadonlyArray<Trail>,
): ReadonlyArray<string> =>
  Array.getSomes(
    Array.map(trails, (trail) => {
      const place = Array.lastNonEmpty(trail).place
      return Array.findFirst(
        Array.map(namesFor(catalogue, place), (names) => Array.join(names, ', ')),
        leadsTo(catalogue, from, place),
      )
    }),
  )

const anchorsOf = (section: LoomSection): ReadonlyArray<WarpAnchorToken> =>
  pipe(
    [...section.preamble, ...section.code],
    Array.flatMap((weft) => weft.anchors),
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
  ...Array.flatMap(doc.sections, (section) => [...section.preamble, ...section.code]),
]

const closesBox = (weft: LoomWeft): boolean =>
  Option.exists(boxOf(weft), (box) => box.side === 'close')

const boxFrom = (
  lines: Array.NonEmptyReadonlyArray<LoomWeft>,
): readonly [Option.Option<OpenedBox>, ReadonlyArray<LoomWeft>] => {
  const opener = Array.headNonEmpty(lines)
  const rest = Array.tailNonEmpty(lines)
  return Option.match(
    Option.filter(boxOf(opener), (box) => box.side === 'open'),
    {
      onNone: () => [Option.none(), rest],
      onSome: (box) => {
        const end = Option.getOrElse(Array.findFirstIndex(rest, closesBox), () => rest.length)
        return [
          Option.some({
            box,
            opener,
            body: Array.take(rest, end),
            closer: Array.get(rest, end),
          }),
          Array.drop(rest, end + 1),
        ]
      },
    },
  )
}

const boxesAmong = (lines: ReadonlyArray<LoomWeft>): ReadonlyArray<OpenedBox> =>
  Array.getSomes(Array.chop(lines, boxFrom))

export const openedBoxesOf = (doc: LoomDocument): ReadonlyArray<OpenedBox> =>
  boxesAmong(linesOf(doc))

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

const pointingBoxesOf = (module: LoomModule): ReadonlyArray<BoxRef> =>
  Array.getSomes(
    Array.map(openedBoxesOf(module.doc), (opened) => {
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
  )

const boxesIn = (catalogue: Catalogue, module: Location): ReadonlyArray<BoxRef> =>
  Option.getOrElse(Option.fromNullishOr(catalogue.boxes.get(module)), () => [])

const boxTarget = (catalogue: Catalogue, ref: BoxRef): Option.Option<Chapter> => {
  const titled = (chapter: Chapter): boolean =>
    chapter.discussion === (ref.kind === discussionKind) && chapter.title === ref.name.value
  return ref.kind === tropeKind
    ? Option.none()
    : Option.orElse(
        Option.flatMap(chapterOf(catalogue, ref.module), (own) =>
          Array.head(chaptersWithin(catalogue, own.book, Option.some(own.part), titled)),
        ),
        () =>
          Array.head(
            chaptersWithin(catalogue, bookAt(catalogue, ref.module), Option.none(), titled),
          ),
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

const valueLocation = (ref: BoxRef): Option.Option<CorpusLocation> =>
  pipe(
    ref.anchors,
    Option.filter((value) => !value.value.includes(',')),
    Option.map((value): CorpusLocation => {
      const quoted = value.source.startsWith('"') ? 1 : 0
      return {
        path: ref.module,
        position: {
          start: shifted(value.position.start, quoted),
          end: shifted(value.position.end, -quoted),
        },
      }
    }),
  )

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
  pipe(
    boxesIn(catalogue, path),
    Array.filter((ref) => ref.kind === tropeKind && Array.isReadonlyArrayNonEmpty(ref.provides)),
    Array.flatMap((ref) =>
      Option.toArray(
        Option.map(
          Option.flatMap(tropePlaceOf(catalogue, ref), placeSectionOf),
          (entry): TropeContract => ({ trope: ref.name.value, entry, provides: providedOf(ref) }),
        ),
      ),
    ),
  )

const providedOf = (ref: BoxRef): ReadonlyArray<Provided> =>
  Array.map(ref.provides, (value): Provided => ({ name: value.value, at: value.position }))

const tropeValuesNaming = (
  catalogue: Catalogue,
  names: (place: Place) => boolean,
): ReadonlyArray<CorpusLocation> =>
  pipe(
    Array.flatten(Array.fromIterable(catalogue.boxes.values())),
    Array.filter((ref) => Option.exists(tropePlaceOf(catalogue, ref), names)),
    Array.flatMap((ref) => Option.toArray(valueLocation(ref))),
  )

const boxesPointingTo = (catalogue: Catalogue, chapter: Chapter): ReadonlyArray<BoxRef> =>
  Array.filter(Array.flatten(Array.fromIterable(catalogue.boxes.values())), (ref) =>
    Option.exists(boxTarget(catalogue, ref), (found) => found.module.path === chapter.module.path),
  )

const boxesNaming = (catalogue: Catalogue, chapter: Chapter): ReadonlyArray<CorpusLocation> => [
  ...Array.map(boxesPointingTo(catalogue, chapter), boxLocation),
  ...tropeValuesNaming(catalogue, (place) => namesChapter(chapter)(place)),
]

export const reach = (
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

const placeModuleOf = (place: Place): Option.Option<Location> =>
  Match.value(place).pipe(
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
  ...pipe(
    module.doc.sections,
    Array.flatMap(anchorsOf),
    Array.flatMap((anchor) =>
      Array.getSomes(
        Array.map(anchorTrails(catalogue, module.path, anchor), (trail) =>
          Option.map(moduleOf(trail), (target): Reach => ({ target, at: anchor.name.position })),
        ),
      ),
    ),
  ),
  ...Array.getSomes(
    Array.map(boxesIn(catalogue, module.path), (ref) =>
      Option.map(placeModuleOf(boxPlace(catalogue, ref)), (target): Reach => ({
        target,
        at: boxReachAt(ref),
      })),
    ),
  ),
]

const anchorEdges = (
  modules: Modules,
): ReadonlyArray<{ readonly owner: Location; readonly target: Location }> => {
  const catalogue = catalogueOf(modules)
  return Array.flatMap(Array.fromIterable(modules.values()), (m) =>
    Array.map(reachesOf(catalogue, m), ({ target }) => ({ owner: m.path, target })),
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
    () => anchorStepAt(catalogue, modules, path, offset),
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
  Array.flatMap(Array.fromIterable(modules.values()), (m) =>
    pipe(
      m.doc.sections,
      Array.flatMap(anchorsOf),
      Array.flatMap((anchor) =>
        pipe(
          stepsOf(catalogue, m.path, anchor),
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
  Option.flatMap(
    anchorStepAt(catalogueOf(corpus.modules), corpus.modules, path, offset),
    ({ place }) => placeLocation(corpus.modules, place),
  )

const placeLocation = (modules: Modules, place: Place): Option.Option<CorpusLocation> =>
  Match.value(place).pipe(
    Match.tag('Section', ({ ref }) => titleLocation(ref)),
    Match.tag('Chapter', ({ chapter }) => chapterLocation(chapter)),
    Match.tag('Box', ({ ref }) => Option.some(boxLocation(ref))),
    Match.tag('Book', ({ book }) => bookLoomLocation(modules, book)),
    Match.tag('Part', () => Option.none<CorpusLocation>()),
    Match.exhaustive,
  )

const chapterTitledBy = (catalogue: Catalogue, ref: SectionRef): Option.Option<Chapter> =>
  Array.findFirst(
    catalogue.chapters,
    (chapter) =>
      chapter.module.path === ref.module &&
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
  ...tropeValuesNaming(catalogue, (place) => namesSection(ref)(place)),
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

const placeNames = (
  catalogue: Catalogue,
  modules: Modules,
  mention: Mention,
  spanOf: SpanOf,
): ReadonlyArray<CorpusLocation> =>
  Match.value(mention.place).pipe(
    Match.tag('Section', ({ ref }) => sectionNames(catalogue, modules, ref, spanOf)),
    Match.tag('Chapter', ({ chapter }) =>
      mention.numbered
        ? chapterNumbers(catalogue, modules, chapter, spanOf)
        : chapterNames(catalogue, modules, chapter, spanOf),
    ),
    Match.tag('Box', ({ ref }) => [
      boxLocation(ref),
      ...anchorsNaming(catalogue, modules, (step) => namesBox(ref)(step.place), spanOf),
    ]),
    Match.tag('Book', ({ book }) => bookNames(catalogue, modules, book, spanOf)),
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
  const roots = Array.filter(
    catalogue.chapters,
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
  Array.flatMap(Array.fromIterable(modules.values()), (module) =>
    pipe(
      tropeEntriesOf(module),
      Array.filter(
        (name) =>
          name.value === chapter.title &&
          Option.exists(
            tropeEntryChapterOf(catalogue, module.path, name.value),
            (found) => found.module.path === chapter.module.path,
          ),
      ),
      Array.map((name): CorpusLocation => ({ path: module.path, position: name.position })),
    ),
  )

const rootedInNaming = (
  catalogue: Catalogue,
  modules: Modules,
  chapter: Chapter,
): ReadonlyArray<CorpusLocation> =>
  Array.flatMap(Array.fromIterable(modules.values()), (module) =>
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

const chapterNumbers = (
  catalogue: Catalogue,
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
    catalogue,
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
  const catalogue = catalogueOf(corpus.modules)
  return Option.match(chapterOf(catalogue, path), {
    onNone: (): ReadonlyArray<CorpusLocation> => [],
    onSome: (chapter) => chapterNumbers(catalogue, corpus.modules, chapter, spanOf),
  })
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
  ...Array.flatMap(Array.fromIterable(modules.values()), (module) => [
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
  Array.filter(
    Array.fromIterable(modules.values()),
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
  Array.flatMap(Array.fromIterable(modules.values()), (module) =>
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
          Match.when('boxName', () => boxDefinitionAt(corpus, path, offset)),
          Match.whenOr('frontmatterTitle', 'frontmatterEntry', 'frontmatterRootedIn', () =>
            chapterDefinitionAt(corpus, path, offset),
          ),
          Match.whenOr('frontmatterPart', 'frontmatterPartName', () =>
            partDefinitionAt(corpus, path, offset),
          ),
          Match.when('frontmatterBook', () => bookDefinitionAt(corpus, path, offset)),
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
          Match.when('boxName', () => boxNamesAt(corpus, path, offset, wholeAnchor)),
          Match.whenOr('frontmatterTitle', 'frontmatterEntry', 'frontmatterRootedIn', () =>
            chapterNamesAt(corpus, path, offset, wholeAnchor),
          ),
          Match.when('frontmatterMembership', () => chapterNumbersAt(corpus, path, wholeAnchor)),
          Match.whenOr('frontmatterPart', 'frontmatterPartName', () =>
            partGroupAt(corpus, path, offset),
          ),
          Match.when('frontmatterBook', () => bookNamesAt(corpus, path, offset, wholeAnchor)),
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
          Match.when('boxName', () => boxNamesAt(corpus, path, offset, segmentPosition)),
          Match.whenOr('frontmatterTitle', 'frontmatterEntry', 'frontmatterRootedIn', () =>
            chapterNamesAt(corpus, path, offset, segmentPosition),
          ),
          Match.when('frontmatterMembership', () =>
            chapterNumbersAt(corpus, path, segmentPosition),
          ),
          Match.when('frontmatterBook', () => bookNamesAt(corpus, path, offset, segmentPosition)),
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
      pipe(
        module.doc.sections,
        Array.flatMap(anchorsOf),
        Array.flatMap((anchor) =>
          pipe(
            stepsOf(catalogue, path, anchor),
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

const tidy = (text: string): string =>
  text
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

const textOf = (lines: ReadonlyArray<LoomWeft>): string =>
  tidy(
    Array.join(
      Array.map(lines, (line) => line.source),
      '',
    ),
  )

const stillInBox = (inBox: boolean, box: BoxToken): boolean =>
  Match.value(box.side).pipe(
    Match.when('open', () => true),
    Match.when('close', () => false),
    Match.when('stray', () => inBox),
    Match.exhaustive,
  )

const outsideBoxes = (lines: ReadonlyArray<LoomWeft>): ReadonlyArray<LoomWeft> =>
  Array.getSomes(
    Array.mapAccum(lines, false, (inBox, line): readonly [boolean, Option.Option<LoomWeft>] =>
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
  Array.filter(module.doc.sections, (section) => section.heading.marker.type === 'Divider')

const conclusionOf = (topic: LoomSection): Option.Option<string> =>
  pipe(
    boxesAmong([...topic.preamble, ...topic.code]),
    Array.findFirst((opened) => boxKind(opened.box) === conclusionKind),
    Option.map((opened) => textOf(opened.body)),
  )

const discussionSummaryOf = (module: LoomModule): string =>
  Array.join(
    Array.filter(
      [discussionOpeningOf(module), ...Array.getSomes(Array.map(topicsOf(module), conclusionOf))],
      (paragraph) => paragraph !== '',
    ),
    '\n\n',
  )

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
        ...Array.map(
          chaptersWithin(
            catalogue,
            part.book,
            Option.some(part),
            (chapter) => chapter.discussion === (kind === discussionKind),
          ),
          numberOf,
        ),
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

const fileOf = (ref: BoxRef, kind: LoomKind, number: Option.Option<number>): string =>
  Match.value(kind).pipe(
    Match.when(chapterKind, () => {
      const numbered = Option.match(number, {
        onNone: () => '',
        onSome: (next) => `${String(next).padStart(2, '0')}-`,
      })
      return `${folderOf(ref.module)}${numbered}${slugOf(ref.name.value)}.loom`
    }),
    Match.when(
      discussionKind,
      () => `${discussionsFolderOf(ref.module)}${slugOf(ref.name.value)}.loom`,
    ),
    Match.exhaustive,
  )

const fieldsOf = (
  kind: LoomKind,
  book: Option.Option<string>,
  own: Option.Option<Chapter>,
): ReadonlyArray<string> => [
  ...Option.toArray(Option.map(book, (name) => `Book: ${name}`)),
  ...Match.value(kind).pipe(
    Match.when(chapterKind, () => [
      'Status: Canvas',
      ...Option.toArray(
        Option.map(
          Option.flatMap(own, (chapter) =>
            Option.fromNullishOr(chapter.module.doc.frontmatter?.language),
          ),
          (written) => `Language: ${written.value}`,
        ),
      ),
    ]),
    Match.when(discussionKind, (): ReadonlyArray<string> => []),
    Match.exhaustive,
  ),
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
    text: Array.join(
      [
        '---',
        ...membership(part, number, title, kind),
        ...fieldsOf(kind, book, own),
        '---',
        '',
        `# ${title}`,
        '',
        ...(body === '' ? [] : [body, '']),
      ],
      '\n',
    ),
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
  of: chapter.discussion ? 'discussion' : 'chapter',
  title: chapter.title,
  summary: summaryOf(chapter.module),
})

const copiedFromPlace = (place: Place): Option.Option<Copied> =>
  Match.value(place).pipe(
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
  Array.getSomes(Array.map(boxesIn(catalogue, module), (ref) => noticeOf(catalogue, ref)))

export const boxNoticesIn = (corpus: LoomCorpusAst, module: LoomModule): ReadonlyArray<BoxNotice> =>
  noticesOf(catalogueOf(corpus.modules), module.path)

const withSummaries = (text: string, stale: ReadonlyArray<StaleBox>): string =>
  Array.reduce(
    Array.sort(
      stale,
      Order.mapInput(Order.Number, (box: StaleBox) => -box.body.start.offset),
    ),
    text,
    (written, box) =>
      written.slice(0, box.body.start.offset) + box.summary + written.slice(box.body.end.offset),
  )

export const refreshedSummaries = (
  corpus: LoomCorpusAst,
): ReadonlyArray<{ readonly path: Location; readonly text: string }> => {
  const catalogue = catalogueOf(corpus.modules)
  return pipe(
    Array.fromIterable(corpus.modules.values()),
    Array.map((module) => ({
      module,
      stale: Array.filter(noticesOf(catalogue, module.path), BoxNotice.$is('Stale')),
    })),
    Array.filter(({ stale }) => stale.length > 0),
    Array.map(({ module, stale }) => ({
      path: module.path,
      text: withSummaries(module.text, stale),
    })),
  )
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
  const written = Array.filter(lines, (line) => line.source.trim() !== '')
  return Array.some(lines, (line) => Option.isSome(boxOf(line)))
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

const copyOf = (catalogue: Catalogue, modules: Modules, ref: BoxRef): Option.Option<Copy> =>
  Match.value(ref.kind).pipe(
    Match.when(chapterKind, () => Option.flatMap(boxTarget(catalogue, ref), chapterCopy)),
    Match.when(discussionKind, () => Option.none<Copy>()),
    Match.when(tropeKind, () =>
      Option.flatMap(tropePlaceOf(catalogue, ref), (place) =>
        Match.value(place).pipe(
          Match.tag('Section', ({ ref: at }) =>
            Option.map(Option.fromNullishOr(modules.get(at.module)), (module) => ({
              module,
              section: at.section,
            })),
          ),
          Match.tag('Chapter', ({ chapter }) =>
            chapter.discussion ? Option.none<Copy>() : chapterCopy(chapter),
          ),
          Match.orElse(() => Option.none<Copy>()),
        ),
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
    : pipe(
        Option.toArray(chapterOf(catalogue, now.path)),
        Array.flatMap((chapter) => boxesPointingTo(catalogue, chapter)),
        Array.filter((ref) => ref.module !== now.path && textOf(ref.body) === before),
        Array.map((ref) =>
          Option.map(ref.closer, (closer) => ({
            path: ref.module,
            at: bodySpan(ref, closer),
            text: after === '' ? '' : `${after}\n`,
          })),
        ),
        Array.getSomes,
      )
}

const openingsOf = (
  place: Place,
  was: LoomModule,
): Option.Option<{ readonly before: string; readonly after: string }> =>
  Match.value(place).pipe(
    Match.tag('Section', ({ ref }) =>
      Option.map(
        Array.findFirst(
          was.doc.sections,
          (old) => old.heading.title?.source === ref.section.heading.title?.source,
        ),
        (old) => ({ before: sectionOpeningOf(old), after: sectionOpeningOf(ref.section) }),
      ),
    ),
    Match.tag('Chapter', ({ chapter }) =>
      Option.some({ before: summaryOf(was), after: summaryOf(chapter.module) }),
    ),
    Match.orElse(() => Option.none()),
  )

const tropesToBoxes = (
  catalogue: Catalogue,
  was: LoomModule,
  now: LoomModule,
): ReadonlyArray<CorpusEdit> =>
  pipe(
    Array.flatten(Array.fromIterable(catalogue.boxes.values())),
    Array.filter((ref) => ref.kind === tropeKind && ref.module !== now.path),
    Array.flatMap((ref) =>
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
      Array.map(boxesIn(catalogue, now.path), (ref) => boxToTarget(catalogue, modules, was, ref)),
    ),
    ...loomToBoxes(catalogue, was, now),
    ...tropesToBoxes(catalogue, was, now),
  ]
}

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

export const namesakesOf = (catalogue: Catalogue, module: LoomModule): Option.Option<Namesakes> =>
  pipe(
    Option.all({ chapter: chapterOf(catalogue, module.path), title: chapterTitleToken(module) }),
    Option.flatMap(({ chapter, title }) =>
      pipe(
        catalogue.chapters,
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

export const bookTwinsOf = (catalogue: Catalogue, module: LoomModule): Option.Option<Namesakes> =>
  pipe(
    Option.fromNullishOr(module.doc.frontmatter?.book),
    Option.filter(() => isBookLoom(module)),
    Option.flatMap((line) =>
      pipe(
        bookLoomsOf(catalogue.modules, line.value),
        Array.filter((other) => other.path !== module.path),
        Array.map((other) => other.path),
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
