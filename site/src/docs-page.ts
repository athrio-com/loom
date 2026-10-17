import { Array, Match, Option, pipe } from 'effect'
import { marked } from 'marked'
import type { Html, HtmlBuilder } from 'foldkit/html'
import {
  ClosedDrawer,
  OpenedChapter,
  SelectedSection,
  type Message,
  type Model,
} from './model'
import { docsPager } from './chrome'
import { loomMark } from './components'
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

const railRow = (chapter: Chapter, here: boolean, h: HtmlBuilder<Message>): Html =>
  h.button(
    [
      h.Class(here ? 'rail-item here' : 'rail-item'),
      h.Type('button'),
      h.OnClick(OpenedChapter({ slug: chapter.slug })),
    ],
    [chapter.title],
  )

const railGroups = (
  corpus: Corpus,
  current: string,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html> =>
  Array.map(corpus.nav, (part) =>
    h.div(
      [h.Class('rail-group')],
      [
        h.span([h.Class('rail-label')], [part.name]),
        h.div(
          [h.Class('rail-items')],
          Array.map(part.chapters, (chapter) => railRow(chapter, chapter.slug === current, h)),
        ),
      ],
    ),
  )

export const rail = (corpus: Corpus, current: string, h: HtmlBuilder<Message>): Html =>
  h.nav(
    [h.Class('docs-rail'), h.AriaLabel('Chapters')],
    [h.div([h.Class('rail-sticky thin-scroll')], railGroups(corpus, current, h))],
  )

const breadcrumb = (corpus: Corpus, root: string, page: Page, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('docs-crumbs')],
    [
      h.span([], [root]),
      h.span([h.Class('sep'), h.AriaHidden(true)], ['/']),
      h.span(
        [],
        [
          pipe(
            partOf(corpus, page.slug),
            Option.map((part) => part.name.toLowerCase()),
            Option.getOrElse(() => 'reference'),
          ),
        ],
      ),
      h.span([h.Class('sep'), h.AriaHidden(true)], ['/']),
      h.span([h.Class('here')], [page.title.toLowerCase()]),
    ],
  )

const headingOf = (block: HeadingBlock, h: HtmlBuilder<Message>): Html =>
  Match.value(block.level).pipe(
    Match.when(1, () => h.h1([h.Id(block.id)], [block.title])),
    Match.when(2, () => h.h2([h.Id(block.id)], [block.title])),
    Match.orElse(() => h.h3([h.Id(block.id)], [block.title])),
  )

const blockOf = (block: Block, h: HtmlBuilder<Message>): Html =>
  Match.value(block).pipe(
    Match.when({ type: 'heading' }, (heading) => headingOf(heading, h)),
    Match.when({ type: 'prose' }, (prose) =>
      h.div(
        [h.Class('docs-prose'), h.InnerHTML(marked.parse(prose.markdown) as string)],
        [],
      ),
    ),
    Match.exhaustive,
  )

const article = (corpus: Corpus, root: string, page: Page, h: HtmlBuilder<Message>): Html =>
  h.article(
    [h.Class('docs-article')],
    [
      breadcrumb(corpus, root, page, h),
      ...Array.map(page.blocks, (block) => blockOf(block, h)),
    ],
  )

const sectionsOf = (page: Page): ReadonlyArray<HeadingBlock> =>
  pipe(
    page.blocks,
    Array.filter((block): block is HeadingBlock => block.type === 'heading'),
    Array.filter((heading) => heading.level === 2),
  )

const outline = (page: Page, active: string, h: HtmlBuilder<Message>): Html =>
  h.aside(
    [h.Class('docs-outline'), h.AriaLabel('On this page')],
    [
      h.span([h.Class('outline-label')], ['On this page']),
      h.div(
        [h.Class('outline-links')],
        Array.map(sectionsOf(page), (heading) =>
          h.button(
            [
              h.Class(heading.id === active ? 'outline-link here' : 'outline-link'),
              h.Type('button'),
              h.OnClick(SelectedSection({ id: heading.id })),
            ],
            [heading.title],
          ),
        ),
      ),
    ],
  )

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
  model: Model,
  current: string,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class(model.drawerOpen ? 'docs-drawer open' : 'docs-drawer')],
    [
      h.div(
        [h.Class('drawer-head')],
        [
          loomMark('paper', 0.495),
          h.span([h.Class('bar-word-text')], ['Loom']),
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
      h.div([h.Class('drawer-body thin-scroll')], railGroups(corpus, current, h)),
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

const shellClass = (model: Model, outlined: boolean): string => {
  const base = outlined ? 'docs-shell' : 'docs-shell alone'
  return model.navHidden ? `${base} bar-hidden` : base
}

const shellFor = (
  corpus: Corpus,
  root: string,
  model: Model,
  page: Page,
  h: HtmlBuilder<Message>,
): Html =>
  pipe(
    sectionsOf(page),
    Array.match({
      onEmpty: () =>
        h.div(
          [h.Class(shellClass(model, false))],
          [
            rail(corpus, page.slug, h),
            article(corpus, root, page, h),
            docsPager(model.route, h),
          ],
        ),
      onNonEmpty: () =>
        h.div(
          [h.Class(shellClass(model, true))],
          [
            rail(corpus, page.slug, h),
            article(corpus, root, page, h),
            outline(page, model.activeSection, h),
            docsPager(model.route, h),
          ],
        ),
    }),
  )

export const wovenPage = (
  corpus: Corpus,
  root: string,
  model: Model,
  h: HtmlBuilder<Message>,
): Html => {
  const slug = model.chapter === '' ? firstSlugOf(corpus) : model.chapter
  return pipe(
    pageOf(corpus, slug),
    Option.orElse(() => Option.fromNullishOr(corpus.pages[0])),
    Option.match({
      onNone: () => h.div([h.Class('docs-shell')], []),
      onSome: (page) =>
        h.div(
          [h.Class('docs-page')],
          [
            shellFor(corpus, root, model, page, h),
            scrim(model.drawerOpen, h),
            drawer(corpus, model, page.slug, h),
          ],
        ),
    }),
  )
}

export const documentationPage = (model: Model, h: HtmlBuilder<Message>): Html =>
  wovenPage(docsCorpus, 'docs', model, h)
