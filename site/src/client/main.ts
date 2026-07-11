import { Array, Effect, Match, Option, pipe, Schema as S } from 'effect'
import { Command, Navigation, Runtime, Url } from '@athrio/foldkit'
import { type Document, type Html } from '@athrio/foldkit/html'
import { WovenPageSchema } from '@athrio/loom-lang/weave/WovenCorpus'
import type {
  WovenBlock,
  WovenNavEntry,
  WovenPage,
  WovenPart,
} from '@athrio/loom-lang/weave/WovenCorpus'
import { marked } from 'marked'
import {
  ChangedUrl,
  ClickedCopy,
  ClickedLink,
  CompletedNavigation,
  Flags,
  GotPage,
  Model,
  ToggledNav,
  ToggledTheme,
  ToggledToc,
  firstSlugOf,
  h,
  pageOf,
  pathForSlug,
  routeForPath,
  Message,
} from './model'
import { landingView } from './landing'

const FetchPage = Command.define(
  'FetchPage',
  { slug: S.String },
  GotPage,
)(({ slug }) =>
  Effect.promise(() =>
    fetch(`/data/pages/${slug}.json`).then((response) => response.json()),
  ).pipe(
    Effect.map((data) =>
      GotPage({ slug, page: S.decodeUnknownSync(WovenPageSchema)(data) }),
    ),
  ),
)

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

const CopyToClipboard = Command.define(
  'CopyToClipboard',
  { text: S.String },
  CompletedNavigation,
)(({ text }) =>
  Effect.promise(() => navigator.clipboard.writeText(text)).pipe(
    Effect.as(CompletedNavigation()),
  ),
)

const flags: Effect.Effect<Flags> = Effect.gen(function* () {
  const inline = Option.fromNullishOr(
    document.getElementById('loom-data')?.textContent,
  )
  return yield* Option.match(inline, {
    onSome: (text) =>
      Effect.succeed(S.decodeUnknownSync(Flags)(JSON.parse(text))),
    onNone: () =>
      Effect.promise(() =>
        fetch('/data/nav.json').then((response) => response.json()),
      ).pipe(Effect.map((nav) => S.decodeUnknownSync(Flags)({ nav }))),
  })
})

const pageCommands = (
  route: Model['route'],
  pages: ReadonlyArray<WovenPage>,
): ReadonlyArray<Command.Command<Message>> =>
  route._tag === 'Docs' && Option.isNone(pageOf(pages, route.slug))
    ? [FetchPage({ slug: route.slug })]
    : []

const init = (
  flagsIn: Flags,
  url: Url.Url,
): readonly [Model, ReadonlyArray<Command.Command<Message>>] => {
  const route = routeForPath(flagsIn.nav, url.pathname)
  const pages = flagsIn.page ? [flagsIn.page] : []
  return [
    {
      route,
      theme: 'dark',
      navClosed: false,
      tocClosed: false,
      nav: flagsIn.nav,
      pages,
    },
    pageCommands(route, pages),
  ]
}

const update = (
  model: Model,
  message: Message,
): readonly [Model, ReadonlyArray<Command.Command<Message>>] =>
  Match.value(message).pipe(
    Match.withReturnType<readonly [Model, ReadonlyArray<Command.Command<Message>>]>(),
    Match.tagsExhaustive({
      ChangedUrl: ({ pathname }) => {
        const route = routeForPath(model.nav, pathname)
        return [{ ...model, route, navClosed: false }, pageCommands(route, model.pages)]
      },
      ClickedLink: ({ request }) =>
        Match.value(request).pipe(
          Match.withReturnType<readonly [Model, ReadonlyArray<Command.Command<Message>>]>(),
          Match.tag('Internal', ({ url }) => [model, [NavigateInternal({ url: Url.toString(url) })]]),
          Match.tag('External', ({ href }) => [model, [NavigateExternal({ href })]]),
          Match.exhaustive,
        ),
      GotPage: ({ page }) =>
        Option.isSome(pageOf(model.pages, page.slug))
          ? [model, []]
          : [{ ...model, pages: [...model.pages, page] }, []],
      CompletedNavigation: () => [model, []],
      ToggledTheme: () => [{ ...model, theme: model.theme === 'dark' ? 'light' : 'dark' }, []],
      ToggledNav: () => [{ ...model, navClosed: !model.navClosed }, []],
      ToggledToc: () => [{ ...model, tocClosed: !model.tocClosed }, []],
      ClickedCopy: ({ text }) => [model, [CopyToClipboard({ text })]],
    }),
  )

const headingClass = (level: number): string =>
  Match.value(level).pipe(
    Match.when(1, () => 'loom-h1'),
    Match.when(2, () => 'loom-h2'),
    Match.orElse(() => 'loom-h3'),
  )

const headingTag = (level: number) =>
  Match.value(level).pipe(
    Match.when(1, () => h.h1),
    Match.when(2, () => h.h2),
    Match.orElse(() => h.h3),
  )

const headingView = (block: Extract<WovenBlock, { type: 'heading' }>): Html =>
  headingTag(block.level)([h.Id(block.id), h.Class(headingClass(block.level))], [block.title])

const proseView = (block: Extract<WovenBlock, { type: 'prose' }>): Html =>
  h.div([h.InnerHTML(marked.parse(block.markdown) as string)], [])

const codeSegments = (
  block: Extract<WovenBlock, { type: 'code' }>,
): ReadonlyArray<string | Html> => {
  const walked = Array.reduce(
    block.links,
    { nodes: [] as ReadonlyArray<string | Html>, cursor: 0 },
    (acc, link) => ({
      nodes: [
        ...acc.nodes,
        block.code.slice(acc.cursor, link.offset),
        h.a(
          [h.Class('loom-anchor'), h.Href(pathForSlug(link.targetSlug))],
          [block.code.slice(link.offset, link.offset + link.length)],
        ),
      ],
      cursor: link.offset + link.length,
    }),
  )
  return [...walked.nodes, block.code.slice(walked.cursor)]
}

const codeView = (block: Extract<WovenBlock, { type: 'code' }>): Html =>
  h.div([h.Class('loom-code')], [h.pre([], [h.code([], codeSegments(block))])])

const noteView = (block: Extract<WovenBlock, { type: 'note' }>): Html =>
  h.aside(
    [h.Class('loom-callout')],
    [
      h.div([h.Class('loom-callout-label')], ['Note']),
      h.div([h.InnerHTML(marked.parse(block.markdown) as string)], []),
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

type Heading = { readonly id: string; readonly level: number; readonly title: string }

const headingsOf = (page: WovenPage): ReadonlyArray<Heading> =>
  pipe(
    page.blocks,
    Array.map((block) =>
      block.type === 'heading' && block.level >= 2
        ? Option.some<Heading>({ id: block.id, level: block.level, title: block.title })
        : Option.none<Heading>(),
    ),
    Array.getSomes,
  )

const subHeadingView = (heading: Heading): Html =>
  h.li(
    [h.Key(heading.id)],
    [h.a([h.Href(`#${heading.id}`)], [h.span([h.Class('loom-sublist-dot')], []), heading.title])],
  )

const chapterView =
  (pages: ReadonlyArray<WovenPage>, current: string) =>
  (chapter: WovenNavEntry): Html => {
    const active = chapter.slug === current
    const subHeadings = active
      ? pipe(
          pageOf(pages, chapter.slug),
          Option.map(headingsOf),
          Option.getOrElse(() => [] as ReadonlyArray<Heading>),
        )
      : []
    return h.li(
      active ? [h.Key(chapter.slug), h.Class('is-active')] : [h.Key(chapter.slug)],
      [
        h.a(
          [h.Class('loom-sidebar-item'), h.Href(pathForSlug(chapter.slug))],
          [
            h.span([h.Class('loom-sidebar-rail')], []),
            h.span([h.Class('loom-sidebar-num')], [chapter.number]),
            h.span([], [chapter.title]),
          ],
        ),
        ...(active
          ? [h.ul([h.Class('loom-sidebar-sublist')], Array.map(subHeadings, subHeadingView))]
          : []),
      ],
    )
  }

const partView =
  (pages: ReadonlyArray<WovenPage>, current: string) =>
  (part: WovenPart): Html =>
    h.div(
      [h.Class('loom-sidebar-section'), h.Key(part.number)],
      [
        h.div([h.Class('loom-sidebar-heading')], [part.name]),
        ...(part.chapters.length > 0
          ? [h.ul([h.Class('loom-sidebar-list')], Array.map(part.chapters, chapterView(pages, current)))]
          : []),
      ],
    )

const sidebarView = (
  nav: ReadonlyArray<WovenPart>,
  pages: ReadonlyArray<WovenPage>,
  current: string,
): Html =>
  h.aside(
    [h.Class('loom-sidebar')],
    [
      h.div(
        [h.Class('loom-sidebar-inner')],
        [
          ...Array.map(nav, partView(pages, current)),
          h.div([h.Class('loom-sidebar-footer')], [h.div([h.Class('loom-sidebar-kicker')], ['loom · v0.9.0'])]),
        ],
      ),
    ],
  )

const outlineEntryView = (heading: Heading): Html =>
  h.li(
    heading.level >= 3 ? [h.Key(heading.id), h.Class('loom-toc-sub')] : [h.Key(heading.id)],
    [h.a([h.Href(`#${heading.id}`)], [h.span([h.Class('loom-toc-rail')], []), heading.title])],
  )

const outlineView = (page: WovenPage): Html =>
  h.aside(
    [h.Class('loom-toc')],
    [
      h.div([h.Class('loom-toc-heading')], ['On this page']),
      h.ul([h.Class('loom-toc-list')], Array.map(headingsOf(page), outlineEntryView)),
      h.div([h.Class('loom-toc-footer')], [h.a([h.Href('/')], ['Home']), h.a([h.Href('/')], ['Source'])]),
    ],
  )

const topBarView = (model: Model): Html =>
  h.div(
    [h.Class('loom-topbar')],
    [
      h.div(
        [h.Class('loom-topbar-left')],
        [
          ...(model.route._tag === 'Docs'
            ? [h.button([h.Class('loom-icon-btn'), h.OnClick(ToggledNav())], ['☰'])]
            : []),
          h.a(
            [h.Class('loom-wordmark'), h.Href('/')],
            [
              h.span([h.Class('loom-wordmark-mark')], ['~']),
              h.span([h.Class('loom-wordmark-text')], ['loom']),
              h.span([h.Class('loom-wordmark-ver')], ['v0.9.0']),
            ],
          ),
        ],
      ),
      h.nav(
        [h.Class('loom-topnav')],
        [
          h.a(
            [
              h.Class(model.route._tag === 'Docs' ? 'loom-topnav-item loom-topnav-active' : 'loom-topnav-item'),
              h.Href(pathForSlug(firstSlugOf(model.nav))),
            ],
            ['Docs'],
          ),
        ],
      ),
      h.div(
        [h.Class('loom-topbar-right')],
        [
          h.button(
            [h.Class('loom-theme-toggle'), h.OnClick(ToggledTheme())],
            [
              h.span([h.Class(model.theme === 'dark' ? 'loom-theme-knob is-dark' : 'loom-theme-knob')], []),
              h.span([], [model.theme === 'dark' ? 'Dark' : 'Light']),
            ],
          ),
        ],
      ),
    ],
  )

const appFrame = (model: Model, content: Html): Html =>
  h.div([h.Class(`loom-app loom-theme-${model.theme}`)], [topBarView(model), content])

const mainClass = (model: Model): string =>
  model.navClosed ? 'loom-main is-wide' : 'loom-main'

const mainView = (model: Model, page: WovenPage): Html =>
  h.div(
    [h.Class(mainClass(model))],
    [
      h.article(
        [h.Class('loom-prose'), h.Key(page.slug)],
        [
          h.div(
            [h.Class('loom-breadcrumbs')],
            [
              ...(page.part ? [h.span([], [page.part]), h.span([h.Class('loom-crumb-sep')], ['›'])] : []),
              h.span([h.Class('is-current')], [page.title]),
            ],
          ),
          ...Array.map(page.blocks, blockView),
        ],
      ),
    ],
  )

const loadingView = (model: Model): Html =>
  h.div(
    [h.Class(mainClass(model))],
    [h.article([h.Class('loom-prose')], [h.p([h.Class('loom-loading')], ['Loading…'])])],
  )

const shellClass = (model: Model): string =>
  ['loom-shell', model.navClosed ? 'no-left' : '', model.tocClosed ? 'no-right' : '']
    .filter(Boolean)
    .join(' ')

const docsShell = (
  model: Model,
  slug: string,
  page: Option.Option<WovenPage>,
): Html =>
  h.div(
    [h.Class(shellClass(model))],
    [
      ...(model.navClosed ? [] : [sidebarView(model.nav, model.pages, slug)]),
      Option.match(page, {
        onSome: (loaded) => mainView(model, loaded),
        onNone: () => loadingView(model),
      }),
      ...(model.tocClosed
        ? []
        : Option.match(page, { onSome: (loaded) => [outlineView(loaded)], onNone: () => [] })),
    ],
  )

const view = (model: Model): Document =>
  Match.value(model.route).pipe(
    Match.withReturnType<Document>(),
    Match.tag('Landing', () => ({
      title: 'Loom — literate programming',
      body: appFrame(model, landingView(firstSlugOf(model.nav))),
    })),
    Match.tag('Docs', ({ slug }) => {
      const page = pageOf(model.pages, slug)
      const title = Option.match(page, {
        onSome: (loaded) => `${loaded.title} · Loom`,
        onNone: () => 'Loom',
      })
      return { title, body: appFrame(model, docsShell(model, slug, page)) }
    }),
    Match.exhaustive,
  )

const application = Runtime.makeApplication({
  Model,
  Flags,
  flags,
  init,
  update,
  view,
  routing: {
    onUrlChange: (url: Url.Url) => ChangedUrl({ pathname: url.pathname }),
    onUrlRequest: (request: Navigation.UrlRequest) => ClickedLink({ request }),
  },
  devTools: {
    show: 'Development',
    Message,
  },
  container: document.getElementById('root')!,
})

Runtime.run(application)
