import { Array, Context, Effect, Layer, Match, Option, pipe } from 'effect'
import type { LoomSection } from '@athrio/loom-ast/LoomAst'
import type {
  PreambleWeft,
  SectionBodyWeft,
  TocWeft,
} from '@athrio/loom-ast/Weft'
import type { WarpAnchorToken } from '@athrio/loom-ast/LoomTokens'
import {
  type LoomCorpusAst,
  type LoomModule,
  resolveAnchor,
  titleIndexes,
  type TitleIndexes,
} from '@athrio/loom-ast/LoomCorpusAst'
import {
  type AnchorLink,
  AnchorLinkSchema,
  CodeBlockSchema,
  HeadingBlockSchema,
  NoteBlockSchema,
  ProseBlockSchema,
  type SourceAnchor,
  SourceAnchorSchema,
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

export class WeaveBuilder extends Context.Service<WeaveBuilder>()(
  'WeaveBuilder',
  {
    make: Effect.succeed({
      build: (corpus: LoomCorpusAst): Effect.Effect<WovenCorpus> =>
        Effect.sync(() => buildCorpus(corpus)),
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make)
}

export const buildCorpus = (corpus: LoomCorpusAst): WovenCorpus => {
  const modules = Array.fromIterable(corpus.modules.values())
  const indexes = titleIndexes(corpus.modules)
  const nav = buildNav(modules)
  const partOfSlug = partIndex(nav)
  const pages = Array.getSomes(Array.map(modules, (module) =>
    buildPage(module, indexes, partOfSlug),
  ))
  return WovenCorpusSchema.make({ nav, pages })
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

const bookEntries = (
  modules: ReadonlyArray<LoomModule>,
): ReadonlyArray<TocWeft> =>
  pipe(
    Array.findFirst(modules, (m) =>
      Array.some(m.doc.sections, (s) => s.entries !== undefined),
    ),
    Option.map((m) => Array.flatMap(m.doc.sections, (s) => s.entries ?? [])),
    Option.getOrElse((): ReadonlyArray<TocWeft> => []),
  )

const chapterSlugs = (
  modules: ReadonlyArray<LoomModule>,
): ReadonlyMap<string, string> =>
  pipe(
    modules,
    Array.map((m) =>
      Option.map(
        Option.fromNullishOr(m.doc.frontmatter?.title),
        (title) => [title.value, slugFor(m.path)] as const,
      ),
    ), Array.getSomes,
    Array.reduce(new Map<string, string>(), (index, [title, slug]) =>
      index.has(title) ? index : new Map(index).set(title, slug),
    ),
  )

type Entry =
  | { readonly kind: 'part'; readonly label: string }
  | { readonly kind: 'chapter'; readonly number: string; readonly title: string }
  | { readonly kind: 'blank' }

const classifyEntry = (entry: TocWeft): Entry =>
  pipe(
    Option.fromNullishOr(entry.part),
    Option.map((p): Entry => ({ kind: 'part', label: p.value })),
    Option.orElse(() =>
      Option.map(
        Option.all({
          chapter: Option.fromNullishOr(entry.chapter),
          title: Option.fromNullishOr(entry.title),
        }),
        ({ chapter, title }): Entry => ({
          kind: 'chapter',
          number: chapter.value,
          title: title.value,
        }),
      ),
    ),
    Option.getOrElse((): Entry => ({ kind: 'blank' })),
  )

const partLabel = /^Part\s+(\S+)\s*[—–-]\s*(.+)$/

const parsePart = (
  label: string,
): { readonly number: string; readonly name: string } =>
  Option.match(Option.fromNullishOr(partLabel.exec(label)), {
    onNone: () => ({ number: label, name: label }),
    onSome: (m) => ({ number: m[1] ?? label, name: (m[2] ?? label).trim() }),
  })

const appendChapter = (
  parts: ReadonlyArray<WovenPart>,
  chapter: WovenNavEntry,
): ReadonlyArray<WovenPart> =>
  Option.match(Array.last(parts), {
    onNone: () => parts,
    onSome: (last) => [
      ...Array.dropRight(parts, 1),
      { ...last, chapters: [...last.chapters, chapter] },
    ],
  })

const foldEntry =
  (slugs: ReadonlyMap<string, string>) =>
  (parts: ReadonlyArray<WovenPart>, entry: TocWeft): ReadonlyArray<WovenPart> =>
    Match.value(classifyEntry(entry)).pipe(
      Match.when({ kind: 'part' }, ({ label }) => {
        const { number, name } = parsePart(label)
        return [...parts, WovenPartSchema.make({ number, name, chapters: [] })]
      }),
      Match.when({ kind: 'chapter' }, ({ number, title }) =>
        Option.match(Option.fromNullishOr(slugs.get(title)), {
          onNone: () => parts,
          onSome: (slug) =>
            appendChapter(
              parts,
              WovenNavEntrySchema.make({ number, title, slug }),
            ),
        }),
      ),
      Match.orElse(() => parts),
    )

const buildNav = (
  modules: ReadonlyArray<LoomModule>,
): ReadonlyArray<WovenPart> =>
  Array.reduce(
    bookEntries(modules),
    [] as ReadonlyArray<WovenPart>,
    foldEntry(chapterSlugs(modules)),
  )

const partIndex = (
  nav: ReadonlyArray<WovenPart>,
): ReadonlyMap<string, string> =>
  new Map(
    Array.flatMap(nav, (part) =>
      Array.map(part.chapters, (chapter) => [chapter.slug, part.name] as const),
    ),
  )

const buildPage = (
  module: LoomModule,
  indexes: TitleIndexes,
  partOfSlug: ReadonlyMap<string, string>,
): Option.Option<WovenPage> =>
  Option.map(
    Option.fromNullishOr(module.doc.frontmatter?.title),
    (title): WovenPage => {
      const slug = slugFor(module.path)
      return WovenPageSchema.make({
        slug,
        title: title.value,
        part: partOfSlug.get(slug),
        blocks: buildBlocks(module, indexes),
      })
    },
  )

const buildBlocks = (
  module: LoomModule,
  indexes: TitleIndexes,
): ReadonlyArray<WovenBlock> =>
  Array.flatMap(module.doc.sections, sectionBlocks(module, indexes))

const sectionSource = (
  module: LoomModule,
  section: LoomSection,
): SourceAnchor =>
  SourceAnchorSchema.make({
    chapter: slugFor(module.path),
    section: slugify(titleSource(section)),
  })

const sectionBlocks =
  (module: LoomModule, indexes: TitleIndexes) =>
  (section: LoomSection): ReadonlyArray<WovenBlock> => {
    const source = sectionSource(module, section)
    return [
      headingBlock(section, source),
      ...pipe(
        splitRuns(sectionBody(section)),
        Array.flatMap(runBlocks(module, indexes, section, source)),
      ),
    ]
  }

const titleSource = (section: LoomSection): string =>
  section.heading.title?.source ?? ''

const headingLevel = (section: LoomSection): number => {
  const marks = section.heading.headingStart.source.replace(/[^#]/g, '').length
  return marks === 0 ? 1 : marks
}

const headingBlock = (
  section: LoomSection,
  source: SourceAnchor,
): WovenBlock =>
  HeadingBlockSchema.make({
    source,
    level: headingLevel(section),
    title: titleSource(section),
    id: slugify(titleSource(section)),
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

const splitRuns = (
  body: ReadonlyArray<BodyWeft>,
): ReadonlyArray<ReadonlyArray<BodyWeft>> =>
  Array.isReadonlyArrayNonEmpty(body)
    ? Array.groupWith(
        body,
        (a, _b) => a.type !== 'ArrowWeft' && a.type !== 'TildeWeft',
      )
    : []

const isMarker = (weft: BodyWeft): boolean =>
  weft.type === 'ArrowWeft' || weft.type === 'TildeWeft'

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
    index === 0 && isMarker(weft)
      ? Option.toArray(markerInline(weft))
      : [pieceOfWeft(weft)],
  )
  const kept = Array.filter(pieces, (piece) => !piece.blank)
  return Array.isReadonlyArrayNonEmpty(kept)
    ? Option.some({
        start: Array.headNonEmpty(kept).start,
        end: Array.lastNonEmpty(kept).end,
      })
    : Option.none()
}

const reservedSpecifiers: ReadonlySet<string> = new Set(['tangle', 'toc'])

const sectionLanguage = (module: LoomModule, section: LoomSection): string =>
  pipe(
    Option.fromNullishOr(section.heading.specifier),
    Option.map((s) => s.label.value.toLowerCase()),
    Option.filter((id) => !reservedSpecifiers.has(id)),
    Option.orElse(() =>
      Option.map(
        Option.fromNullishOr(module.doc.frontmatter?.language),
        (l) => l.value.trim().toLowerCase(),
      ),
    ),
    Option.getOrElse(() => 'plaintext'),
  )

const notePattern =
  /^[ \t]*:::\[Note\][^\n]*\n([\s\S]*?)\n[ \t]*:::(?:[ \t])*$/gm

const proseBlockOf = (
  markdown: string,
  source: SourceAnchor,
): ReadonlyArray<WovenBlock> =>
  markdown.trim().length === 0
    ? []
    : [ProseBlockSchema.make({ source, markdown: markdown.trim() })]

const proseBlocks = (
  markdown: string,
  source: SourceAnchor,
): ReadonlyArray<WovenBlock> => {
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
  indexes: TitleIndexes,
  section: LoomSection,
  source: SourceAnchor,
  run: ReadonlyArray<BodyWeft>,
  span: Span,
): WovenBlock =>
  CodeBlockSchema.make({
    source,
    language: sectionLanguage(module, section),
    code: sliceContent(module.text, span),
    links: pipe(
      Array.flatMap(run, (weft) => weft.anchors),
      Array.filter(
        (anchor) =>
          anchor.position.start.offset >= span.start &&
          anchor.position.end.offset <= span.end,
      ),
      Array.map((anchor) =>
        resolveLink(module, indexes, span.start, anchor),
      ), Array.getSomes,
    ),
  })

const runBlocks =
  (
    module: LoomModule,
    indexes: TitleIndexes,
    section: LoomSection,
    source: SourceAnchor,
  ) =>
  (run: ReadonlyArray<BodyWeft>): ReadonlyArray<WovenBlock> =>
    Array.matchLeft(run, {
      onEmpty: (): ReadonlyArray<WovenBlock> => [],
      onNonEmpty: (first) =>
        Option.match(runSpan(run), {
          onNone: (): ReadonlyArray<WovenBlock> => [],
          onSome: (span) =>
            Match.value(first).pipe(
              Match.withReturnType<ReadonlyArray<WovenBlock>>(),
              Match.when({ type: 'ArrowWeft' }, () => [
                codeBlock(module, indexes, section, source, run, span),
              ]),
              Match.orElse(() =>
                proseBlocks(sliceContent(module.text, span), source),
              ),
            ),
        }),
    })

const resolveLink = (
  module: LoomModule,
  indexes: TitleIndexes,
  blockStart: number,
  anchor: WarpAnchorToken,
): Option.Option<AnchorLink> =>
  pipe(
    resolveAnchor(indexes, module.path, anchor),
    Option.flatMap((ref) =>
      Option.map(
        Option.fromNullishOr(ref.section.heading.title),
        (title): AnchorLink =>
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
