import { Array, Match, Option, pipe } from 'effect'
import { inertHtml as ih, type Html, type HtmlBuilder } from 'foldkit/html'
import {
  ClosedSearch,
  MovedFocus,
  OpenedDrawer,
  OpenedSearch,
  Typed,
  WentTo,
  type Message,
  type Model,
  type Route,
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
  octocatIcon,
  sourceCarpet,
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

const navLink = (page: NavPage, here: boolean, h: HtmlBuilder<Message>): Html =>
  h.a(
    [
      h.Class(here ? 'nav-link here' : 'nav-link'),
      h.Href(page.href),
      h.OnClick(WentTo({ route: page.route })),
    ],
    [page.label],
  )

export const nav = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.nav(
    [h.Class('nav'), h.Role('navigation')],
    [
      ...Array.map(Array.take(navPages, 2), (page) => navLink(page, page.route === model.route, h)),
      h.a(
        [
          h.Class('nav-word'),
          h.Href('/'),
          h.AriaLabel('Loom'),
          h.OnClick(WentTo({ route: 'home' })),
        ],
        ['Loom'],
      ),
      ...Array.map(Array.drop(navPages, 2), (page) => navLink(page, page.route === model.route, h)),
      findButton('nav-find', 'Search Loom — press /', h),
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
      h.span([h.Class('narrow')], ['navs']),
      h.span([h.Class('nav-key'), h.AriaHidden(true)], ['/']),
    ],
  )

const REPO = 'https://github.com/athrio-com/loom'

export const docsBar = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class(model.navHidden ? 'docs-bar hidden' : 'docs-bar')],
    [
      h.button(
        [
          h.Class('bar-burger'),
          h.Type('button'),
          h.Title('Menu'),
          h.AriaLabel('Menu'),
          h.OnClick(OpenedDrawer()),
        ],
        [burgerIcon()],
      ),
      h.a(
        [h.Class('bar-word'), h.Href('/'), h.AriaLabel('Loom'), h.OnClick(WentTo({ route: 'home' }))],
        [loomMark('paper', 0.495), h.span([h.Class('bar-word-text')], ['Loom'])],
      ),
      h.div(
        [h.Class('bar-links')],
        Array.map(navPages, (page) => navLink(page, page.route === model.route, h)),
      ),
      h.div(
        [h.Class('bar-end')],
        [
          findButton('bar-find', 'Search the docs — press /', h),
          h.a(
            [h.Class('bar-repo'), h.Href(REPO), h.Title('View the repo on GitHub')],
            [octocatIcon('15'), h.span([], [`v${model.version}`])],
          ),
        ],
      ),
    ],
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
    [
      h.span([h.Class('eyebrow')], [direction]),
      h.span([h.Class('pager-title')], [page.label]),
    ],
  )
  return h.a(
    [
      h.Class(direction === 'Next' ? 'pager-card next' : 'pager-card'),
      h.Href(page.href),
      h.Style({ '--pg-ink': page.ink }),
      h.OnClick(WentTo({ route: page.route })),
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

const docsPagerCard = (
  page: Neighbour,
  direction: 'Previous' | 'Next',
  h: HtmlBuilder<Message>,
): Html =>
  h.a(
    [
      h.Class(direction === 'Next' ? 'docs-pager-card next' : 'docs-pager-card'),
      h.Href(page.href),
      h.OnClick(WentTo({ route: page.route })),
    ],
    [
      h.span([h.Class('eyebrow')], [direction]),
      h.span([h.Class('pager-title')], [page.label]),
    ],
  )

export const docsPager = (route: Route, h: HtmlBuilder<Message>): Html => {
  const at = Array.findFirstIndex(readingOrder, (page) => page.route === route)
  const step = (by: number): Option.Option<Neighbour> =>
    pipe(
      at,
      Option.flatMap((index) => Option.fromNullishOr(readingOrder[index + by])),
    )
  return h.div(
    [h.Class('docs-pager')],
    [
      ...Option.toArray(Option.map(step(-1), (page) => docsPagerCard(page, 'Previous', h))),
      ...Option.toArray(Option.map(step(1), (page) => docsPagerCard(page, 'Next', h))),
    ],
  )
}

export type SearchPage = {
  readonly route: Route
  readonly label: string
  readonly path: string
  readonly ink: string
  readonly rgb: string
  readonly text: string
}

export const searchPages: ReadonlyArray<SearchPage> = [
  {
    route: 'docs',
    label: 'Docs',
    path: '/docs',
    ink: '#6E9BFF',
    rgb: '110, 155, 255',
    text: 'The eight marks, and what tangling does with them.',
  },
  {
    route: 'why-loom',
    label: 'Why Loom',
    path: '/why-loom',
    ink: '#FF6A3D',
    rgb: '255, 106, 61',
    text: 'The case for writing the document first.',
  },
  {
    route: 'community',
    label: 'Community',
    path: '/community',
    ink: '#F45C9F',
    rgb: '244, 92, 159',
    text: 'People, help and the changelog.',
  },
  {
    route: 'home',
    label: 'Loom',
    path: '/',
    ink: '#F2EFE6',
    rgb: '242, 239, 230',
    text: 'What Loom is, in one screen.',
  },
]

export type Passage = {
  readonly route: Route
  readonly title: string
  readonly text: string
}

export const anchorMark = (name: string): string => `${':'}:[${name}]`

export const passages: ReadonlyArray<Passage> = [
  {
    route: 'docs',
    title: 'The eight marks',
    text: `Dashes --- fence the frontmatter, a # heading names a section, brackets [file.ts] name the file its code belongs to, a brace label says what Loom makes of a heading, and an anchor ${anchorMark('a section')} draws another section in whole.`,
  },
  {
    route: 'docs',
    title: 'Frontmatter',
    text: 'A chapter opens with a --- fence. Everything inside it names the chapter — the part it belongs to, the target its code is written to, and the language that code is in.',
  },
  {
    route: 'docs',
    title: 'Sections',
    text: 'A # heading and everything under it is a section. Its title is its name, and that name is what every anchor refers to.',
  },
  {
    route: 'docs',
    title: 'Parts',
    text: 'A ## heading gathers sections beneath it, so a long chapter divides without dividing what it tangles to.',
  },
  {
    route: 'docs',
    title: 'Anchors',
    text: `An anchor ${anchorMark('the parser')} draws a whole section in by name, and tangling checks it, so a renamed section fails loudly rather than quietly.`,
  },
  {
    route: 'docs',
    title: 'Opening and closing code',
    text: 'The => operator opens a code block and the ~ separator closes it, so prose and code alternate freely down the page.',
  },
  {
    route: 'docs',
    title: 'Tangling',
    text: 'loom tangle walks the corpus and writes every code block out to a real file; loom weave renders the same corpus as a document.',
  },
  {
    route: 'why-loom',
    title: 'The three approaches',
    text: 'Prompt engineering, spec-driven work, hooks and skills — each one holds until the document stops matching the source.',
  },
  {
    route: 'why-loom',
    title: 'Writing the document first',
    text: 'When the document is the source, the explanation cannot drift: tangling fails before the two can disagree.',
  },
  {
    route: 'community',
    title: 'Corpora in the wild',
    text: 'Projects whose documentation is the source: parsers, compilers, and a handful of production services.',
  },
  {
    route: 'community',
    title: 'Editor support',
    text: 'Highlighting, jump-to-section and tangle-on-save for every mark, in the editors people actually use.',
  },
  {
    route: 'home',
    title: 'A Loom document, written out',
    text: 'Typed from the top: the prose explains each mark as it appears, and the code beneath it tangles into hello.ts.',
  },
  {
    route: 'home',
    title: 'The whole vocabulary',
    text: 'Eight marks and nothing else — frontmatter, heading, sink, label, open, close, anchor and warp.',
  },
  {
    route: 'home',
    title: 'From init to eject',
    text: 'loom init scaffolds a corpus, tangle writes the files, weave renders the document, and eject leaves plain source behind.',
  },
]

export type Fragment = {
  readonly pre: string
  readonly hit: string
  readonly post: string
}

const WINDOW = 62
const LEAD_IN = 22

const toWordBreak = (text: string): string => text.replace(/\s+\S*$/, '')

const clipped = (text: string): string =>
  text.length > WINDOW ? `${toWordBreak(text.slice(0, WINDOW))}…` : text

const whole = (text: string): Fragment => ({ pre: clipped(text), hit: '', post: '' })

const indexOfIgnoringCase = (haystack: string, needle: string): Option.Option<number> => {
  const at = haystack.toLowerCase().indexOf(needle.toLowerCase())
  return at < 0 ? Option.none() : Option.some(at)
}

const windowedAt = (source: string, at: number, length: number): Fragment => {
  const from = Math.max(0, at - LEAD_IN)
  const space = source.indexOf(' ', from)
  const start = from > 0 && space >= 0 && space < at ? space + 1 : from
  const pre = `${start > 0 ? '…' : ''}${source.slice(start, at)}`
  const hit = source.slice(at, at + length)
  const room = Math.max(0, WINDOW - pre.length - hit.length)
  const rest = source.slice(at + length)
  const post = rest.length > room ? `${toWordBreak(rest.slice(0, room))}…` : rest
  return { pre, hit, post }
}

export const fragmentOf = (passage: Passage, query: string): Fragment => {
  const needle = query.trim()
  const titled = `${passage.title} · ${passage.text}`
  return needle === ''
    ? whole(passage.text)
    : pipe(
        indexOfIgnoringCase(passage.text, needle),
        Option.map((at) => windowedAt(passage.text, at, needle.length)),
        Option.orElse(() =>
          pipe(
            indexOfIgnoringCase(titled, needle),
            Option.map((at) => windowedAt(titled, at, needle.length)),
          ),
        ),
        Option.getOrElse(() => whole(passage.text)),
      )
}

export type Group = {
  readonly page: SearchPage
  readonly rows: ReadonlyArray<Passage>
}

const holds = (needle: string, text: string): boolean => text.toLowerCase().includes(needle)

export const groupsFor = (query: string): ReadonlyArray<Group> => {
  const needle = query.trim().toLowerCase()
  return needle === ''
    ? []
    : pipe(
        searchPages,
        Array.map((page) => ({
          page,
          rows: pipe(
            passages,
            Array.filter(
              (passage) =>
                passage.route === page.route &&
                holds(needle, `${passage.title} ${passage.text}`),
            ),
            Array.take(3),
          ),
        })),
        Array.filter(
          (group) =>
            group.rows.length > 0 ||
            holds(needle, `${group.page.label} ${group.page.text} ${group.page.path}`),
        ),
      )
}

export type Focusable =
  | { readonly kind: 'page'; readonly page: SearchPage }
  | { readonly kind: 'passage'; readonly page: SearchPage; readonly passage: Passage }

export const focusables = (groups: ReadonlyArray<Group>): ReadonlyArray<Focusable> =>
  pipe(
    groups,
    Array.flatMap((group) => [
      { kind: 'page' as const, page: group.page },
      ...Array.map(group.rows, (passage) => ({
        kind: 'passage' as const,
        page: group.page,
        passage,
      })),
    ]),
  )

const focusedIn = (list: ReadonlyArray<Focusable>, focus: number): Option.Option<Focusable> =>
  Option.fromNullishOr(list[Math.min(focus, Math.max(0, list.length - 1))])

const paletteKey = (key: string, model: Model): Message => {
  const list = focusables(groupsFor(model.query))
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
          onSome: (focusable) => WentTo({ route: focusable.page.route }),
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
    [
      model.query.slice(0, at),
      h.span([h.Class('palette-caret')], [model.query.charAt(at)]),
    ],
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

type Pill = {
  readonly label: string
  readonly href: string
  readonly mark: Html
}

const brandMark = (viewBox: string, fill: string, path: string): Html =>
  ih.span(
    [
      ih.AriaHidden(true),
      ih.Style({ display: 'block', flex: 'none', width: '17px', height: '17px' }),
      ih.InnerHTML(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" fill="${fill}" width="17" height="17"><path d="${path}"/></svg>`,
      ),
    ],
    [],
  )

const GITHUB_PATH =
  'M12 .5C5.7.5.6 5.6.6 12c0 5 3.3 9.3 7.8 10.8.6.1.8-.2.8-.6v-2c-3.2.7-3.9-1.5-3.9-1.5-.5-1.3-1.3-1.7-1.3-1.7-1-.7.1-.7.1-.7 1.1.1 1.7 1.2 1.7 1.2 1 1.8 2.7 1.3 3.4 1 .1-.8.4-1.3.7-1.6-2.6-.3-5.3-1.3-5.3-5.8 0-1.3.4-2.3 1.2-3.1-.1-.3-.5-1.5.1-3.1 0 0 1-.3 3.2 1.2.9-.3 1.9-.4 2.9-.4s2 .1 2.9.4c2.2-1.5 3.2-1.2 3.2-1.2.6 1.6.2 2.8.1 3.1.8.8 1.2 1.8 1.2 3.1 0 4.5-2.7 5.5-5.3 5.8.4.4.8 1.1.8 2.2v3.3c0 .4.2.7.8.6 4.5-1.5 7.8-5.8 7.8-10.8C23.4 5.6 18.3.5 12 .5z'

const TELEGRAM_PATH =
  'M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z'

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
  {
    label: 'GitHub',
    href: 'https://github.com/athrio-com/loom',
    mark: brandMark('0 0 24 24', '#C4CCE4', GITHUB_PATH),
  },
  {
    label: 'Telegram',
    href: 'https://t.me/athrio',
    mark: brandMark('0 0 24 24', '#26A5E4', TELEGRAM_PATH),
  },
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

const passageRow = (
  page: SearchPage,
  passage: Passage,
  query: string,
  focused: boolean,
  h: HtmlBuilder<Message>,
): Html => {
  const fragment = fragmentOf(passage, query)
  return h.button(
    [
      h.Class(focused ? 'palette-row here' : 'palette-row'),
      h.Type('button'),
      h.Style({ background: wash(page, focused) }),
      h.OnClick(WentTo({ route: page.route })),
    ],
    [
      h.span(
        [h.Class('sigil'), h.Style({ color: focused ? page.ink : '#4E5D8C' })],
        ['>'],
      ),
      h.span(
        [h.Class('fragment')],
        [
          fragment.pre,
          h.span([h.Class('palette-hit'), h.Style({ color: page.ink })], [fragment.hit]),
          fragment.post,
        ],
      ),
    ],
  )
}

const groupBlock = (
  group: Group,
  query: string,
  focus: number,
  from: number,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class('palette-kids-wrap')],
    [
      h.button(
        [
          h.Class('palette-group'),
          h.Type('button'),
          h.Style({ background: wash(group.page, focus === from) }),
          h.OnClick(WentTo({ route: group.page.route })),
        ],
        [
          h.span([h.Class('sigil'), h.Style({ color: group.page.ink })], ['~']),
          h.span([h.Class('name')], [group.page.label]),
          h.span([h.Class('path')], [group.page.path]),
        ],
      ),
      h.div(
        [h.Class('palette-kids')],
        Array.map(group.rows, (passage, index) =>
          passageRow(group.page, passage, query, focus === from + 1 + index, h),
        ),
      ),
    ],
  )

const focusedPage = (model: Model): SearchPage => {
  const list = focusables(groupsFor(model.query))
  return pipe(
    focusedIn(list, model.focus),
    Option.map((focusable) => focusable.page),
    Option.getOrElse(() => searchPages[0] as SearchPage),
  )
}

const results = (model: Model, h: HtmlBuilder<Message>): Html => {
  const groups = groupsFor(model.query)
  const starts = pipe(
    groups,
    Array.map((group) => group.rows.length + 1),
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
          groupBlock(group, model.query, model.focus, starts[index] ?? 0, h),
        ),
  )
}

const searching = (page: SearchPage, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Style({ display: 'flex', flexDirection: 'column', flex: 'none' })],
    [
      h.span([
        h.Class('palette-stitch'),
        h.AriaHidden(true),
        h.Style({
          background: `repeating-linear-gradient(90deg, ${page.ink} 0 6px, transparent 6px 12px)`,
        }),
      ], []),
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
      h.span([], ['↑↓ move']),
      h.span([], ['⏎ open']),
      h.span([h.Class('count')], [countOf(focusables(groupsFor(model.query)).length)]),
    ],
  )

const paletteMiddle = (
  model: Model,
  page: SearchPage,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html> =>
  Match.value({ typed: model.query.trim() !== '', settling: model.searching }).pipe(
    Match.when({ typed: false }, () => [pillRow(model.focus, h)]),
    Match.when({ settling: true }, () => [searching(page, h)]),
    Match.orElse(() => [results(model, h), hintBar(model, page, h)]),
  )

export const palette = (model: Model, h: HtmlBuilder<Message>): Html => {
  const page = focusedPage(model)
  return h.div(
    [h.Class('palette-shell'), h.Role('dialog')],
    [
      h.div(
        [h.Class('palette-card')],
        [
          h.div(
            [h.Class('palette-head')],
            [
              queryField(model, h),
              h.button(
                [
                  h.Class('palette-esc'),
                  h.Type('button'),
                  h.AriaLabel('Close search'),
                  h.OnClick(ClosedSearch()),
                ],
                [h.span([h.Class('cross')], ['×']), h.span([], ['esc'])],
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
                    [
                      loomMark('dark', 0.78),
                      h.div([h.Class('footer-word')], ['Loom']),
                    ],
                  ),
                  h.div(
                    [h.Class('footer-blurb')],
                    ['Literate programming framework for AI-assisted engineering.'],
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
                      ...(leavesSite(link) ? [h.Target('_blank'), h.Rel('noopener noreferrer')] : []),
                    ],
                    [link.label, ...(leavesSite(link) ? [externalIcon()] : [])],
                  ),
                ),
              ),
            ],
          ),
          h.div(
            [h.Class('footer-bottom')],
            [
              h.span([], ['© Quadrivium Academy Sihtasutus 2026']),
            ],
          ),
        ],
      ),
    ],
  )
