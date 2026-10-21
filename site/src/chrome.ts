import { Array, Match, Option, pipe } from 'effect'
import type { Attribute, Html, HtmlBuilder } from 'foldkit/html'
import {
  ClosedSearch,
  drawsInPlace,
  MovedFocus,
  OpenedDrawer,
  OpenedHit,
  OpenedSearch,
  ToggledExact,
  Typed,
  WentTo,
  type Message,
  type Model,
  type Route,
  type SearchGroup,
  type SearchHit,
} from './model'
import {
  externalIcon,
  broadSeam,
  burgerIcon,
  carpetMark,
  communityCarpet,
  exampleCarpet,
  docsCarpet,
  loomMark,
  moonIcon,
  sourceCarpet,
  sunIcon,
  systemIcon,
  whyLoomCarpet,
  type Carpet,
} from './components'

export type NavPage = {
  readonly route: Route
  readonly label: string
  readonly href: string
  readonly carpet: Carpet
}

export const navPages: ReadonlyArray<NavPage> = [
  { route: 'docs', label: 'docs', href: '/docs', carpet: docsCarpet },
  { route: 'community', label: 'community', href: '/community', carpet: communityCarpet },
  { route: 'why-loom', label: 'why loom', href: '/why-loom', carpet: whyLoomCarpet },
  { route: 'source', label: 'source', href: '/source', carpet: sourceCarpet },
]

const switchesTo = (route: Route, h: HtmlBuilder<Message>): ReadonlyArray<Attribute<Message>> =>
  drawsInPlace(route) ? [h.OnClick(WentTo({ route }))] : []

const navLink = (page: NavPage, here: boolean, h: HtmlBuilder<Message>): Html =>
  h.a(
    [
      h.Class(here ? 'nav-link here' : 'nav-link'),
      h.Href(page.href),
      ...switchesTo(page.route, h),
    ],
    [page.label],
  )

const hasChapters = (route: Route): boolean => route === 'docs' || route === 'source'

const burger = (route: Route, h: HtmlBuilder<Message>): ReadonlyArray<Html> =>
  hasChapters(route)
    ? [
        h.button(
          [
            h.Class('nav-burger'),
            h.Type('button'),
            h.AriaLabel('Chapters'),
            h.OnClick(OpenedDrawer()),
          ],
          [burgerIcon()],
        ),
      ]
    : []

export const nav = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.nav(
    [h.Class(hasChapters(model.route) ? 'nav docs-nav' : 'nav'), h.Role('navigation')],
    [
      ...burger(model.route, h),
      ...Array.map(Array.take(navPages, 2), (page) => navLink(page, page.route === model.route, h)),
      h.a(
        [
          h.Class('nav-word'),
          h.Href('/'),
          h.AriaLabel('Loom, in beta'),
          h.OnClick(WentTo({ route: 'home' })),
        ],
        [
          'Loom',
          h.span([h.Class('nav-beta'), h.AriaHidden(true)], ['beta']),
        ],
      ),
      ...Array.map(Array.drop(navPages, 2), (page) => navLink(page, page.route === model.route, h)),
      h.div([h.Class('nav-end')], [findButton('nav-find', 'Search Loom — press /', h), themeSwitch(h)]),
    ],
  )

const findButton = (className: string, title: string, h: HtmlBuilder<Message>): Html =>
  h.button(
    [
      h.Class(className),
      h.Type('button'),
      h.AriaLabel('Navigate and search'),
      h.Title(title),
      h.OnClick(OpenedSearch()),
    ],
    [
      h.span([h.Class('wide')], ['search']),
      h.span([h.Class('narrow')], ['menu']),
      h.span([h.Class('nav-key'), h.AriaHidden(true)], ['/']),
    ],
  )

const THEME_FACES: ReadonlyArray<readonly [string, string, () => Html]> = [
  ['light', 'Theme: light', sunIcon],
  ['system', 'Theme: system', systemIcon],
  ['dark', 'Theme: dark', moonIcon],
]

const themeSwitch = (h: HtmlBuilder<Message>): Html =>
  h.button(
    [h.Class('theme-switch'), h.Type('button'), h.DataAttribute('theme-toggle', ''), h.Title('Theme')],
    Array.map(THEME_FACES, ([face, label, icon]) =>
      h.span([h.Class(`theme-face ${face}`)], [icon(), h.span([h.Class('hush')], [label])]),
    ),
  )

type Neighbour = {
  readonly route: Route
  readonly label: string
  readonly href: string
  readonly carpet: Carpet
  readonly ink: string
}

const readingOrder: ReadonlyArray<Neighbour> = [
  {
    route: 'docs',
    label: 'Docs',
    href: '/docs',
    carpet: docsCarpet,
    ink: '#1D4FBF',
  },
  {
    route: 'community',
    label: 'Community',
    href: '/community',
    carpet: communityCarpet,
    ink: '#6D3BD4',
  },
  {
    route: 'home',
    label: 'Loom',
    href: '/',
    carpet: exampleCarpet,
    ink: '#00714F',
  },
  {
    route: 'why-loom',
    label: 'Why Loom',
    href: '/why-loom',
    carpet: whyLoomCarpet,
    ink: '#C08A00',
  },
  {
    route: 'source',
    label: 'Source',
    href: '/source',
    carpet: sourceCarpet,
    ink: '#C2410C',
  },
]

const pagerCard = (
  page: Neighbour,
  direction: 'Previous' | 'Next',
  h: HtmlBuilder<Message>,
): Html => {
  const mark = carpetMark(page.carpet, '42px', broadSeam)
  const words = h.div(
    [h.Class('pager-words')],
    [h.span([h.Class('eyebrow')], [direction]), h.span([h.Class('pager-title')], [page.label])],
  )
  return h.a(
    [
      h.Class(direction === 'Next' ? 'pager-card next' : 'pager-card'),
      h.Href(page.href),
      h.Style({ '--pg-ink': page.ink }),
      ...switchesTo(page.route, h),
    ],
    direction === 'Next' ? [words, mark] : [mark, words],
  )
}

export const pager = (route: Route, h: HtmlBuilder<Message>): Html => {
  const at = Array.findFirstIndex(readingOrder, (page) => page.route === route)
  const step = (by: number): Option.Option<Neighbour> =>
    pipe(
      at,
      Option.flatMap((index) => Option.fromNullishOr(readingOrder[index + by])),
    )
  return h.div(
    [h.Class('pager'), h.Id('loom-pager')],
    [
      h.div(
        [h.Class('pager-row')],
        [
          ...Option.toArray(Option.map(step(-1), (page) => pagerCard(page, 'Previous', h))),
          ...Option.toArray(Option.map(step(1), (page) => pagerCard(page, 'Next', h))),
        ],
      ),
    ],
  )
}

export type SearchPage = {
  readonly route: Route
  readonly label: string
  readonly path: string
  readonly ink: string
  readonly rgb: string
}

export const searchPages: ReadonlyArray<SearchPage> = [
  { route: 'docs', label: 'Docs', path: '/docs', ink: '#6E9BFF', rgb: '110, 155, 255' },
  { route: 'source', label: 'Source', path: '/source', ink: '#19D69C', rgb: '25, 214, 156' },
  { route: 'why-loom', label: 'Why Loom', path: '/why-loom', ink: '#FF6A3D', rgb: '255, 106, 61' },
  { route: 'community', label: 'Community', path: '/community', ink: '#F45C9F', rgb: '244, 92, 159' },
  { route: 'home', label: 'Loom', path: '/', ink: '#F2EFE6', rgb: '242, 239, 230' },
  { route: 'license', label: 'License', path: '/license', ink: '#FFC53D', rgb: '255, 197, 61' },
]

const searchPageOf = (route: Route): SearchPage =>
  pipe(
    Array.findFirst(searchPages, (page) => page.route === route),
    Option.getOrElse(() => searchPages[0] as SearchPage),
  )

export type Focusable =
  | { readonly kind: 'page'; readonly page: SearchPage }
  | { readonly kind: 'hit'; readonly page: SearchPage; readonly hit: SearchHit }

export const focusables = (groups: ReadonlyArray<SearchGroup>): ReadonlyArray<Focusable> =>
  Array.flatMap(groups, (group) => {
    const page = searchPageOf(group.route)
    return [
      { kind: 'page' as const, page },
      ...Array.map(group.hits, (hit) => ({ kind: 'hit' as const, page, hit })),
    ]
  })

const focusedIn = (list: ReadonlyArray<Focusable>, focus: number): Option.Option<Focusable> =>
  Option.fromNullishOr(list[Math.min(focus, Math.max(0, list.length - 1))])

const wordsOf = (hit: SearchHit): string => (hit.hit === '' ? hit.heading : hit.hit)

const LEAD_IN = 24

const beforeOf = (hit: SearchHit): string =>
  hit.hit === '' ? '' : hit.pre.replace(/^…/, '').slice(-LEAD_IN)

const openedRow = (focusable: Focusable): Message =>
  Match.value(focusable).pipe(
    Match.when({ kind: 'page' }, (row) => OpenedHit({ href: row.page.path, words: '', before: '' })),
    Match.when({ kind: 'hit' }, (row) => openedHit(row.hit)),
    Match.exhaustive,
  )

const openedHit = (hit: SearchHit): Message =>
  OpenedHit({ href: hit.href, words: wordsOf(hit), before: beforeOf(hit) })

const paletteKey = (key: string, model: Model): Message => {
  const list = focusables(model.found)
  const stay = MovedFocus({ delta: 0, count: list.length })
  return Match.value(key).pipe(
    Match.when('Escape', () => ClosedSearch()),
    Match.when('ArrowDown', () => MovedFocus({ delta: 1, count: list.length })),
    Match.when('ArrowUp', () => MovedFocus({ delta: -1, count: list.length })),
    Match.when('Enter', () =>
      pipe(
        focusedIn(list, model.focus),
        Option.match({
          onNone: () => stay,
          onSome: openedRow,
        }),
      ),
    ),
    Match.orElse(() => stay),
  )
}

const caretMirror = (model: Model, h: HtmlBuilder<Message>): Html => {
  const at = Math.min(model.caret, model.query.length)
  return h.span(
    [h.Class('palette-mirror'), h.AriaHidden(true)],
    [model.query.slice(0, at), h.span([h.Class('palette-caret')], [model.query.charAt(at)])],
  )
}

const queryField = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.span(
    [h.Class('palette-field')],
    [
      h.input([
        h.Class('palette-input'),
        h.Value(model.query),
        h.Placeholder('Go to a page, or search'),
        h.Spellcheck(false),
        h.Style({ textIndent: model.query === '' ? '13px' : '0' }),
        h.OnInput((query) => Typed({ query })),
        h.OnKeyDown((key) => paletteKey(key, model)),
      ]),
      caretMirror(model, h),
    ],
  )

const exactSwitch = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.button(
    [
      h.Class(model.exact ? 'palette-exact on' : 'palette-exact'),
      h.Type('button'),
      h.AriaPressed(model.exact ? 'true' : 'false'),
      h.Title('Search the exact words'),
      h.OnClick(ToggledExact()),
    ],
    ['exact'],
  )

type Pill = {
  readonly label: string
  readonly href: string
  readonly mark: Html
}

const pills: ReadonlyArray<Pill> = [
  ...Array.map(navPages, (page) => ({
    label: Match.value(page.route).pipe(
      Match.when('docs', () => 'Docs'),
      Match.when('community', () => 'Community'),
      Match.when('why-loom', () => 'Why Loom'),
      Match.orElse(() => 'Source'),
    ),
    href: page.href,
    mark: carpetMark(page.carpet, '17px'),
  })),
]

const pillRow = (focus: number, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('palette-pills')],
    Array.map(pills, (pill, index) =>
      h.a(
        [
          h.Class(index === Math.min(focus, pills.length - 1) ? 'pill-link here' : 'pill-link'),
          h.Href(pill.href),
          h.Style({ animationDelay: `${40 + index * 34}ms` }),
        ],
        [pill.mark, pill.label],
      ),
    ),
  )

const wash = (page: SearchPage, focused: boolean): string =>
  focused ? `rgba(${page.rgb}, 0.15)` : 'transparent'

const whereOf = (hit: SearchHit): string =>
  hit.heading === '' || hit.heading === hit.place ? hit.place : `${hit.place} › ${hit.heading}`

const hitRow = (page: SearchPage, hit: SearchHit, focused: boolean, h: HtmlBuilder<Message>): Html =>
  h.a(
    [
      h.Class(focused ? 'palette-row here' : 'palette-row'),
      h.Href(hit.href),
      h.Style({ background: wash(page, focused) }),
      h.OnClick(openedHit(hit), { defaultAction: 'Prevent' }),
    ],
    [
      h.span([h.Class('sigil'), h.Style({ color: focused ? page.ink : '#4E5D8C' })], ['>']),
      h.span(
        [h.Class('fragment')],
        [hit.pre, h.span([h.Class('palette-hit'), h.Style({ color: page.ink })], [hit.hit]), hit.post],
      ),
      h.span([h.Class('where')], [whereOf(hit)]),
    ],
  )

const groupBlock = (
  group: SearchGroup,
  focus: number,
  from: number,
  h: HtmlBuilder<Message>,
): Html => {
  const page = searchPageOf(group.route)
  return h.div(
    [h.Class('palette-kids-wrap')],
    [
      h.a(
        [
          h.Class('palette-group'),
          h.Href(page.path),
          h.Style({ background: wash(page, focus === from) }),
          h.OnClick(ClosedSearch()),
        ],
        [
          h.span([h.Class('sigil'), h.Style({ color: page.ink })], ['~']),
          h.span([h.Class('name')], [page.label]),
          h.span([h.Class('path')], [page.path]),
        ],
      ),
      h.div(
        [h.Class('palette-kids')],
        Array.map(group.hits, (hit, index) => hitRow(page, hit, focus === from + 1 + index, h)),
      ),
    ],
  )
}

const focusedPage = (model: Model): SearchPage =>
  pipe(
    focusedIn(focusables(model.found), model.focus),
    Option.map((focusable) => focusable.page),
    Option.getOrElse(() => searchPages[0] as SearchPage),
  )

const results = (model: Model, h: HtmlBuilder<Message>): Html => {
  const groups = model.found
  const starts = pipe(
    groups,
    Array.map((group) => group.hits.length + 1),
    Array.reduce([0] as ReadonlyArray<number>, (acc, size) => [
      ...acc,
      (acc[acc.length - 1] ?? 0) + size,
    ]),
  )
  return h.div(
    [h.Class('palette-body')],
    groups.length === 0
      ? [h.span([h.Class('palette-empty')], [`no match for “${model.query.trim()}”`])]
      : Array.map(groups, (group, index) =>
          groupBlock(group, model.focus, starts[index] ?? 0, h),
        ),
  )
}

const searching = (page: SearchPage, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Style({ display: 'flex', flexDirection: 'column', flex: 'none' })],
    [
      h.span(
        [
          h.Class('palette-stitch'),
          h.AriaHidden(true),
          h.Style({
            background: `repeating-linear-gradient(90deg, ${page.ink} 0 6px, transparent 6px 12px)`,
          }),
        ],
        [],
      ),
      h.span([h.Class('palette-loading')], ['searching']),
    ],
  )

const countOf = (total: number): string => `${total} ${total === 1 ? 'result' : 'results'}`

const hintBar = (model: Model, page: SearchPage, h: HtmlBuilder<Message>): Html =>
  h.div(
    [
      h.Class('palette-bar'),
      h.Style({
        background: `rgba(${page.rgb}, 0.13)`,
        borderTopColor: `rgba(${page.rgb}, 0.28)`,
        color: page.ink,
      }),
    ],
    [
      h.span([h.Class('palette-key')], ['↑↓ move']),
      h.span([h.Class('palette-key')], ['⏎ open']),
      h.span(
        [h.Class('count')],
        [countOf(Array.reduce(model.found, 0, (total, group) => total + group.hits.length))],
      ),
    ],
  )

const paletteMiddle = (
  model: Model,
  page: SearchPage,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html> =>
  Match.value({
    typed: model.query.trim() !== '',
    settling: model.searching && model.found.length === 0,
  }).pipe(
    Match.when({ typed: false }, () => [pillRow(model.focus, h)]),
    Match.when({ settling: true }, () => [searching(page, h)]),
    Match.orElse(() => [results(model, h), hintBar(model, page, h)]),
  )

export const palette = (model: Model, h: HtmlBuilder<Message>): Html => {
  const page = focusedPage(model)
  return h.div(
    [h.Class('palette-shell'), h.Role('dialog')],
    [
      h.div([h.Class('palette-scrim'), h.OnClick(ClosedSearch())], []),
      h.div(
        [h.Class('palette-card')],
        [
          h.div(
            [h.Class('palette-head')],
            [
              queryField(model, h),
              exactSwitch(model, h),
              h.button(
                [
                  h.Class('palette-esc'),
                  h.Type('button'),
                  h.AriaLabel('Close search'),
                  h.OnClick(ClosedSearch()),
                ],
                [h.span([h.Class('cross')], ['×']), h.span([h.Class('palette-key')], ['esc'])],
              ),
            ],
          ),
          ...paletteMiddle(model, page, h),
        ],
      ),
    ],
  )
}

type FooterLink = { readonly label: string; readonly href: string; readonly ink: string }

const leavesSite = (link: FooterLink): boolean => /^https?:\/\//.test(link.href)

const footerLinks: ReadonlyArray<FooterLink> = [
  { label: 'Docs', href: '/docs', ink: '#6E9BFF' },
  { label: 'Source', href: '/source', ink: '#FF6A3D' },
  { label: 'Why Loom?', href: '/why-loom', ink: '#FFC53D' },
  { label: 'Community', href: '/community', ink: '#A987FF' },
  { label: 'Telegram', href: 'https://t.me/athrio', ink: '#26A5E4' },
  { label: 'Github', href: 'https://github.com/athrio-com/loom', ink: '#19D69C' },
  { label: 'License', href: '/license', ink: '#FFC53D' },
  { label: 'About Nonprofit', href: 'https://qda.ee', ink: '#6E9BFF' },
]

export const footer = (h: HtmlBuilder<Message>): Html =>
  h.footer(
    [h.Class('footer')],
    [
      h.div(
        [h.Class('footer-inner')],
        [
          h.div(
            [h.Class('footer-top')],
            [
              h.div(
                [h.Class('footer-brand')],
                [
                  h.div(
                    [h.Class('footer-mark')],
                    [loomMark('dark', 0.78), h.div([h.Class('footer-word')], ['Loom'])],
                  ),
                  h.div(
                    [h.Class('footer-blurb')],
                    ['Literate programming framework where reasoning is the source.'],
                  ),
                ],
              ),
              h.div(
                [h.Class('footer-chips')],
                Array.map(footerLinks, (link) =>
                  h.a(
                    [
                      h.Class('footer-chip'),
                      h.Href(link.href),
                      h.Style({ '--chip-ink': link.ink }),
                      ...(leavesSite(link)
                        ? [h.Target('_blank'), h.Rel('noopener noreferrer')]
                        : []),
                    ],
                    [link.label, ...(leavesSite(link) ? [externalIcon()] : [])],
                  ),
                ),
              ),
            ],
          ),
          h.div([h.Class('footer-bottom')], [h.span([], ['© Quadrivium Academy Sihtasutus 2026'])]),
        ],
      ),
    ],
  )
