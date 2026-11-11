import { Array, Context, Effect, Layer, Match, Option, Order, pipe } from 'effect'
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
  type ConceptRef,
  definitionLinesOf,
  isBookLoom,
  type Location,
  type LoomCorpusAst,
  type LoomModule,
  resolveAnchor,
  sectionLinksOf,
} from '@athrio/loom-ast/LoomCorpusAst'
import { type Position } from '@athrio/loom-ast/LoomNode'
import { keyOf } from '@athrio/loom-ast/ProductAst'
import { sectionNameOf } from '#ast/ProductBuilder'
import { unsettledRef } from '#ast/LoomVirtualCodeBuilder'
import {
  type AnchorLink,
  AnchorLinkSchema,
  CodeBlockSchema,
  HeadingBlockSchema,
  MessageBlockSchema,
  NoteBlockSchema,
  ProseBlockSchema,
  type SourceAnchor,
  SourceAnchorSchema,
  UnsettledSpanSchema,
  type WovenBlock,
  type WovenBook,
  WovenBookSchema,
  type WovenCorpus,
  WovenCorpusSchema,
  type WovenNavEntry,
  WovenNavEntrySchema,
  type WovenPage,
  WovenPageSchema,
  type WovenPart,
  WovenPartSchema,
} from './WovenCorpus'
import {
  backMatterHeading,
  buildContents,
  orphansHeading,
  type TocBackMatter,
  type TocBook,
  type TocChapter,
  type TocDiscussion,
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
  const uses = usesByConcept(weaving, modules, root)
  const indexes = Array.getSomes(
    Array.map(contents.books, (book) => indexPageOf(weaving, modules, uses, book.name)),
  )
  const indexOf = (book: string): Option.Option<WovenNavEntry> =>
    Option.map(
      Array.findFirst(indexes, (page) => page.slug === indexSlug(book)),
      (page) => WovenNavEntrySchema.make({ number: '', title: page.title, slug: page.slug }),
    )
  const nav = Option.getOrElse(
    Option.map(
      Array.findFirst(contents.books, (book) => book.name === ''),
      (book) => bookNav(slugOf, book, indexOf(book.name)),
    ),
    (): ReadonlyArray<WovenPart> => [],
  )
  const books = Array.map(
    Array.filter(contents.books, (book) => book.name !== ''),
    wovenBook(slugOf, indexOf),
  )
  const partOfSlug = partIndex([...nav, ...Array.flatMap(books, (book) => book.nav)])
  const pages = pipe(
    [
      ...Array.getSomes(
        Array.map(modules, (module) => buildPage(module, weaving, partOfSlug, root)),
      ),
      ...indexes,
    ],
    Array.sort(inReadingOrder(readingOrderOf(nav, books))),
  )
  return WovenCorpusSchema.make({ nav, books: pagedBooks(books, pages), pages })
}

const pagedBooks = (
  books: ReadonlyArray<WovenBook>,
  pages: ReadonlyArray<WovenPage>,
): ReadonlyArray<WovenBook> =>
  Array.map(books, (book) =>
    Array.some(pages, (page) => page.slug === book.slug)
      ? book
      : WovenBookSchema.make({ ...book, slug: '' }),
  )

type Weaving = {
  readonly catalogue: Catalogue
  readonly anchors: ReadonlySet<string>
  readonly sections: ReadonlySet<string>
}

const anchorKey = (path: Location, at: Position): string => `${path}#${at.start.offset}`

const weavingOf = (modules: ReadonlyMap<Location, LoomModule>): Weaving => {
  const catalogue = catalogueOf(modules)
  const unsettled = pipe(
    Array.fromIterable(modules.values()),
    Array.flatMap((module) =>
      Array.flatMap(module.product.code, (code) =>
        Array.getSomes(
          Array.map(code.fragments, (part) =>
            part.type === 'NameRef'
              ? unsettledRef(modules, catalogue, module.path, part)
              : Option.none(),
          ),
        ),
      ),
    ),
  )
  return {
    catalogue,
    anchors: new Set(Array.map(unsettled, (one) => anchorKey(one.path, one.anchor))),
    sections: new Set(
      Array.flatMap(unsettled, (one) => Option.toArray(Option.map(one.section, keyOf))),
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
    WovenNavEntrySchema.make({
      number: chapter.number,
      title: chapter.title,
      slug: slugOf(chapter.path),
      status: chapter.status,
      priority: chapter.priority,
      language: chapter.language,
    })

const wovenPart =
  (slugOf: SlugOf) =>
  (part: TocPart): WovenPart =>
    WovenPartSchema.make({
      number: part.number,
      name: part.name,
      chapters: Array.map(part.chapters, wovenEntry(slugOf)),
    })

const wovenDiscussion =
  (slugOf: SlugOf) =>
  (discussion: TocDiscussion): WovenNavEntry =>
    WovenNavEntrySchema.make({
      number: '',
      title: discussion.title,
      slug: slugOf(discussion.path),
    })

const orphansPart = (
  slugOf: SlugOf,
  orphans: ReadonlyArray<TocChapter>,
): ReadonlyArray<WovenPart> =>
  orphans.length === 0
    ? []
    : [
        WovenPartSchema.make({
          number: '',
          name: orphansHeading,
          chapters: Array.map(orphans, wovenEntry(slugOf)),
        }),
      ]

const backMatterPart = (
  slugOf: SlugOf,
  backMatter: TocBackMatter,
  index: Option.Option<WovenNavEntry>,
): ReadonlyArray<WovenPart> => {
  const entries = [
    ...Array.map(backMatter.discussions, wovenDiscussion(slugOf)),
    ...Option.toArray(index),
  ]
  return entries.length === 0
    ? []
    : [WovenPartSchema.make({ number: '', name: backMatterHeading, chapters: entries })]
}

const bookNav = (
  slugOf: SlugOf,
  book: TocBook,
  index: Option.Option<WovenNavEntry>,
): ReadonlyArray<WovenPart> => [
  ...Array.map(book.parts, wovenPart(slugOf)),
  ...orphansPart(slugOf, book.orphans),
  ...backMatterPart(slugOf, book.backMatter, index),
]

const wovenBook =
  (slugOf: SlugOf, indexOf: (book: string) => Option.Option<WovenNavEntry>) =>
  (book: TocBook): WovenBook =>
    WovenBookSchema.make({
      name: book.name,
      slug: book.path === '' ? '' : slugOf(book.path),
      nav: bookNav(slugOf, book, indexOf(book.name)),
    })

const partIndex = (nav: ReadonlyArray<WovenPart>): ReadonlyMap<string, string> =>
  new Map(
    Array.flatMap(nav, (part) =>
      Array.map(part.chapters, (chapter) => [chapter.slug, part.name] as const),
    ),
  )

const slugsOf = (nav: ReadonlyArray<WovenPart>): ReadonlyArray<string> =>
  Array.flatMap(nav, (part) => Array.map(part.chapters, (chapter) => chapter.slug))

const readingOrderOf = (
  nav: ReadonlyArray<WovenPart>,
  books: ReadonlyArray<WovenBook>,
): ReadonlyMap<string, number> =>
  new Map(
    Array.map(
      [
        ...slugsOf(nav),
        ...Array.flatMap(books, (book) => [
          ...(book.slug === '' ? [] : [book.slug]),
          ...slugsOf(book.nav),
        ]),
      ],
      (slug, at) => [slug, at] as const,
    ),
  )

const inReadingOrder = (order: ReadonlyMap<string, number>): Order.Order<WovenPage> =>
  Order.combineAll([
    Order.mapInput(Order.Number, (page: WovenPage) =>
      Option.getOrElse(Option.fromNullishOr(order.get(page.slug)), () => order.size),
    ),
    Order.mapInput(Order.String, (page: WovenPage) => page.slug),
  ])

const isCorpusLoom = (module: LoomModule, root: Location | undefined): boolean =>
  module.path === root && module.doc.frontmatter === undefined

const firstHeadingTitle = (module: LoomModule): Option.Option<string> =>
  pipe(
    Array.findFirst(module.doc.sections, (section) => section.heading.title !== undefined),
    Option.flatMap((section) => Option.fromNullishOr(section.heading.title)),
    Option.map((title) => title.source),
  )

const chapterTitleOf = (module: LoomModule): Option.Option<string> =>
  Option.orElse(
    Option.map(Option.fromNullishOr(module.doc.frontmatter?.title), (title) => title.value),
    () => firstHeadingTitle(module),
  )

const buildPage = (
  module: LoomModule,
  weaving: Weaving,
  partOfSlug: ReadonlyMap<string, string>,
  root: Location | undefined,
): Option.Option<WovenPage> =>
  isCorpusLoom(module, root)
    ? Option.none()
    : Option.map(chapterTitleOf(module), (title): WovenPage => {
        const slug = pageSlug(weaving.catalogue, module.path)
        return WovenPageSchema.make({
          slug,
          title,
          part: partOfSlug.get(slug),
          book: Option.getOrUndefined(bookOf(module)),
          frontmatter: module.doc.frontmatter?.source,
          blocks: buildBlocks(module, weaving),
        })
      })

const buildBlocks = (module: LoomModule, weaving: Weaving): ReadonlyArray<WovenBlock> =>
  Array.flatMap(module.doc.sections, sectionBlocks(module, weaving))

const sectionSource = (module: LoomModule, weaving: Weaving, section: LoomSection): SourceAnchor =>
  SourceAnchorSchema.make({
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
      ...Array.flatMap(runs, (run, index) =>
        runBlocks(module, weaving, section, source)(run, tildeOpens(Array.get(runs, index + 1))),
      ),
    ]
  }

const titleSource = (section: LoomSection): string => section.heading.title?.source ?? ''

const headingLevel = (section: LoomSection): number =>
  Match.value(section.heading.marker).pipe(
    Match.when({ type: 'Divider' }, () => 2),
    Match.orElse((marker) => Math.max(1, marker.source.replace(/[^#]/g, '').length)),
  )

const headingBlock = (
  module: LoomModule,
  weaving: Weaving,
  section: LoomSection,
  source: SourceAnchor,
): WovenBlock =>
  HeadingBlockSchema.make({
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

const markerInline = (marker: BodyWeft): Option.Option<Piece> =>
  Match.value(marker).pipe(
    Match.when({ type: 'ArrowWeft' }, (a) =>
      Option.map(Option.fromNullishOr(a.code), (code) => ({
        start: code.position.start.offset,
        end: marker.position.end.offset,
        blank: false,
      })),
    ),
    Match.when({ type: 'TildeWeft' }, (t) =>
      Option.map(Option.fromNullishOr(t.prose), (prose) => ({
        start: prose.position.start.offset,
        end: marker.position.end.offset,
        blank: false,
      })),
    ),
    Match.orElse(() => Option.none<Piece>()),
  )

const pieceOfWeft = (weft: BodyWeft): Piece => ({
  start: weft.position.start.offset,
  end: weft.position.end.offset,
  blank: weft.type === 'FenceWeft' || isBlankSource(weft.source),
})

const runSpan = (run: ReadonlyArray<BodyWeft>): Option.Option<Span> => {
  const pieces = Array.flatMap(run, (weft, index) =>
    index === 0 && isMarker(weft) ? Option.toArray(markerInline(weft)) : [pieceOfWeft(weft)],
  )
  const kept = Array.filter(pieces, (piece) => !piece.blank)
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
      return markdown.length === 0
        ? []
        : [
            ProseBlockSchema.make({
              source,
              markdown,
              links: Array.getSomes(
                Array.map(anchorsWithin(wefts, span), (anchor) =>
                  resolveLink(module, weaving, start, anchor),
                ),
              ),
            }),
          ]
    },
  })

const proseBlocks = (
  module: LoomModule,
  weaving: Weaving,
  run: ReadonlyArray<BodyWeft>,
  source: SourceAnchor,
): ReadonlyArray<WovenBlock> =>
  Array.flatMap(stretchesOf(run), (stretch) =>
    stretch.note
      ? [
          NoteBlockSchema.make({
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
  CodeBlockSchema.make({
    source,
    language: codeLanguage(module, section),
    code: sliceContent(module.text, span),
    arrow,
    closed,
    links: Array.getSomes(
      Array.map(anchorsWithin(run, span), (anchor) =>
        resolveLink(module, weaving, span.start, anchor),
      ),
    ),
    unsettled: pipe(
      anchorsWithin(run, span),
      Array.filter((anchor) => weaving.anchors.has(anchorKey(module.path, anchor.name.position))),
      Array.map((anchor) =>
        UnsettledSpanSchema.make({
          offset: anchor.position.start.offset - span.start,
          length: anchor.position.end.offset - anchor.position.start.offset,
        }),
      ),
    ),
  })

const anchorsWithin = (run: ReadonlyArray<BodyWeft>, span: Span): ReadonlyArray<WarpAnchorToken> =>
  Array.filter(
    Array.flatMap(run, (weft) => weft.anchors),
    (anchor) =>
      anchor.position.start.offset >= span.start && anchor.position.end.offset <= span.end,
  )

const isDiscussion = (module: LoomModule): boolean =>
  module.doc.frontmatter?.discussion !== undefined

const messageBlock = (tilde: TildeWeft, source: SourceAnchor): WovenBlock =>
  MessageBlockSchema.make({
    source,
    author: Option.getOrUndefined(
      Option.map(Option.fromNullishOr(tilde.prose), (name) => name.source.trim()),
    ),
  })

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
                Match.value(first).pipe(
                  Match.withReturnType<ReadonlyArray<WovenBlock>>(),
                  Match.when({ type: 'ArrowWeft' }, (opened) => [
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
                  ]),
                  Match.orElse(() => proseBlocks(module, weaving, run, source)),
                ),
            }),
    })

const resolveLink = (
  module: LoomModule,
  weaving: Weaving,
  blockStart: number,
  anchor: WarpAnchorToken,
): Option.Option<AnchorLink> =>
  pipe(
    resolveAnchor(weaving.catalogue, module.path, anchor),
    Option.flatMap((ref) =>
      Option.map(Option.fromNullishOr(ref.section.heading.title), (title): AnchorLink =>
        AnchorLinkSchema.make({
          name: anchor.name.value,
          targetSlug: pageSlug(weaving.catalogue, ref.module),
          targetId: slugify(title.source),
          offset: anchor.position.start.offset - blockStart,
          length: anchor.position.end.offset - anchor.position.start.offset,
          title: Option.getOrUndefined(
            pipe(
              conceptAt(weaving.catalogue, ref),
              Option.map((concept) => concept.definition),
              Option.filter((definition) => definition !== ''),
            ),
          ),
        }),
      ),
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
  ProseBlockSchema.make({
    source,
    markdown: Array.join(
      Array.map(pieces, (piece) => piece.text),
      '',
    ),
    links: Array.getSomes(
      Array.mapAccum(pieces, 0, (at, piece) => [
        at + piece.text.length,
        Option.map(piece.target, (target) =>
          AnchorLinkSchema.make({
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

type Use = { readonly module: LoomModule; readonly section: LoomSection }

const conceptKey = (module: Location, section: LoomSection): string =>
  `${module}#${section.position.start.offset}`

const byUse = (weaving: Weaving): Order.Order<Use> =>
  Order.combineAll([
    Order.mapInput(Order.String, (use: Use) => pageSlug(weaving.catalogue, use.module.path)),
    Order.mapInput(Order.Number, (use: Use) => use.section.position.start.offset),
  ])

const usesByConcept = (
  weaving: Weaving,
  modules: ReadonlyArray<LoomModule>,
  root: Location | undefined,
): ReadonlyMap<string, ReadonlyArray<Use>> => {
  const pairs = pipe(
    Array.filter(modules, (module) => module.path !== root),
    Array.flatMap((module) =>
      Array.flatMap(module.doc.sections, (section) =>
        pipe(
          sectionLinksOf(section),
          Array.flatMap((link) =>
            Option.toArray(
              Option.flatMap(resolveAnchor(weaving.catalogue, module.path, link), (ref) =>
                conceptAt(weaving.catalogue, ref),
              ),
            ),
          ),
          Array.map((concept) => conceptKey(concept.module, concept.section)),
          Array.dedupe,
          Array.map((key) => ({ key, use: { module, section } })),
        ),
      ),
    ),
    Array.sort(Order.mapInput(byUse(weaving), (pair: { readonly use: Use }) => pair.use)),
  )
  return new Map(
    Object.entries(Array.groupBy(pairs, (pair) => pair.key)).map(
      ([key, found]) => [key, Array.map(found, (pair) => pair.use)] as const,
    ),
  )
}

const placeOf = (weaving: Weaving, use: Use): Phrase => ({
  text: titleSource(use.section),
  target: Option.some({
    slug: pageSlug(weaving.catalogue, use.module.path),
    id: slugify(titleSource(use.section)),
  }),
})

const entryBlocks = (
  weaving: Weaving,
  modules: ReadonlyArray<LoomModule>,
  usesOf: ReadonlyMap<string, ReadonlyArray<Use>>,
  slug: string,
  concept: ConceptRef,
): ReadonlyArray<WovenBlock> => {
  const id = slugify(concept.name.source)
  const source = SourceAnchorSchema.make({ chapter: slug, section: id })
  const forms = Array.map(concept.forms, (form) => form.value)
  const home = Array.findFirst(modules, (module) => module.path === concept.module)
  const uses = Option.getOrElse(
    Option.fromNullishOr(usesOf.get(conceptKey(concept.module, concept.section))),
    (): ReadonlyArray<Use> => [],
  )
  return [
    HeadingBlockSchema.make({
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
          ProseBlockSchema.make({
            source,
            markdown: `Also: ${Array.join(forms, ', ')}.`,
            links: [],
          }),
        ]),
    linkedBlock(source, [
      { text: 'Defined in ', target: Option.none() },
      ...Option.match(home, {
        onNone: (): ReadonlyArray<Phrase> => [{ text: concept.name.source, target: Option.none() }],
        onSome: (module): ReadonlyArray<Phrase> => [
          {
            text: Option.getOrElse(chapterTitleOf(module), () => concept.name.source),
            target: Option.some({ slug: pageSlug(weaving.catalogue, module.path), id }),
          },
        ],
      }),
      { text: '.', target: Option.none() },
      ...(uses.length === 0
        ? []
        : [
            { text: ' Used in ', target: Option.none() },
            ...Array.flatMap(uses, (use, at): ReadonlyArray<Phrase> => [
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
    Array.filter(
      weaving.catalogue.concepts,
      (concept) => bookNameOf(weaving, concept.module) === book,
    ),
    Array.sort(byConceptName),
    Option.liftPredicate(Array.isReadonlyArrayNonEmpty),
    Option.map((concepts) =>
      WovenPageSchema.make({
        slug,
        title: indexHeading,
        part: backMatterHeading,
        book: book === '' ? undefined : book,
        blocks: [
          HeadingBlockSchema.make({
            source: SourceAnchorSchema.make({ chapter: slug, section: 'index' }),
            level: 1,
            title: indexHeading,
            id: 'index',
            unsettled: false,
            divider: false,
          }),
          ...Array.flatMap(concepts, (concept) =>
            entryBlocks(weaving, modules, usesOf, slug, concept),
          ),
        ],
      }),
    ),
  )
}
