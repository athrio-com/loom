import { Array, Effect, Match, Option, pipe, Schema as S } from 'effect'
import { Command, Navigation, Runtime, Url } from '@athrio/foldkit'
import { html, type Document, type Html } from '@athrio/foldkit/html'
import { m } from '@athrio/foldkit/message'
import {
  WovenSiteSchema,
  type AnchorLink,
  type WovenBlock,
  type WovenNavEntry,
  type WovenPage,
  type WovenPart,
  type WovenSite,
} from '@athrio/loom-lang/weave/WovenSite'
import { marked } from 'marked'
import siteData from './data/site.json'
import './styles.css'

const site = S.decodeUnknownSync(WovenSiteSchema)(siteData)

const Model = S.Struct({
  currentSlug: S.String,
  dark: S.Boolean,
  navClosed: S.Boolean,
})
type Model = typeof Model.Type

const ChangedUrl = m('ChangedUrl', { slug: S.String })
const ClickedLink = m('ClickedLink', { request: Navigation.UrlRequest })
const CompletedNavigation = m('CompletedNavigation')
const ToggledTheme = m('ToggledTheme')
const ToggledNav = m('ToggledNav')

const Message = S.Union([
  ChangedUrl,
  ClickedLink,
  CompletedNavigation,
  ToggledTheme,
  ToggledNav,
])
type Message = typeof Message.Type

const h = html<Message>()

const firstSlug = pipe(
  Array.flatMap(site.nav, (part) => part.chapters),
  Array.head,
  Option.map((chapter) => chapter.slug),
  Option.getOrElse(() => ''),
)

const stripOrder = (segment: string): string => segment.replace(/^\d+-/, '')

const pathForSlug = (slug: string): string =>
  `/${pipe(slug.split('/'), Array.map(stripOrder), Array.join('/'))}`

const pathIndex = new Map(
  Array.map(site.pages, (page) => [pathForSlug(page.slug), page.slug] as const),
)

const slugForPath = (pathname: string): string =>
  Option.getOrElse(Option.fromNullishOr(pathIndex.get(pathname)), () => firstSlug)

const init: Runtime.RoutingApplicationInit<Model, Message> = (url) => [
  { currentSlug: slugForPath(url.pathname), dark: false, navClosed: false },
  [],
]

const NavigateInternal = Command.define(
  'NavigateInternal',
  { url: S.String },
  CompletedNavigation,
)(({ url }) => Navigation.pushUrl(url).pipe(Effect.as(CompletedNavigation())))

const NavigateExternal = Command.define(
  'NavigateExternal',
  { href: S.String },
  CompletedNavigation,
)(({ href }) => Navigation.load(href).pipe(Effect.as(CompletedNavigation())))

const update = (
  model: Model,
  message: Message,
): readonly [Model, ReadonlyArray<Command.Command<Message>>] =>
  Match.value(message).pipe(
    Match.withReturnType<
      readonly [Model, ReadonlyArray<Command.Command<Message>>]
    >(),
    Match.tagsExhaustive({
      ChangedUrl: ({ slug }) => [
        { ...model, currentSlug: slug, navClosed: false },
        [],
      ],
      ClickedLink: ({ request }) =>
        Match.value(request).pipe(
          Match.withReturnType<
            readonly [Model, ReadonlyArray<Command.Command<Message>>]
          >(),
          Match.tag('Internal', ({ url }) => [
            model,
            [NavigateInternal({ url: Url.toString(url) })],
          ]),
          Match.tag('External', ({ href }) => [
            model,
            [NavigateExternal({ href })],
          ]),
          Match.exhaustive,
        ),
      CompletedNavigation: () => [model, []],
      ToggledTheme: () => [{ ...model, dark: !model.dark }, []],
      ToggledNav: () => [{ ...model, navClosed: !model.navClosed }, []],
    }),
  )

const headingTag = (level: number) =>
  Match.value(level).pipe(
    Match.when(1, () => h.h1),
    Match.when(2, () => h.h2),
    Match.orElse(() => h.h3),
  )

const headingView = (block: Extract<WovenBlock, { type: 'heading' }>): Html =>
  headingTag(block.level)([h.Id(block.id)], [block.title])

const proseView = (block: Extract<WovenBlock, { type: 'prose' }>): Html =>
  h.div([h.Class('prose'), h.InnerHTML(marked.parse(block.markdown) as string)], [])

const codeSegments = (
  block: Extract<WovenBlock, { type: 'code' }>,
): ReadonlyArray<string | Html> => {
  const walked = Array.reduce(
    block.links,
    { nodes: [] as ReadonlyArray<string | Html>, cursor: 0 },
    (acc, link) => ({
      nodes: [
        ...acc.nodes,
        block.source.slice(acc.cursor, link.offset),
        h.a(
          [h.Class('loom-anchor'), h.Href(pathForSlug(link.targetSlug))],
          [block.source.slice(link.offset, link.offset + link.length)],
        ),
      ],
      cursor: link.offset + link.length,
    }),
  )
  return [...walked.nodes, block.source.slice(walked.cursor)]
}

const codeView = (block: Extract<WovenBlock, { type: 'code' }>): Html =>
  h.div([h.Class('code')], codeSegments(block))

const noteView = (block: Extract<WovenBlock, { type: 'note' }>): Html =>
  h.aside(
    [h.Class('note')],
    [
      h.div([h.Class('note-label')], ['Note']),
      h.div(
        [
          h.Class('note-body'),
          h.InnerHTML(marked.parse(block.markdown) as string),
        ],
        [],
      ),
    ],
  )

const blockView = (block: WovenBlock): Html =>
  Match.value(block).pipe(
    Match.when({ type: 'heading' }, headingView),
    Match.when({ type: 'prose' }, proseView),
    Match.when({ type: 'code' }, codeView),
    Match.when({ type: 'note' }, noteView),
    Match.exhaustive,
  )

const navEntryView = (current: string) => (chapter: WovenNavEntry): Html =>
  h.li(
    [h.Key(chapter.slug)],
    [
      h.a(
        [
          h.Class(chapter.slug === current ? 'nav-link current' : 'nav-link'),
          h.Href(pathForSlug(chapter.slug)),
        ],
        [
          h.span([h.Class('nav-num')], [chapter.number]),
          h.span([], [chapter.title]),
        ],
      ),
    ],
  )

const navPartView = (current: string) => (part: WovenPart): Html =>
  h.div(
    [h.Class('nav-part'), h.Key(part.number)],
    [
      h.p([h.Class('nav-part-name')], [part.name]),
      ...(part.chapters.length > 0
        ? [h.ul([], Array.map(part.chapters, navEntryView(current)))]
        : []),
    ],
  )

const pageView = (page: WovenPage): Html =>
  h.article(
    [h.Class('page'), h.Key(page.slug)],
    [
      h.p(
        [h.Class('crumb')],
        [
          ...(page.part
            ? [
                h.span([h.Class('crumb-part')], [page.part]),
                h.span([h.Class('crumb-sep')], ['/']),
              ]
            : []),
          page.title,
        ],
      ),
      ...Array.map(page.blocks, blockView),
    ],
  )

const currentPage = (model: Model): WovenPage =>
  Option.getOrElse(
    Array.findFirst(site.pages, (page) => page.slug === model.currentSlug),
    () => site.pages[0],
  )

const appClass = (model: Model): string =>
  ['app', model.dark ? 'dark' : '', model.navClosed ? 'nav-closed' : '']
    .filter(Boolean)
    .join(' ')

const view = (model: Model): Document => ({
  title: `${currentPage(model).title} · Loom`,
  body: h.div(
    [h.Class(appClass(model))],
    [
      h.button([h.Class('btn reopen'), h.OnClick(ToggledNav())], ['☰']),
      h.aside(
        [h.Class('sidebar')],
        [
          h.div(
            [h.Class('side-head')],
            [
              h.div(
                [h.Class('brand')],
                [h.span([h.Class('logo')], ['~']), 'loom'],
              ),
              h.button(
                [
                  h.Class('btn'),
                  h.OnClick(ToggledNav()),
                  h.Style({ 'margin-left': 'auto' }),
                ],
                ['⟨'],
              ),
            ],
          ),
          h.nav(
            [h.Class('nav')],
            Array.map(site.nav, navPartView(model.currentSlug)),
          ),
          h.div(
            [h.Class('side-foot')],
            [
              h.button(
                [h.Class('btn'), h.OnClick(ToggledTheme())],
                [model.dark ? 'Light' : 'Dark'],
              ),
            ],
          ),
        ],
      ),
      h.div([h.Class('content')], [pageView(currentPage(model))]),
    ],
  ),
})

const application = Runtime.makeApplication({
  Model,
  init,
  update,
  view,
  routing: {
    onUrlChange: (url: Url.Url) => ChangedUrl({ slug: slugForPath(url.pathname) }),
    onUrlRequest: (request: Navigation.UrlRequest) => ClickedLink({ request }),
  },
  container: document.getElementById('root')!,
})

Runtime.run(application)
