import { Array, Context, Effect, Layer, Option, Order, pipe } from 'effect'
import type { LoomSection } from '@athrio/loom-ast/LoomAst'
import {
  boxOf,
  type PreambleWeft,
  type SectionBodyWeft,
  type TildeWeft,
} from '@athrio/loom-ast/Weft'
import { boxKind, noteKind, type WarpAnchorToken } from '@athrio/loom-ast/LoomTokens'
import {
  bookOf,
  catalogueOf,
  type Catalogue,
  conceptAt,
  conceptNames,
  type ConceptRef,
  definitionLinesOf,
  foldFirst,
  isBookLoom,
  type Location,
  type LoomCorpusAst,
  type LoomModule,
  resolveAnchor,
  sectionLinksOf,
} from '@athrio/loom-ast/LoomCorpusAst'
import { nodeOf, type Position, byTypeOr } from '@athrio/loom-ast/LoomNode'
import { keyOf } from '@athrio/loom-ast/ProductAst'
import { sectionNameOf } from '#ast/ProductBuilder'
import { unsettledRef } from '#ast/LoomVirtualCodeBuilder'
import { type Recognised, recognisedIn, vocabulariesIn } from '#ast/ConceptScope'
import {
  type AnchorLink,
  CodeBlockSchema,
  HeadingBlockSchema,
  MessageBlockSchema,
  NoteBlockSchema,
  ProseBlockSchema,
  type RecognisedWord,
  type SourceAnchor,
  type UnsettledSpan,
  type WovenBlock,
  type WovenBook,
  type WovenCorpus,
  type WovenNavEntry,
  type WovenPage,
  type WovenPart,
} from './WovenCorpus'
import {
  backMatterHeading,
  buildContents,
  orphansHeading,
  titleOf,
  type TocBackMatter,
  type TocBook,
  type TocChapter,
  type TocBackLoom,
  type TocPart,
} from './TableOfContentsBuilder'
import { sectionLanguage } from '../ast/ProductBuilder'

export class WeaveBuilder extends Context.Service<WeaveBuilder>()('WeaveBuilder', {
  make: Effect.succeed({
    build: (corpus: LoomCorpusAst, root?: Location): Effect.Effect<WovenCorpus> =>
      Effect.sync(() => buildCorpus(corpus, root)),
  }),
}) {
  static readonly layer = Layer.effect(this, this.make)
}

export const buildCorpus = (corpus: LoomCorpusAst, root?: Location): WovenCorpus => {
  const modules = Array.fromIterable(corpus.modules.values())
  const weaving = weavingOf(corpus.modules)
  const slugOf = (path: Location): string => pageSlug(weaving.catalogue, path)
  const contents = buildContents(corpus, root)
  const uses = usesByConcept(weaving, modules)
  const indexes = Array.getSomes(
    contents.books.map((book) => indexPageOf(weaving, modules, uses, book.name)),
  )
  const indexOf = (book: string): Option.Option<WovenNavEntry> =>
    Option.map(
      Array.findFirst(indexes, (page) => page.slug === indexSlug(book)),
      (page): WovenNavEntry => ({ number: '', title: page.title, slug: page.slug }),
    )
  const nav = Option.getOrElse(
    Option.map(
      Array.findFirst(contents.books, (book) => book.name === ''),
      (book) => bookNav(slugOf, book, indexOf(book.name)),
    ),
    (): ReadonlyArray<WovenPart> => [],
  )
  const books = contents.books.filter((book) => book.name !== '').map(wovenBook(slugOf, indexOf))
  const partOfSlug = partIndex([...nav, ...books.flatMap((book) => book.nav)])
  const opening = pipe(
    Option.fromNullishOr(root),
    Option.flatMap((path) => Option.fromNullishOr(corpus.modules.get(path))),
    Option.map((module): WovenNavEntry =>
      ({ number: '', title: titleOf(module), slug: slugOf(module.path) }),
    ),
  )
  const pages = pipe(
    [...modules.map((module) => buildPage(module, weaving, partOfSlug)), ...indexes],
    Array.sort(
      inReadingOrder(
        readingOrderOf(
          Option.map(opening, (entry) => entry.slug),
          nav,
          books,
        ),
      ),
    ),
  )
  return {
    nav,
    books,
    ...Option.match(opening, { onNone: () => ({}), onSome: (entry) => ({ opening: entry }) }),
    pages,
  }
}

type Weaving = {
  readonly catalogue: Catalogue
  readonly anchors: ReadonlySet<string>
  readonly sections: ReadonlySet<string>
  readonly recognised: ReadonlyMap<Location, ReadonlyArray<Recognised>>
}

const anchorKey = (path: Location, at: Position): string => `${path}#${at.start.offset}`

const weavingOf = (modules: ReadonlyMap<Location, LoomModule>): Weaving => {
  const catalogue = catalogueOf(modules)
  const vocabularies = vocabulariesIn(modules)
  const unsettled = Array.fromIterable(modules.values()).flatMap((module) =>
    module.product.code.flatMap((code) =>
      Array.getSomes(
        code.fragments.map((part) =>
          part.type === 'NameRef'
            ? unsettledRef(modules, catalogue, module.path, part)
            : Option.none(),
        ),
      ),
    ),
  )
  return {
    catalogue,
    anchors: new Set(unsettled.map((one) => anchorKey(one.path, one.anchor))),
    sections: new Set(unsettled.flatMap((one) => Option.toArray(Option.map(one.section, keyOf)))),
    recognised: new Map(
      Array.fromIterable(modules.values()).map((module) => [
        module.path,
        recognisedIn(vocabularies, module),
      ]),
    ),
  }
}

type Span = { readonly start: number; readonly end: number }

const slugFor = (path: string): string =>
  pipe(path.replace(/\.loom$/, '').split('/'), Array.takeRight(2), Array.join('/'))

const slugify = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

const pageSlug = (catalogue: Catalogue, path: Location): string => {
  const module = Option.fromNullishOr(catalogue.modules.get(path))
  return Option.match(Option.flatMap(module, bookOf), {
    onNone: () => slugFor(path),
    onSome: (book) =>
      Option.exists(module, isBookLoom) ? slugify(book) : `${slugify(book)}/${slugFor(path)}`,
  })
}

const isBlankSource = (source: string): boolean => source.trim().length === 0

const sliceContent = (text: string, span: Span): string =>
  text.slice(span.start, span.end).replace(/\s+$/, '')

type SlugOf = (path: Location) => string

const wovenEntry =
  (slugOf: SlugOf) =>
  (chapter: TocChapter): WovenNavEntry =>
    ({
      number: chapter.number,
      title: chapter.title,
      slug: slugOf(chapter.path),
      status: chapter.status,
      priority: chapter.priority,
      language: chapter.language,
    })

const wovenPart =
  (slugOf: SlugOf) =>
  (part: TocPart): WovenPart => ({
    number: part.number,
    name: part.name,
    chapters: part.chapters.map(wovenEntry(slugOf)),
  })

const wovenBackLoom =
  (slugOf: SlugOf) =>
  (loom: TocBackLoom): WovenNavEntry =>
    ({
      number: '',
      title: loom.title,
      slug: slugOf(loom.path),
    })

const orphansPart = (
  slugOf: SlugOf,
  orphans: ReadonlyArray<TocChapter>,
): ReadonlyArray<WovenPart> =>
  orphans.length === 0
    ? []
    : [
        {
          number: '',
          name: orphansHeading,
          chapters: orphans.map(wovenEntry(slugOf)),
        },
      ]

const backMatterPart = (
  slugOf: SlugOf,
  backMatter: TocBackMatter,
  index: Option.Option<WovenNavEntry>,
): ReadonlyArray<WovenPart> => {
  const entries = [...backMatter.looms.map(wovenBackLoom(slugOf)), ...Option.toArray(index)]
  return entries.length === 0
    ? []
    : [{ number: '', name: backMatterHeading, chapters: entries }]
}

const bookNav = (
  slugOf: SlugOf,
  book: TocBook,
  index: Option.Option<WovenNavEntry>,
): ReadonlyArray<WovenPart> => [
  ...book.parts.map(wovenPart(slugOf)),
  ...orphansPart(slugOf, book.orphans),
  ...backMatterPart(slugOf, book.backMatter, index),
]

const wovenBook =
  (slugOf: SlugOf, indexOf: (book: string) => Option.Option<WovenNavEntry>) =>
  (book: TocBook): WovenBook =>
    ({
      name: book.name,
      slug: book.path === '' ? '' : slugOf(book.path),
      nav: bookNav(slugOf, book, indexOf(book.name)),
    })

const partIndex = (nav: ReadonlyArray<WovenPart>): ReadonlyMap<string, string> =>
  new Map(nav.flatMap((part) => part.chapters.map((chapter) => [chapter.slug, part.name] as const)))

const slugsOf = (nav: ReadonlyArray<WovenPart>): ReadonlyArray<string> =>
  nav.flatMap((part) => part.chapters.map((chapter) => chapter.slug))

const readingOrderOf = (
  opening: Option.Option<string>,
  nav: ReadonlyArray<WovenPart>,
  books: ReadonlyArray<WovenBook>,
): ReadonlyMap<string, number> =>
  new Map(
    Array.dedupe([
      ...Option.toArray(opening),
      ...slugsOf(nav),
      ...books.flatMap((book) => [...(book.slug === '' ? [] : [book.slug]), ...slugsOf(book.nav)]),
    ]).map((slug, at) => [slug, at] as const),
  )

const inReadingOrder = (order: ReadonlyMap<string, number>): Order.Order<WovenPage> =>
  Order.combineAll([
    Order.mapInput(Order.Number, (page: WovenPage) =>
      Option.getOrElse(Option.fromNullishOr(order.get(page.slug)), () => order.size),
    ),
    Order.mapInput(Order.String, (page: WovenPage) => page.slug),
  ])

const buildPage = (
  module: LoomModule,
  weaving: Weaving,
  partOfSlug: ReadonlyMap<string, string>,
): WovenPage => {
  const slug = pageSlug(weaving.catalogue, module.path)
  return {
    slug,
    title: titleOf(module),
    part: partOfSlug.get(slug),
    book: Option.getOrUndefined(bookOf(module)),
    frontmatter: module.doc.frontmatter?.source,
    blocks: buildBlocks(module, weaving),
  }
}

const leadingBlocks = (module: LoomModule, weaving: Weaving): ReadonlyArray<WovenBlock> =>
  proseBlocks(module, weaving, module.doc.preamble, {
    chapter: pageSlug(weaving.catalogue, module.path),
    section: '',
  })

const buildBlocks = (module: LoomModule, weaving: Weaving): ReadonlyArray<WovenBlock> => [
  ...leadingBlocks(module, weaving),
  ...module.doc.sections.flatMap(sectionBlocks(module, weaving)),
]

const sectionSource = (module: LoomModule, weaving: Weaving, section: LoomSection): SourceAnchor =>
  ({
    chapter: pageSlug(weaving.catalogue, module.path),
    section: slugify(titleSource(section)),
  })

const sectionBlocks =
  (module: LoomModule, weaving: Weaving) =>
  (section: LoomSection): ReadonlyArray<WovenBlock> => {
    const source = sectionSource(module, weaving, section)
    const runs = splitRuns(sectionBody(section))
    return [
      headingBlock(module, weaving, section, source),
      ...runs.flatMap((run, index) =>
        runBlocks(module, weaving, section, source)(run, tildeOpens(Array.get(runs, index + 1))),
      ),
    ]
  }

const titleSource = (section: LoomSection): string => section.heading.title?.source ?? ''

const levelOf = byTypeOr<LoomSection['heading']['marker']>()<number>(
  { Divider: () => 2 },
  (marker) => Math.max(1, marker.source.replace(/[^#]/g, '').length),
)

const headingLevel = (section: LoomSection): number => levelOf(section.heading.marker)

const headingBlock = (
  module: LoomModule,
  weaving: Weaving,
  section: LoomSection,
  source: SourceAnchor,
): WovenBlock =>
  nodeOf(HeadingBlockSchema, {
    source,
    level: headingLevel(section),
    title: titleSource(section),
    id: slugify(titleSource(section)),
    unsettled: weaving.sections.has(keyOf({ path: module.path, name: sectionNameOf(section) })),
    divider: section.heading.marker.type === 'Divider',
  })

type BodyWeft = PreambleWeft | SectionBodyWeft

type Piece = {
  readonly start: number
  readonly end: number
  readonly blank: boolean
}

const sectionBody = (section: LoomSection): ReadonlyArray<BodyWeft> => [
  ...section.preamble,
  ...section.code,
]

const isMarker = (weft: BodyWeft): boolean => weft.type === 'ArrowWeft' || weft.type === 'TildeWeft'

const closesFenced = (weft: BodyWeft): boolean => weft.type === 'FenceWeft' && weft.side === 'close'

const startsRun = (wefts: ReadonlyArray<BodyWeft>, at: number): boolean =>
  Option.exists(Array.get(wefts, at), isMarker) ||
  Option.exists(Array.get(wefts, at - 1), closesFenced)

const splitRuns = (body: ReadonlyArray<BodyWeft>): ReadonlyArray<ReadonlyArray<BodyWeft>> =>
  Array.chop(body, (wefts) => {
    const end = pipe(
      Array.findFirstIndex(Array.drop(wefts, 1), (_, at) => startsRun(wefts, at + 1)),
      Option.map((at) => at + 1),
      Option.getOrElse(() => wefts.length),
    )
    return [Array.take(wefts, end), Array.drop(wefts, end)]
  })

const tildeOpens = (run: Option.Option<ReadonlyArray<BodyWeft>>): boolean =>
  pipe(
    run,
    Option.flatMap(Array.head),
    Option.exists((weft) => weft.type === 'TildeWeft'),
  )

const markerInline: (marker: BodyWeft) => Option.Option<Piece> = byTypeOr<BodyWeft>()(
  {
    ArrowWeft: (a) =>
      Option.map(Option.fromNullishOr(a.code), (code) => ({
        start: code.position.start.offset,
        end: a.position.end.offset,
        blank: false,
      })),
    TildeWeft: (t) =>
      Option.map(Option.fromNullishOr(t.prose), (prose) => ({
        start: prose.position.start.offset,
        end: t.position.end.offset,
        blank: false,
      })),
  },
  () => Option.none<Piece>(),
)

const pieceOfWeft = (weft: BodyWeft): Piece => ({
  start: weft.position.start.offset,
  end: weft.position.end.offset,
  blank: weft.type === 'FenceWeft' || isBlankSource(weft.source),
})

const runSpan = (run: ReadonlyArray<BodyWeft>): Option.Option<Span> => {
  const pieces = run.flatMap((weft, index) =>
    index === 0 && isMarker(weft) ? Option.toArray(markerInline(weft)) : [pieceOfWeft(weft)],
  )
  const kept = pieces.filter((piece) => !piece.blank)
  return Array.isReadonlyArrayNonEmpty(kept)
    ? Option.some({
        start: Array.headNonEmpty(kept).start,
        end: Array.lastNonEmpty(kept).end,
      })
    : Option.none()
}

const codeLanguage = (module: LoomModule, section: LoomSection): string => {
  const frontmatter = Option.fromNullishOr(module.doc.frontmatter)
  return sectionLanguage(
    section,
    pipe(
      frontmatter,
      Option.flatMapNullishOr((f) => f.language),
      Option.map((language) => language.value.trim().toLowerCase()),
      Option.getOrElse(() => 'plaintext'),
    ),
    pipe(
      frontmatter,
      Option.flatMapNullishOr((f) => f.package),
      Option.map((pkg) => pkg.value),
    ),
  )
}

type Stretch = { readonly note: boolean; readonly wefts: ReadonlyArray<BodyWeft> }

const opensNote = (weft: BodyWeft): boolean =>
  Option.exists(boxOf(weft), (box) => box.side === 'open' && boxKind(box) === noteKind)

const closesBox = (weft: BodyWeft): boolean =>
  Option.exists(boxOf(weft), (box) => box.side === 'close')

const stretchEnd = (wefts: ReadonlyArray<BodyWeft>, note: boolean): number =>
  note
    ? pipe(
        Array.findFirstIndex(wefts, (weft, at) => at > 0 && closesBox(weft)),
        Option.map((at) => at + 1),
        Option.getOrElse(() => wefts.length),
      )
    : pipe(
        Array.findFirstIndex(wefts, (weft, at) => at > 0 && opensNote(weft)),
        Option.getOrElse(() => wefts.length),
      )

const stretchesOf = (run: ReadonlyArray<BodyWeft>): ReadonlyArray<Stretch> =>
  Array.chop(run, (wefts) => {
    const note = opensNote(Array.headNonEmpty(wefts))
    const end = stretchEnd(wefts, note)
    return [{ note, wefts: Array.take(wefts, end) }, Array.drop(wefts, end)]
  })

const captionOfNote = (note: ReadonlyArray<BodyWeft>): Option.Option<string> =>
  pipe(
    Array.head(note),
    Option.flatMap(boxOf),
    Option.flatMapNullishOr((box) => box.name),
    Option.map((name) => name.value),
  )

const bodyOf = (note: ReadonlyArray<BodyWeft>): ReadonlyArray<BodyWeft> => {
  const inside = Array.drop(note, 1)
  return Option.exists(Array.last(inside), closesBox) ? Array.dropRight(inside, 1) : inside
}

const textOf = (module: LoomModule, wefts: ReadonlyArray<BodyWeft>): string =>
  Option.match(runSpan(wefts), {
    onNone: () => '',
    onSome: (span) => sliceContent(module.text, span).trim(),
  })

const proseBlockOf = (
  module: LoomModule,
  weaving: Weaving,
  wefts: ReadonlyArray<BodyWeft>,
  source: SourceAnchor,
): ReadonlyArray<WovenBlock> =>
  Option.match(runSpan(wefts), {
    onNone: (): ReadonlyArray<WovenBlock> => [],
    onSome: (span) => {
      const raw = sliceContent(module.text, span)
      const markdown = raw.trim()
      const start = span.start + raw.length - raw.trimStart().length
      const recognised = recognisedWithin(module, weaving, span, start)
      return markdown.length === 0
        ? []
        : [
            nodeOf(ProseBlockSchema, {
              source,
              markdown,
              links: Array.getSomes(
                anchorsWithin(wefts, span).map((anchor) =>
                  resolveLink(module, weaving, start, anchor),
                ),
              ),
              ...(recognised.length === 0 ? {} : { recognised }),
            }),
          ]
    },
  })

const recognisedWithin = (
  module: LoomModule,
  weaving: Weaving,
  span: Span,
  blockStart: number,
): ReadonlyArray<RecognisedWord> =>
  Option.getOrElse(
    Option.fromNullishOr(weaving.recognised.get(module.path)),
    (): ReadonlyArray<Recognised> => [],
  )
    .filter(
      ({ word }) =>
        word.position.start.offset >= span.start && word.position.end.offset <= span.end,
    )
    .map(({ word, concept }): RecognisedWord => ({
      offset: word.position.start.offset - blockStart,
      length: word.position.end.offset - word.position.start.offset,
      concept: concept.name.source,
      definition: concept.definition,
    }))

const proseBlocks = (
  module: LoomModule,
  weaving: Weaving,
  run: ReadonlyArray<BodyWeft>,
  source: SourceAnchor,
): ReadonlyArray<WovenBlock> =>
  stretchesOf(run).flatMap((stretch) =>
    stretch.note
      ? [
          nodeOf(NoteBlockSchema, {
            source,
            caption: Option.getOrUndefined(captionOfNote(stretch.wefts)),
            markdown: textOf(module, bodyOf(stretch.wefts)),
          }),
        ]
      : proseBlockOf(module, weaving, stretch.wefts, source),
  )

const codeBlock = (
  module: LoomModule,
  weaving: Weaving,
  section: LoomSection,
  source: SourceAnchor,
  run: ReadonlyArray<BodyWeft>,
  span: Span,
  arrow: string,
  closed: boolean,
): WovenBlock =>
  nodeOf(CodeBlockSchema, {
    source,
    language: codeLanguage(module, section),
    code: sliceContent(module.text, span),
    arrow,
    closed,
    links: Array.getSomes(
      anchorsWithin(run, span).map((anchor) => resolveLink(module, weaving, span.start, anchor)),
    ),
    unsettled: anchorsWithin(run, span)
      .filter((anchor) => weaving.anchors.has(anchorKey(module.path, anchor.name.position)))
      .map((anchor): UnsettledSpan => ({
        offset: anchor.position.start.offset - span.start,
        length: anchor.position.end.offset - anchor.position.start.offset,
      })),
  })

const anchorsWithin = (run: ReadonlyArray<BodyWeft>, span: Span): ReadonlyArray<WarpAnchorToken> =>
  run
    .flatMap((weft) => weft.anchors)
    .filter(
      (anchor) =>
        anchor.position.start.offset >= span.start && anchor.position.end.offset <= span.end,
    )

const isDiscussion = (module: LoomModule): boolean =>
  module.doc.frontmatter?.discussion !== undefined

const messageBlock = (tilde: TildeWeft, source: SourceAnchor): WovenBlock =>
  nodeOf(MessageBlockSchema, {
    source,
    author: Option.getOrUndefined(
      Option.map(Option.fromNullishOr(tilde.prose), (name) => name.source.trim()),
    ),
  })

const blocksOpenedBy = byTypeOr<
  BodyWeft,
  [
    within: {
      readonly module: LoomModule
      readonly weaving: Weaving
      readonly section: LoomSection
      readonly source: SourceAnchor
      readonly run: ReadonlyArray<BodyWeft>
      readonly span: Span
      readonly closed: boolean
    },
  ]
>()<ReadonlyArray<WovenBlock>>(
  {
    ArrowWeft: (opened, { module, weaving, section, source, run, span, closed }) => [
      codeBlock(
        module,
        weaving,
        section,
        source,
        run,
        span,
        opened.arrow.source.trim(),
        closed,
      ),
    ],
  },
  (_first, { module, weaving, source, run }) =>
    proseBlocks(module, weaving, run, source),
)

const runBlocks =
  (module: LoomModule, weaving: Weaving, section: LoomSection, source: SourceAnchor) =>
  (run: ReadonlyArray<BodyWeft>, closed: boolean): ReadonlyArray<WovenBlock> =>
    Array.matchLeft(run, {
      onEmpty: (): ReadonlyArray<WovenBlock> => [],
      onNonEmpty: (first, rest) =>
        first.type === 'TildeWeft' && isDiscussion(module)
          ? [messageBlock(first, source), ...proseBlocks(module, weaving, rest, source)]
          : Option.match(runSpan(run), {
              onNone: (): ReadonlyArray<WovenBlock> => [],
              onSome: (span) =>
                blocksOpenedBy(first, { module, weaving, section, source, run, span, closed }),
            }),
    })

const wordOf = (name: string, concept: ConceptRef): string => {
  const last = name.slice(name.lastIndexOf(',') + 1).trim()
  return conceptNames(concept).some((form) => foldFirst(form) === foldFirst(last)) ? last : name
}

const resolveLink = (
  module: LoomModule,
  weaving: Weaving,
  blockStart: number,
  anchor: WarpAnchorToken,
): Option.Option<AnchorLink> =>
  pipe(
    resolveAnchor(weaving.catalogue, module.path, anchor),
    Option.flatMap((ref) =>
      Option.map(Option.fromNullishOr(ref.section.heading.title), (title): AnchorLink => {
        const concept = conceptAt(weaving.catalogue, ref)
        return {
          name: Option.match(concept, {
            onNone: () => anchor.name.value,
            onSome: (found) => wordOf(anchor.name.value, found),
          }),
          targetSlug: pageSlug(weaving.catalogue, ref.module),
          targetId: slugify(title.source),
          offset: anchor.position.start.offset - blockStart,
          length: anchor.position.end.offset - anchor.position.start.offset,
          title: Option.getOrUndefined(
            pipe(
              concept,
              Option.map((found) => found.definition),
              Option.filter((definition) => definition !== ''),
            ),
          ),
        }
      }),
    ),
  )

export const indexHeading = 'Index'

const indexSlug = (book: string): string => (book === '' ? 'index' : `${slugify(book)}/index`)

const bookNameOf = (weaving: Weaving, path: Location): string =>
  Option.getOrElse(
    Option.flatMap(Option.fromNullishOr(weaving.catalogue.modules.get(path)), bookOf),
    () => '',
  )

const byConceptName: Order.Order<ConceptRef> = Order.mapInput(Order.String, (concept: ConceptRef) =>
  concept.name.source.toLowerCase(),
)

type Phrase = {
  readonly text: string
  readonly target: Option.Option<{ readonly slug: string; readonly id: string }>
}

const linkedBlock = (source: SourceAnchor, pieces: ReadonlyArray<Phrase>): WovenBlock =>
  nodeOf(ProseBlockSchema, {
    source,
    markdown: pieces.map((piece) => piece.text).join(''),
    links: Array.getSomes(
      Array.mapAccum(pieces, 0, (at, piece) => [
        at + piece.text.length,
        Option.map(piece.target, (target): AnchorLink =>
          ({
            name: piece.text,
            targetSlug: target.slug,
            targetId: target.id,
            offset: at,
            length: piece.text.length,
          }),
        ),
      ])[1],
    ),
  })

type Use = { readonly module: LoomModule; readonly section: Option.Option<LoomSection> }

const conceptKey = (module: Location, section: LoomSection): string =>
  `${module}#${section.position.start.offset}`

const startOf = (use: Use): number =>
  Option.match(use.section, {
    onNone: () => 0,
    onSome: (section) => section.position.start.offset,
  })

const byUse = (weaving: Weaving): Order.Order<Use> =>
  Order.combineAll([
    Order.mapInput(Order.String, (use: Use) => pageSlug(weaving.catalogue, use.module.path)),
    Order.mapInput(Order.Number, startOf),
  ])

type Passage = {
  readonly section: Option.Option<LoomSection>
  readonly links: ReadonlyArray<WarpAnchorToken>
  readonly span: Span
}

const passagesOf = (module: LoomModule): ReadonlyArray<Passage> => [
  {
    section: Option.none(),
    links: module.doc.preamble.flatMap((line) => line.anchors),
    span: {
      start: 0,
      end: Option.match(Array.head(module.doc.sections), {
        onNone: () => module.text.length,
        onSome: (first) => first.position.start.offset,
      }),
    },
  },
  ...module.doc.sections.map((section): Passage => ({
    section: Option.some(section),
    links: sectionLinksOf(section),
    span: { start: section.position.start.offset, end: section.position.end.offset },
  })),
]

const conceptsRecognisedIn = (
  weaving: Weaving,
  module: LoomModule,
  span: Span,
): ReadonlyArray<ConceptRef> =>
  Option.getOrElse(
    Option.fromNullishOr(weaving.recognised.get(module.path)),
    (): ReadonlyArray<Recognised> => [],
  )
    .filter(
      ({ word }) =>
        word.position.start.offset >= span.start && word.position.end.offset <= span.end,
    )
    .map(({ concept }) => concept)

const usesByConcept = (
  weaving: Weaving,
  modules: ReadonlyArray<LoomModule>,
): ReadonlyMap<string, ReadonlyArray<Use>> => {
  const pairs = Array.sort(
    modules.flatMap((module) =>
      passagesOf(module).flatMap((passage) =>
        pipe(
          [
            ...passage.links.flatMap((link) =>
              Option.toArray(
                Option.flatMap(resolveAnchor(weaving.catalogue, module.path, link), (ref) =>
                  conceptAt(weaving.catalogue, ref),
                ),
              ),
            ),
            ...conceptsRecognisedIn(weaving, module, passage.span),
          ].map((concept) => conceptKey(concept.module, concept.section)),
          Array.dedupe,
          Array.map((key) => ({ key, use: { module, section: passage.section } })),
        ),
      ),
    ),
    Order.mapInput(byUse(weaving), (pair: { readonly use: Use }) => pair.use),
  )
  return new Map(
    Object.entries(Array.groupBy(pairs, (pair) => pair.key)).map(
      ([key, found]) => [key, found.map((pair) => pair.use)] as const,
    ),
  )
}

const placeOf = (weaving: Weaving, use: Use): Phrase => {
  const slug = pageSlug(weaving.catalogue, use.module.path)
  return Option.match(use.section, {
    onNone: (): Phrase => ({ text: titleOf(use.module), target: Option.some({ slug, id: '' }) }),
    onSome: (section): Phrase => ({
      text: titleSource(section),
      target: Option.some({ slug, id: slugify(titleSource(section)) }),
    }),
  })
}

const entryBlocks = (
  weaving: Weaving,
  modules: ReadonlyArray<LoomModule>,
  usesOf: ReadonlyMap<string, ReadonlyArray<Use>>,
  slug: string,
  concept: ConceptRef,
): ReadonlyArray<WovenBlock> => {
  const id = slugify(concept.name.source)
  const source: SourceAnchor = { chapter: slug, section: id }
  const forms = concept.forms.map((form) => form.value)
  const home = Array.findFirst(modules, (module) => module.path === concept.module)
  const uses = Option.getOrElse(
    Option.fromNullishOr(usesOf.get(conceptKey(concept.module, concept.section))),
    (): ReadonlyArray<Use> => [],
  )
  return [
    nodeOf(HeadingBlockSchema, {
      source,
      level: 2,
      title: concept.name.source,
      id,
      unsettled: false,
      divider: false,
    }),
    ...Option.match(home, {
      onNone: (): ReadonlyArray<WovenBlock> => [],
      onSome: (module) => proseBlockOf(module, weaving, definitionLinesOf(concept.section), source),
    }),
    ...(forms.length === 0
      ? []
      : [
          nodeOf(ProseBlockSchema, {
            source,
            markdown: `Also: ${forms.join(', ')}.`,
            links: [],
          }),
        ]),
    linkedBlock(source, [
      { text: 'Defined in ', target: Option.none() },
      ...Option.match(home, {
        onNone: (): ReadonlyArray<Phrase> => [{ text: concept.name.source, target: Option.none() }],
        onSome: (module): ReadonlyArray<Phrase> => [
          {
            text: titleOf(module),
            target: Option.some({ slug: pageSlug(weaving.catalogue, module.path), id }),
          },
        ],
      }),
      { text: '.', target: Option.none() },
      ...(uses.length === 0
        ? []
        : [
            { text: ' Used in ', target: Option.none() },
            ...uses.flatMap((use, at): ReadonlyArray<Phrase> => [
              ...(at === 0 ? [] : [{ text: ', ', target: Option.none() }]),
              placeOf(weaving, use),
            ]),
            { text: '.', target: Option.none() },
          ]),
    ]),
  ]
}

const indexPageOf = (
  weaving: Weaving,
  modules: ReadonlyArray<LoomModule>,
  usesOf: ReadonlyMap<string, ReadonlyArray<Use>>,
  book: string,
): Option.Option<WovenPage> => {
  const slug = indexSlug(book)
  return pipe(
    weaving.catalogue.concepts.filter((concept) => bookNameOf(weaving, concept.module) === book),
    Array.sort(byConceptName),
    Option.liftPredicate(Array.isReadonlyArrayNonEmpty),
    Option.map((concepts): WovenPage => ({
      slug,
      title: indexHeading,
      part: backMatterHeading,
      book: book === '' ? undefined : book,
      blocks: [
        nodeOf(HeadingBlockSchema, {
          source: { chapter: slug, section: 'index' },
          level: 1,
          title: indexHeading,
          id: 'index',
          unsettled: false,
          divider: false,
        }),
        ...concepts.flatMap((concept) => entryBlocks(weaving, modules, usesOf, slug, concept)),
      ],
    })),
  )
}
