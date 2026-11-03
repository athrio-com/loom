import { Array, Context, Effect, Layer, Match, Option, Order, pipe } from 'effect'
import type { LoomSection } from '@athrio/loom-ast/LoomAst'
import type { PreambleWeft, SectionBodyWeft } from '@athrio/loom-ast/Weft'
import type { WarpAnchorToken } from '@athrio/loom-ast/LoomTokens'
import {
  type LoomCorpusAst,
  type LoomModule,
  resolveAnchor,
  bookOf,
  type Book,
  type Location,
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
  NoteBlockSchema,
  ProseBlockSchema,
  type SourceAnchor,
  SourceAnchorSchema,
  UnsettledSpanSchema,
  type WovenBlock,
  type WovenCorpus,
  WovenCorpusSchema,
  type WovenNavEntry,
  WovenNavEntrySchema,
  type WovenPage,
  WovenPageSchema,
  type WovenPart,
  WovenPartSchema,
} from './WovenCorpus'
import { buildContents, type TocChapter, type TocPart } from './TableOfContentsBuilder'
import { sectionLanguage } from '../ast/ProductBuilder'

export class WeaveBuilder extends Context.Service<WeaveBuilder>()('WeaveBuilder', {
  make: Effect.succeed({
    build: (corpus: LoomCorpusAst): Effect.Effect<WovenCorpus> =>
      Effect.sync(() => buildCorpus(corpus)),
  }),
}) {
  static readonly layer = Layer.effect(this, this.make)
}

export const buildCorpus = (corpus: LoomCorpusAst): WovenCorpus => {
  const modules = Array.fromIterable(corpus.modules.values())
  const weaving = weavingOf(corpus.modules)
  const toc = buildContents(corpus)
  const nav = Array.map(toc.parts, wovenPart)
  const loose = Array.map(toc.loose, wovenEntry)
  const partOfSlug = partIndex(nav)
  const pages = pipe(
    Array.getSomes(Array.map(modules, (module) => buildPage(module, weaving, partOfSlug))),
    Array.sort(inReadingOrder(navOrder(nav))),
  )
  return WovenCorpusSchema.make({ nav, loose, pages })
}

type Weaving = {
  readonly book: Book
  readonly anchors: ReadonlySet<string>
  readonly sections: ReadonlySet<string>
}

const anchorKey = (path: Location, at: Position): string => `${path}#${at.start.offset}`

const weavingOf = (modules: ReadonlyMap<Location, LoomModule>): Weaving => {
  const book = bookOf(modules)
  const unsettled = pipe(
    Array.fromIterable(modules.values()),
    Array.flatMap((module) =>
      Array.flatMap(module.product.code, (code) =>
        Array.getSomes(
          Array.map(code.fragments, (part) =>
            part.type === 'NameRef'
              ? unsettledRef(modules, book, module.path, part)
              : Option.none(),
          ),
        ),
      ),
    ),
  )
  return {
    book,
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

const isBlankSource = (source: string): boolean => source.trim().length === 0

const sliceContent = (text: string, span: Span): string =>
  text.slice(span.start, span.end).replace(/\s+$/, '')

const wovenEntry = (chapter: TocChapter): WovenNavEntry =>
  WovenNavEntrySchema.make({
    number: chapter.number,
    title: chapter.title,
    slug: slugFor(chapter.path),
    status: chapter.status,
    priority: chapter.priority,
    language: chapter.language,
  })

const wovenPart = (part: TocPart): WovenPart =>
  WovenPartSchema.make({
    number: part.number,
    name: part.name,
    chapters: Array.map(part.chapters, wovenEntry),
  })

const partIndex = (nav: ReadonlyArray<WovenPart>): ReadonlyMap<string, string> =>
  new Map(
    Array.flatMap(nav, (part) =>
      Array.map(part.chapters, (chapter) => [chapter.slug, part.name] as const),
    ),
  )

const navOrder = (nav: ReadonlyArray<WovenPart>): ReadonlyMap<string, number> =>
  new Map(
    Array.map(
      Array.flatMap(nav, (part) => Array.map(part.chapters, (chapter) => chapter.slug)),
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

const isBookRoot = (module: LoomModule): boolean =>
  Array.some(module.doc.sections, (section) => section.entries !== undefined)

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
): Option.Option<WovenPage> =>
  isBookRoot(module)
    ? Option.none()
    : Option.map(chapterTitleOf(module), (title): WovenPage => {
        const slug = slugFor(module.path)
        return WovenPageSchema.make({
          slug,
          title,
          part: partOfSlug.get(slug),
          frontmatter: module.doc.frontmatter?.source,
          blocks: buildBlocks(module, weaving),
        })
      })

const buildBlocks = (module: LoomModule, weaving: Weaving): ReadonlyArray<WovenBlock> =>
  Array.flatMap(module.doc.sections, sectionBlocks(module, weaving))

const sectionSource = (module: LoomModule, section: LoomSection): SourceAnchor =>
  SourceAnchorSchema.make({
    chapter: slugFor(module.path),
    section: slugify(titleSource(section)),
  })

const sectionBlocks =
  (module: LoomModule, weaving: Weaving) =>
  (section: LoomSection): ReadonlyArray<WovenBlock> => {
    const source = sectionSource(module, section)
    const runs = splitRuns(sectionBody(section))
    return [
      headingBlock(module, weaving, section, source),
      ...Array.flatMap(runs, (run, index) =>
        runBlocks(module, weaving, section, source)(run, tildeOpens(Array.get(runs, index + 1))),
      ),
    ]
  }

const titleSource = (section: LoomSection): string => section.heading.title?.source ?? ''

const headingLevel = (section: LoomSection): number => {
  const marks = section.heading.headingStart.source.replace(/[^#]/g, '').length
  return marks === 0 ? 1 : marks
}

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

const splitRuns = (body: ReadonlyArray<BodyWeft>): ReadonlyArray<ReadonlyArray<BodyWeft>> =>
  Array.isReadonlyArrayNonEmpty(body)
    ? Array.groupWith(body, (a, _b) => a.type !== 'ArrowWeft' && a.type !== 'TildeWeft')
    : []

const isMarker = (weft: BodyWeft): boolean => weft.type === 'ArrowWeft' || weft.type === 'TildeWeft'

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
  blank: isBlankSource(weft.source),
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

const notePattern = /^[ \t]*:::\[Note\][^\n]*\n([\s\S]*?)\n[ \t]*:::(?:[ \t])*$/gm

const proseBlockOf = (markdown: string, source: SourceAnchor): ReadonlyArray<WovenBlock> =>
  markdown.trim().length === 0 ? [] : [ProseBlockSchema.make({ source, markdown: markdown.trim() })]

const proseBlocks = (markdown: string, source: SourceAnchor): ReadonlyArray<WovenBlock> => {
  const walked = Array.reduce(
    Array.fromIterable(markdown.matchAll(notePattern)),
    { blocks: [] as ReadonlyArray<WovenBlock>, cursor: 0 },
    (acc, match) => {
      const at = match.index ?? 0
      return {
        blocks: [
          ...acc.blocks,
          ...proseBlockOf(markdown.slice(acc.cursor, at), source),
          NoteBlockSchema.make({ source, markdown: (match[1] ?? '').trim() }),
        ],
        cursor: at + match[0].length,
      }
    },
  )
  return [...walked.blocks, ...proseBlockOf(markdown.slice(walked.cursor), source)]
}

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

const runBlocks =
  (module: LoomModule, weaving: Weaving, section: LoomSection, source: SourceAnchor) =>
  (run: ReadonlyArray<BodyWeft>, closed: boolean): ReadonlyArray<WovenBlock> =>
    Array.matchLeft(run, {
      onEmpty: (): ReadonlyArray<WovenBlock> => [],
      onNonEmpty: (first) =>
        Option.match(runSpan(run), {
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
              Match.orElse(() => proseBlocks(sliceContent(module.text, span), source)),
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
    resolveAnchor(weaving.book, module.path, anchor),
    Option.flatMap((ref) =>
      Option.map(Option.fromNullishOr(ref.section.heading.title), (title): AnchorLink =>
        AnchorLinkSchema.make({
          name: anchor.name.value,
          targetSlug: slugFor(ref.module),
          targetId: slugify(title.source),
          offset: anchor.position.start.offset - blockStart,
          length: anchor.position.end.offset - anchor.position.start.offset,
        }),
      ),
    ),
  )
