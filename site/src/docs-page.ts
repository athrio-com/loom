import { Array, Match, Option, pipe } from 'effect'
import { marked } from 'marked'
import type { Html, HtmlBuilder } from 'foldkit/html'
import {
  ClosedDrawer,
  Copied,
  OpenedChapter,
  PickedRuntime,
  SelectedSection,
  type Message,
  type Model,
  type Runtime,
} from './model'
import {
  broadSeam,
  bunIcon,
  type Carpet,
  carpetMark,
  checkIcon,
  copyIcon,
  editorMark,
  flowerFor,
  loomMark,
  nodeIcon,
} from './components'
import { commandButton, installLine } from './hero'
import { loomCanvas } from './example'
import { operations } from './operations'
import projectDrawing from './project.svg?raw'
import wovenDocs from './docs.woven.json'

type HeadingBlock = {
  readonly type: 'heading'
  readonly level: number
  readonly title: string
  readonly id: string
}

type ProseBlock = {
  readonly type: 'prose'
  readonly markdown: string
}

type Block = HeadingBlock | ProseBlock

type Chapter = {
  readonly number: string
  readonly title: string
  readonly slug: string
}

type Part = {
  readonly number: string
  readonly name: string
  readonly chapters: ReadonlyArray<Chapter>
}

type Page = {
  readonly slug: string
  readonly title: string
  readonly blocks: ReadonlyArray<Block>
}

export type Corpus = {
  readonly nav: ReadonlyArray<Part>
  readonly pages: ReadonlyArray<Page>
}

export const docsCorpus = wovenDocs as unknown as Corpus

export const firstSlugOf = (corpus: Corpus): string =>
  pipe(
    Option.fromNullishOr(corpus.pages[0]),
    Option.map((page) => page.slug),
    Option.getOrElse(() => ''),
  )

const pageOf = (corpus: Corpus, slug: string): Option.Option<Page> =>
  Array.findFirst(corpus.pages, (page) => page.slug === slug)

const partOf = (corpus: Corpus, slug: string): Option.Option<Part> =>
  Array.findFirst(corpus.nav, (part) =>
    Array.some(part.chapters, (chapter) => chapter.slug === slug),
  )

const readingOrder = (corpus: Corpus): ReadonlyArray<Chapter> =>
  Array.flatMap(corpus.nav, (part) => part.chapters)

const readable = (slug: string): string =>
  pipe(
    slug.split('/'),
    Array.map((segment) => segment.replace(/^\d+-/, '')),
    Array.join('/'),
  )

export const chapterPath = (base: string, slug: string): string => `${base}/${readable(slug)}`

export const chapterAt = (corpus: Corpus, base: string, pathname: string): Option.Option<string> =>
  pipe(
    Array.findFirst(corpus.pages, (page) => chapterPath(base, page.slug) === pathname),
    Option.map((page) => page.slug),
  )

export const docsChapterAt = (pathname: string): Option.Option<string> =>
  chapterAt(docsCorpus, '/docs', pathname)

type Section = {
  readonly heading: HeadingBlock
  readonly blocks: ReadonlyArray<Block>
}

type Cut = {
  readonly title: Option.Option<HeadingBlock>
  readonly opening: ReadonlyArray<Block>
  readonly sections: ReadonlyArray<Section>
}

const isTitle = (block: Block): block is HeadingBlock =>
  block.type === 'heading' && block.level === 1

const isSectionHead = (block: Block): block is HeadingBlock =>
  block.type === 'heading' && block.level === 2

const grow = (sections: ReadonlyArray<Section>, block: Block): ReadonlyArray<Section> =>
  isSectionHead(block)
    ? Array.append(sections, { heading: block, blocks: [] })
    : pipe(
        Array.last(sections),
        Option.match({
          onNone: () => sections,
          onSome: (last) =>
            Array.append(Array.dropRight(sections, 1), {
              ...last,
              blocks: Array.append(last.blocks, block),
            }),
        }),
      )

const cutOf = (page: Page): Cut => {
  const body = Array.filter(page.blocks, (block) => !isTitle(block))
  const [opening, rest] = Array.span(body, (block) => !isSectionHead(block))
  return {
    title: Array.findFirst(page.blocks, isTitle),
    opening,
    sections: Array.reduce(rest, [] as ReadonlyArray<Section>, grow),
  }
}

type Piece =
  | { readonly type: 'text'; readonly markdown: string }
  | { readonly type: 'fence'; readonly kind: string; readonly body: string }

const FENCE = /^```([\w-]*)[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/m

const piecesOf = (markdown: string): ReadonlyArray<Piece> => {
  const [first, ...rest] = markdown.split(FENCE)
  return Array.filter(
    [
      { type: 'text', markdown: first ?? '' } as Piece,
      ...Array.flatMap(Array.chunksOf(rest, 3), ([kind, body, after]): ReadonlyArray<Piece> => [
        { type: 'fence', kind: kind ?? '', body: body ?? '' },
        { type: 'text', markdown: after ?? '' },
      ]),
    ],
    (piece) => piece.type === 'fence' || piece.markdown.trim() !== '',
  )
}

const textOf = (
  markdown: string,
  className: string,
  copied: string,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class(className), h.InnerHTML(inlineCommands(marked.parse(markdown) as string, copied))],
    [],
  )

const INLINE_COMMAND = /<code>\$ ([^<]+)<\/code>/g

const COPY_GLYPH =
  '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"></rect><path d="M5 15V5a2 2 0 0 1 2-2h10"></path></svg>'

const TICK_GLYPH =
  '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"></path></svg>'

const ENTITIES: ReadonlyArray<readonly [string, string]> = [
  ['&lt;', '<'],
  ['&gt;', '>'],
  ['&quot;', '"'],
  ['&#39;', "'"],
  ['&amp;', '&'],
]

const commandOf = (escaped: string): string =>
  Array.reduce(ENTITIES, escaped, (text, [entity, glyph]) => text.split(entity).join(glyph))

const COMMAND_INKS: ReadonlyArray<readonly [string, string]> = [
  ['loom init', 'var(--init)'],
  ['loom tangle', 'var(--tangle)'],
  ['loom weave', 'var(--weave)'],
  ['loom eject', 'var(--eject)'],
]

const inkOf = (command: string): string =>
  pipe(
    Array.findFirst(COMMAND_INKS, ([name]) => command === name || command.startsWith(`${name} `)),
    Option.map(([, ink]) => ink),
    Option.getOrElse(() => 'var(--prompt-paper)'),
  )

const inlineCommands = (html: string, copied: string): string =>
  html.replace(INLINE_COMMAND, (_, escaped: string) => {
    const command = commandOf(escaped)
    const done = copied === `inline:${command}`
    return `<button type="button" class="${done ? 'inline-copy done' : 'inline-copy'}" style="--cmd-ink: ${inkOf(command)}" data-copy="${escaped}" title="Copy the command"><code>${escaped}</code>${done ? TICK_GLYPH : COPY_GLYPH}</button>`
  })

const fenceOf = (kind: string, body: string, model: Model, h: HtmlBuilder<Message>): Html =>
  Match.value(kind).pipe(
    Match.when('install', () => installLine(model, h)),
    Match.when('picture', () => pictureOf(body.trim(), h)),
    Match.when('run', () => runLine(body.trim(), model, h)),
    Match.when('loom', () => loomCanvas(body, model.copied, h)),
    Match.when('bash', () => commandsOf(body, model, h)),
    Match.orElse(() => codeSheet(body, model.copied, h)),
  )

const commandsOf = (body: string, model: Model, h: HtmlBuilder<Message>): Html => {
  const lines = pipe(
    body.split('\n'),
    Array.map((line) => line.trim()),
    Array.filter((line) => line !== ''),
  )
  return pipe(
    Array.head(lines),
    Option.filter(() => lines.length === 1),
    Option.match({
      onNone: () => codeSheet(body, model.copied, h),
      onSome: (command) =>
        h.div(
          [h.Class('docs-command')],
          [commandButton(`command:${command}`, command, model.copied, h)],
        ),
    }),
  )
}

const codeSheet = (body: string, copied: string, h: HtmlBuilder<Message>): Html => {
  const code = body.replace(/\n$/, '')
  const id = `code:${code}`
  const taken = copied === id
  return h.div(
    [h.Class('docs-canvas')],
    [
      h.button(
        [
          h.Class(taken ? 'canvas-copy done' : 'canvas-copy'),
          h.Type('button'),
          h.Title(taken ? 'Copied' : 'Copy the code'),
          h.AriaLabel('Copy the code'),
          h.OnClick(Copied({ id, text: code })),
        ],
        [taken ? checkIcon() : copyIcon()],
      ),
      h.pre([h.Class('sheet-code')], [h.code([], [code])]),
    ],
  )
}

type Picture = { readonly name: string; readonly drawing: string }

const docsPictures: ReadonlyArray<Picture> = [{ name: 'project', drawing: projectDrawing }]

const landingPicture = (command: string): Option.Option<string> =>
  pipe(
    Array.findFirst(operations, (operation) => operation.command === command),
    Option.flatMap((operation) => Option.fromNullishOr(operation.drawing)),
  )

const pictureOf = (name: string, h: HtmlBuilder<Message>): Html =>
  pipe(
    Array.findFirst(docsPictures, (picture) => picture.name === name),
    Option.map((picture) => picture.drawing),
    Option.orElse(() => landingPicture(name)),
    Option.match({
      onNone: () => h.div([], []),
      onSome: (drawing) =>
        h.div(
          [h.Class('ops-frame doc-picture')],
          [h.div([h.Class('ops-svg'), h.InnerHTML(drawing)], [])],
        ),
    }),
  )

type Runner = {
  readonly runtime: Runtime
  readonly label: string
  readonly logo: Html
}

const bunRunner: Runner = { runtime: 'bun', label: 'bun', logo: bunIcon() }
const nodeRunner: Runner = { runtime: 'npm', label: 'node', logo: nodeIcon() }

const runnerOf = (runtime: Runtime): Runner =>
  Match.value(runtime).pipe(
    Match.when('bun', () => bunRunner),
    Match.orElse(() => nodeRunner),
  )

const runLine = (file: string, model: Model, h: HtmlBuilder<Message>): Html => {
  const chosen = runnerOf(model.runtime)
  return h.div(
    [h.Class('hero-install')],
    [
      h.div(
        [h.Class('rt-tabs')],
        Array.map([bunRunner, nodeRunner], (runner) =>
          h.button(
            [
              h.Class(runner.label === chosen.label ? 'rt-tab here' : 'rt-tab'),
              h.Type('button'),
              h.OnClick(PickedRuntime({ runtime: runner.runtime })),
            ],
            [runner.logo, runner.label],
          ),
        ),
      ),
      commandButton(`run:${file}`, `${chosen.label} ${file}`, model.copied, h),
    ],
  )
}

const blockOf = (block: Block, model: Model, h: HtmlBuilder<Message>): ReadonlyArray<Html> =>
  Match.value(block).pipe(
    Match.when({ type: 'heading' }, (heading) => [h.h3([h.Id(heading.id)], [heading.title])]),
    Match.when({ type: 'prose' }, (prose) =>
      Array.map(piecesOf(prose.markdown), (piece) =>
        piece.type === 'text'
          ? textOf(piece.markdown, 'docs-prose', model.copied, h)
          : fenceOf(piece.kind, piece.body, model, h),
      ),
    ),
    Match.exhaustive,
  )

const markOf = (flower: Option.Option<Carpet>, section: Section): Option.Option<Html> =>
  Option.orElse(editorMark(section.heading.title), () =>
    Option.map(flower, (carpet) => carpetMark(carpet, '42px', broadSeam)),
  )

const sectionOf = (
  flower: Option.Option<Carpet>,
  section: Section,
  model: Model,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class('section doc-section')],
    [
      h.div(
        [h.Class('section-head')],
        [
          ...Option.toArray(markOf(flower, section)),
          h.div([h.Class('lines')], [h.h2([h.Id(section.heading.id)], [section.heading.title])]),
        ],
      ),
      h.div(
        [h.Class('doc-stack')],
        Array.flatMap(section.blocks, (block) => blockOf(block, model, h)),
      ),
    ],
  )

const crumbLink = (label: string, href: string, slug: string, h: HtmlBuilder<Message>): Html =>
  h.a([h.Class('crumb'), h.Href(href), h.OnClick(OpenedChapter({ slug }))], [label])

const breadcrumb = (
  corpus: Corpus,
  root: string,
  base: string,
  page: Page,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class('eyebrow doc-crumbs')],
    [
      crumbLink(root, base, firstSlugOf(corpus), h),
      h.span([h.Class('sep'), h.AriaHidden(true)], ['/']),
      ...pipe(
        partOf(corpus, page.slug),
        Option.flatMap((part) =>
          Option.map(Array.head(part.chapters), (first) => [
            crumbLink(part.name, chapterPath(base, first.slug), first.slug, h),
            h.span([h.Class('sep'), h.AriaHidden(true)], ['/']),
          ]),
        ),
        Option.getOrElse((): ReadonlyArray<Html> => []),
      ),
      h.span([h.Class('here')], [page.title]),
    ],
  )

const docHead = (
  corpus: Corpus,
  root: string,
  base: string,
  page: Page,
  cut: Cut,
  model: Model,
  h: HtmlBuilder<Message>,
): Html => {
  const pieces = Array.flatMap(cut.opening, (block) =>
    block.type === 'prose' ? piecesOf(block.markdown) : [],
  )
  const heading = Option.getOrElse(cut.title, (): HeadingBlock => ({
    type: 'heading',
    level: 1,
    title: page.title,
    id: page.slug,
  }))
  return h.div(
    [h.Class('section section-hero page-hero doc-hero')],
    [
      h.div(
        [h.Class('doc-hero-grid')],
        [
          h.div(
            [h.Class('doc-hero-lead')],
            [
              breadcrumb(corpus, root, base, page, h),
              h.div(
                [h.Class('page-title')],
                [loomMark('paper', 0.8), h.h1([h.Id(heading.id)], [heading.title])],
              ),
              ...Array.flatMap(pieces, (piece) =>
                piece.type === 'text'
                  ? [textOf(piece.markdown, 'docs-prose page-lead', model.copied, h)]
                  : [],
              ),
            ],
          ),
          h.div(
            [h.Class('hero-cli')],
            Array.flatMap(pieces, (piece) =>
              piece.type === 'fence' ? [fenceOf(piece.kind, piece.body, model, h)] : [],
            ),
          ),
        ],
      ),
    ],
  )
}

const sectionButton = (section: Section, here: boolean, h: HtmlBuilder<Message>): Html =>
  h.button(
    [
      h.Class(here ? 'menu-sub here' : 'menu-sub'),
      h.Type('button'),
      h.OnClick(SelectedSection({ id: section.heading.id })),
    ],
    [section.heading.title],
  )

const reachedOf = (cut: Cut, active: string): string =>
  active !== ''
    ? active
    : pipe(
        Array.head(cut.sections),
        Option.map((section) => section.heading.id),
        Option.getOrElse(() => ''),
      )

const chapterRows = (
  chapter: Chapter,
  page: Page,
  cut: Cut,
  active: string,
  base: string,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html> =>
  chapter.slug === page.slug
    ? [
        h.a([h.Class('menu-item here'), h.Href(chapterPath(base, chapter.slug))], [chapter.title]),
        h.div(
          [h.Class('menu-subs')],
          Array.map(cut.sections, (section) =>
            sectionButton(section, section.heading.id === reachedOf(cut, active), h),
          ),
        ),
      ]
    : [
        h.a(
          [
            h.Class('menu-item'),
            h.Href(chapterPath(base, chapter.slug)),
            h.OnClick(OpenedChapter({ slug: chapter.slug })),
          ],
          [chapter.title],
        ),
      ]

const menuGroups = (
  corpus: Corpus,
  page: Page,
  cut: Cut,
  active: string,
  base: string,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html> =>
  Array.map(corpus.nav, (part) =>
    h.div(
      [h.Class('menu-part')],
      [
        h.span([h.Class('eyebrow')], [part.name]),
        ...Array.flatMap(part.chapters, (chapter) =>
          chapterRows(chapter, page, cut, active, base, h),
        ),
      ],
    ),
  )

const menu = (
  corpus: Corpus,
  page: Page,
  cut: Cut,
  active: string,
  base: string,
  h: HtmlBuilder<Message>,
): Html =>
  h.nav(
    [h.Class('menu-card thin-scroll'), h.AriaLabel('Chapters')],
    menuGroups(corpus, page, cut, active, base, h),
  )

const chapterFlower = (corpus: Corpus, slug: string): Carpet =>
  flowerFor(
    pipe(
      Array.findFirstIndex(readingOrder(corpus), (chapter) => chapter.slug === slug),
      Option.getOrElse(() => 0),
    ),
  )

const chapterCard = (
  corpus: Corpus,
  base: string,
  chapter: Chapter,
  direction: 'Previous' | 'Next',
  h: HtmlBuilder<Message>,
): Html => {
  const mark = carpetMark(chapterFlower(corpus, chapter.slug), '42px', broadSeam)
  const words = h.div(
    [h.Class('pager-words')],
    [h.span([h.Class('eyebrow')], [direction]), h.span([h.Class('pager-title')], [chapter.title])],
  )
  return h.a(
    [
      h.Class(direction === 'Next' ? 'pager-card next' : 'pager-card'),
      h.Href(chapterPath(base, chapter.slug)),
      h.Style({ '--pg-ink': '#C2410C' }),
      h.OnClick(OpenedChapter({ slug: chapter.slug })),
    ],
    direction === 'Next' ? [words, mark] : [mark, words],
  )
}

const chapterPager = (corpus: Corpus, base: string, page: Page, h: HtmlBuilder<Message>): Html => {
  const order = readingOrder(corpus)
  const at = Array.findFirstIndex(order, (chapter) => chapter.slug === page.slug)
  const step = (by: number): Option.Option<Chapter> =>
    Option.flatMap(at, (index) => Array.get(order, index + by))
  return h.div(
    [h.Class('pager-row doc-pager')],
    [
      ...Option.toArray(
        Option.map(step(-1), (chapter) => chapterCard(corpus, base, chapter, 'Previous', h)),
      ),
      ...Option.toArray(
        Option.map(step(1), (chapter) => chapterCard(corpus, base, chapter, 'Next', h)),
      ),
    ],
  )
}

const closeIcon = (h: HtmlBuilder<Message>): Html =>
  h.svg(
    [
      h.Width('15'),
      h.Height('15'),
      h.ViewBox('0 0 24 24'),
      h.Fill('none'),
      h.Stroke('currentColor'),
      h.StrokeWidth('2'),
      h.StrokeLinecap('round'),
      h.AriaHidden(true),
    ],
    [
      h.line([h.X1('5'), h.Y1('5'), h.X2('19'), h.Y2('19')], []),
      h.line([h.X1('19'), h.Y1('5'), h.X2('5'), h.Y2('19')], []),
    ],
  )

const drawer = (
  corpus: Corpus,
  base: string,
  page: Page,
  cut: Cut,
  model: Model,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class(model.drawerOpen ? 'docs-drawer open' : 'docs-drawer')],
    [
      h.div(
        [h.Class('drawer-head')],
        [
          loomMark('paper', 0.495),
          h.span([h.Class('drawer-word')], ['Loom']),
          h.button(
            [
              h.Class('drawer-close'),
              h.Type('button'),
              h.AriaLabel('Close menu'),
              h.OnClick(ClosedDrawer()),
            ],
            [closeIcon(h)],
          ),
        ],
      ),
      h.div(
        [h.Class('drawer-body thin-scroll')],
        menuGroups(corpus, page, cut, model.activeSection, base, h),
      ),
    ],
  )

const scrim = (open: boolean, h: HtmlBuilder<Message>): Html =>
  h.div(
    [
      h.Class(open ? 'docs-scrim open' : 'docs-scrim'),
      h.AriaHidden(true),
      h.OnClick(ClosedDrawer()),
    ],
    [],
  )

export const wovenPage = (
  corpus: Corpus,
  root: string,
  base: string,
  model: Model,
  h: HtmlBuilder<Message>,
): Html => {
  const slug = model.chapter === '' ? firstSlugOf(corpus) : model.chapter
  return pipe(
    pageOf(corpus, slug),
    Option.orElse(() => Option.fromNullishOr(corpus.pages[0])),
    Option.match({
      onNone: () => h.div([h.Class('docs-page')], []),
      onSome: (page) => {
        const cut = cutOf(page)
        return h.div(
          [h.Class('docs-page')],
          [
            docHead(corpus, root, base, page, cut, model, h),
            h.div(
              [h.Class('docs-body')],
              [
                menu(corpus, page, cut, model.activeSection, base, h),
                h.article(
                  [h.Class('docs-article')],
                  [
                    ...Array.map(cut.sections, (section, place) =>
                      sectionOf(
                        place === 0 ? Option.some(chapterFlower(corpus, page.slug)) : Option.none(),
                        section,
                        model,
                        h,
                      ),
                    ),
                    chapterPager(corpus, base, page, h),
                  ],
                ),
              ],
            ),
            scrim(model.drawerOpen, h),
            drawer(corpus, base, page, cut, model, h),
          ],
        )
      },
    }),
  )
}

export const documentationPage = (model: Model, h: HtmlBuilder<Message>): Html =>
  wovenPage(docsCorpus, 'Docs', '/docs', model, h)
