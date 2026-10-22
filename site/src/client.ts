import { Array, Effect, Filter, Match, Option, pipe, Schema as S, Stream } from 'effect'
import { Dom, Runtime, Subscription } from 'foldkit'
import { define } from 'foldkit/command'
import { afterCommit } from 'foldkit/render'
import { animationFrameEntry } from 'foldkit/subscription'
import type { Return } from 'foldkit/update'
import { view } from './view'
import {
  ClosedSearch,
  Copied,
  CopyReset,
  drawsInPlace,
  FocusedPalette,
  Found,
  SearchGroup,
  GrewCard,
  type Message,
  Model,
  type Player,
  SectionScrolled,
  SelectedSection,
  SpottedSection,
  StageMoved,
  Ticked,
  ToggledFullHeight,
  MovedCaret,
  OpenedSearch,
  pathOf,
} from './model'
import { CHARACTERS, RUN, struckBy } from './example'

type Step = Return<Model, Message>

const CopyThenReset = define('CopyThenReset', {
  args: { text: S.String },
  messages: [CopyReset],
  execute: ({ text }) =>
    Effect.tryPromise(() => navigator.clipboard.writeText(text)).pipe(
      Effect.ignore,
      Effect.andThen(Effect.sleep('1400 millis')),
      Effect.as(CopyReset()),
    ),
})

const FocusPalette = define('FocusPalette', {
  messages: [FocusedPalette],
  execute: afterCommit.pipe(
    Effect.andThen(Dom.focus('.palette-input')),
    Effect.ignore,
    Effect.as(FocusedPalette()),
  ),
})

const scrollIntoPreview = (id: string): void =>
  Option.match(Option.fromNullishOr(document.getElementById(id)), {
    onNone: () => undefined,
    onSome: (target) => target.scrollIntoView({ behavior: 'smooth', block: 'start' }),
  })

const ScrollToSection = define('ScrollToSection', {
  args: { id: S.String },
  messages: [SectionScrolled],
  execute: ({ id }) =>
    Effect.sleep('30 millis').pipe(
      Effect.andThen(Effect.sync(() => scrollIntoPreview(id))),
      Effect.as(SectionScrolled()),
    ),
})

const ScrollToTop = define('ScrollToTop', {
  messages: [SectionScrolled],
  execute: Effect.sync(() => window.scrollTo(0, 0)).pipe(Effect.as(SectionScrolled())),
})

const MENUS = '.menu-card, .drawer-body'

const chapterOffset = (menu: HTMLElement): Option.Option<number> =>
  Option.all([
    Option.fromNullishOr(menu.firstElementChild),
    Option.fromNullishOr(menu.querySelector('.menu-item')),
    Option.fromNullishOr(menu.querySelector('.menu-item.here')),
  ]).pipe(
    Option.map(([first, opening, chapter]) =>
      chapter === opening
        ? 0
        : chapter.getBoundingClientRect().top - first.getBoundingClientRect().top,
    ),
  )

const revealChapter = (menu: HTMLElement): void =>
  Option.match(chapterOffset(menu), {
    onNone: () => undefined,
    onSome: (offset) => menu.scrollTo({ top: offset }),
  })

const revealChapters = Effect.sync(() =>
  Array.fromIterable(document.querySelectorAll<HTMLElement>(MENUS)),
).pipe(
  Effect.flatMap((menus) =>
    Effect.forEach(menus, (menu) => Effect.sync(() => revealChapter(menu)), { discard: true }),
  ),
)

const pageLoaded = Effect.promise(
  () =>
    new Promise<void>((resolve) =>
      document.readyState === 'complete'
        ? resolve()
        : window.addEventListener('load', () => resolve(), { once: true }),
    ),
)

const RevealChapter = define('RevealChapter', {
  messages: [SectionScrolled],
  execute: afterCommit.pipe(
    Effect.andThen(revealChapters),
    Effect.andThen(pageLoaded),
    Effect.andThen(Effect.promise(() => document.fonts.ready)),
    Effect.andThen(revealChapters),
    Effect.as(SectionScrolled()),
  ),
})

const LoadPage = define('LoadPage', {
  args: { href: S.String },
  messages: [ClosedSearch],
  execute: ({ href }) =>
    Effect.sync(() => window.location.assign(href)).pipe(Effect.as(ClosedSearch())),
})

const LANDING = 'loom-landing'

const Landing = S.Struct({ address: S.String, words: S.String, before: S.String, area: S.Boolean })
type Landing = typeof Landing.Type

const addressOf = (url: URL): string => `${url.pathname}${url.hash}`

const keepLanding = (landing: Landing): Effect.Effect<void> =>
  Effect.try(() => sessionStorage.setItem(LANDING, JSON.stringify(landing))).pipe(Effect.ignore)

const decodeLanding = S.decodeUnknownOption(Landing)

const takeLanding: Effect.Effect<Option.Option<Landing>> = Effect.try(() => {
  const kept = sessionStorage.getItem(LANDING)
  sessionStorage.removeItem(LANDING)
  return kept
}).pipe(
  Effect.map((kept) =>
    pipe(
      Option.fromNullishOr(kept),
      Option.flatMap(Option.liftThrowable((json: string): unknown => JSON.parse(json))),
      Option.flatMap(decodeLanding),
    ),
  ),
  Effect.catchCause(() => Effect.succeed(Option.none())),
)

const textsIn = (node: Node): ReadonlyArray<Text> =>
  node instanceof Text ? [node] : Array.flatMap(Array.fromIterable(node.childNodes), textsIn)

const readable = (text: Text): boolean =>
  Option.match(Option.fromNullishOr(text.parentElement), {
    onNone: () => false,
    onSome: (parent) => !parent.closest('script, style, nav, footer') && parent.checkVisibility(),
  })

const contentOf = (): Node =>
  Option.getOrElse(Option.fromNullishOr(document.querySelector('main')), (): Node => document.body)

const headingOf = (url: URL): Option.Option<HTMLElement> =>
  Option.fromNullishOr(document.getElementById(decodeURIComponent(url.hash.slice(1))))

const follows = (heading: Node, text: Text): boolean =>
  !heading.contains(text) && (heading.compareDocumentPosition(text) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0

const isHeading = (element: HTMLElement): boolean => /^H[1-6]$/.test(element.tagName)

type Run = { readonly text: Text; readonly start: number }

const runsOf = (texts: ReadonlyArray<Text>): ReadonlyArray<Run> =>
  Array.zipWith(texts, Array.scan(texts, 0, (at, text) => at + text.data.length), (text, start) => ({
    text,
    start,
  }))

const folded = (text: string): string => text.toLowerCase().replace(/\s/g, ' ')

const runAt = (runs: ReadonlyArray<Run>, offset: number, ending: boolean): Option.Option<Run> =>
  Array.findFirst(runs, (run) =>
    ending
      ? offset > run.start && offset <= run.start + run.text.data.length
      : offset >= run.start && offset < run.start + run.text.data.length,
  )

const offsetIn = (flat: string, sought: string): Option.Option<number> =>
  Option.liftPredicate(flat.indexOf(folded(sought)), (at) => sought !== '' && at >= 0)

const rangeIn = (texts: ReadonlyArray<Text>, words: string, before: string): Option.Option<Range> => {
  const runs = runsOf(texts)
  const flat = folded(Array.join(Array.map(texts, (text) => text.data), ''))
  return pipe(
    offsetIn(flat, `${before}${words}`),
    Option.map((at) => at + before.length),
    Option.orElse(() => offsetIn(flat, words)),
    Option.flatMap((start) =>
      pipe(
        Option.all([runAt(runs, start, false), runAt(runs, start + words.length, true)]),
        Option.map(([first, last]) => {
          const range = document.createRange()
          range.setStart(first.text, start - first.start)
          range.setEnd(last.text, start + words.length - last.start)
          return range
        }),
      ),
    ),
  )
}

const shorterLine = (landing: Landing): Option.Option<Landing> =>
  Option.liftPredicate(
    { ...landing, words: landing.words.slice(0, Math.floor(landing.words.length / 2)).trim() },
    (shorter) => landing.area && shorter.words.length >= 12,
  )

const rangeOf = (url: URL, landing: Landing): Option.Option<Range> =>
  pipe(
    rangeAt(url, landing),
    Option.orElse(() => Option.flatMap(shorterLine(landing), (shorter) => rangeOf(url, shorter))),
  )

const rangeAt = (url: URL, landing: Landing): Option.Option<Range> => {
  const texts = Array.filter(textsIn(contentOf()), readable)
  return Option.match(headingOf(url), {
    onNone: () => rangeIn(texts, landing.words, landing.before),
    onSome: (target) => {
      const inside = Array.filter(texts, (text) => target.contains(text))
      const after = Array.filter(texts, (text) => follows(target, text))
      return isHeading(target)
        ? pipe(
            rangeIn(after, landing.words, landing.before),
            Option.orElse(() => rangeIn(textsIn(target), landing.words, '')),
          )
        : pipe(
            rangeIn(inside, landing.words, landing.before),
            Option.orElse(() => rangeIn(after, landing.words, landing.before)),
          )
    },
  })
}

const FOUND = 'found'

const FOUND_AREA = 'found-area'

const BLOCKS = 'p, li, pre, blockquote, td, th, dd, dt, figcaption, h1, h2, h3, h4, h5, h6'

const areaOf = (range: Range): Range =>
  pipe(
    Option.fromNullishOr(range.startContainer.parentElement?.closest(BLOCKS)),
    Option.match({
      onNone: () => range,
      onSome: (block) => {
        const area = document.createRange()
        area.selectNodeContents(block)
        return area
      },
    }),
  )

const highlightWords = (range: Range, name: string): Option.Option<void> =>
  pipe(
    Option.liftPredicate(globalThis.CSS, (css) => css !== undefined && 'highlights' in css),
    Option.map((css) => {
      css.highlights.set(name, new Highlight(range))
      window.addEventListener('pointerdown', () => css.highlights.delete(name), { once: true })
    }),
  )

const selectWords = (range: Range): void =>
  Option.match(Option.fromNullishOr(window.getSelection()), {
    onNone: () => undefined,
    onSome: (selection) => {
      selection.removeAllRanges()
      selection.addRange(range)
    },
  })

const scrollTo = (range: Range): void =>
  Option.match(Option.fromNullishOr(range.startContainer.parentElement), {
    onNone: () => undefined,
    onSome: (element) =>
      element.scrollIntoView({
        behavior: 'smooth',
        block: range.getBoundingClientRect().height > window.innerHeight * 0.6 ? 'start' : 'center',
      }),
  })

const markWords = (landing: Landing) => (found: Range): void => {
  const marked = landing.area ? areaOf(found) : found
  Option.match(highlightWords(marked, landing.area ? FOUND_AREA : FOUND), {
    onNone: () => selectWords(marked),
    onSome: () => undefined,
  })
  scrollTo(marked)
}

const here = (): string => addressOf(new URL(window.location.href))

const land: Effect.Effect<void> = takeLanding.pipe(
  Effect.map((landing) =>
    pipe(
      landing,
      Option.filter((kept) => kept.address === here()),
      Option.flatMap((kept) =>
        Option.map(rangeOf(new URL(kept.address, window.location.href), kept), (found) => markWords(kept)(found)),
      ),
    ),
  ),
)

const onThisPage = (url: URL): boolean => url.pathname === window.location.pathname

const OpenFound = define('OpenFound', {
  args: { href: S.String, words: S.String, before: S.String, area: S.Boolean },
  messages: [ClosedSearch],
  execute: ({ href, words, before, area }) => {
    const url = new URL(href, window.location.href)
    return keepLanding({ address: addressOf(url), words, before, area }).pipe(
      Effect.andThen(Effect.sync(() => window.location.assign(href))),
      Effect.andThen(
        onThisPage(url) ? Effect.sleep('30 millis').pipe(Effect.andThen(land)) : Effect.void,
      ),
      Effect.as(ClosedSearch()),
    )
  },
})

const LandOnFound = define('LandOnFound', {
  messages: [SectionScrolled],
  execute: afterCommit.pipe(
    Effect.andThen(pageLoaded),
    Effect.andThen(Effect.promise(() => document.fonts.ready)),
    Effect.andThen(land),
    Effect.as(SectionScrolled()),
  ),
})

const SETTLE = '140 millis'

const searchable = (query: string): boolean => query.trim().length >= 2

const decodeGroups = S.decodeUnknownOption(S.Array(SearchGroup))

const searchAddress = (query: string, exact: boolean): string =>
  `/search?q=${encodeURIComponent(query)}${exact ? '&exact=1' : ''}`

const Search = define('Search', {
  args: { query: S.String, exact: S.Boolean },
  messages: [Found],
  execute: ({ query, exact }) =>
    Effect.sleep(SETTLE).pipe(
      Effect.andThen(
        Effect.tryPromise(() => fetch(searchAddress(query, exact)).then((response) => response.json())),
      ),
      Effect.map((body) => Option.getOrElse(decodeGroups(body), () => [])),
      Effect.catchCause(() => Effect.succeed([])),
      Effect.map((groups) => Found({ query, exact, groups })),
    ),
})

const LINE = 28
const TAIL = LINE * 3

const StageMark = S.Literals(['caret', 'foot', 'head'])
type StageMark = typeof StageMark.Type

const markedTop = (mark: StageMark, stage: HTMLElement): number =>
  Match.value(mark).pipe(
    Match.when('head', () => 0),
    Match.when('foot', () => stage.scrollHeight - stage.clientHeight),
    Match.when('caret', () => stage.scrollTop + TAIL),
    Match.exhaustive,
  )

const moveStage = (mark: StageMark): void =>
  Option.match(Option.fromNullishOr(document.getElementById('loom-stage')), {
    onNone: () => undefined,
    onSome: (stage) => {
      const room = stage.scrollHeight - stage.clientHeight
      stage.scrollTop = Math.max(0, Math.min(room, markedTop(mark, stage)))
    },
  })

const MoveStage = define('MoveStage', {
  args: { to: StageMark },
  messages: [StageMoved],
  execute: ({ to }) =>
    (to === 'foot' ? Effect.sleep('30 millis') : Effect.void).pipe(
      Effect.andThen(Effect.sync(() => moveStage(to))),
      Effect.as(StageMoved()),
    ),
})

const CARD_AIR = 24
const GLIDE = 320
const NUDGE = 4

const cardRest = (): Option.Option<number> =>
  Option.map(
    Option.fromNullishOr(document.getElementById('loom-card')),
    (card) => card.getBoundingClientRect().top + window.scrollY - CARD_AIR,
  )

const eased = (part: number): number =>
  part < 0.5 ? 4 * part * part * part : 1 - Math.pow(-2 * part + 2, 3) / 2

const glide = (from: number, distance: number, started: number): Effect.Effect<void> =>
  Effect.sync(() => Math.min(1, (performance.now() - started) / GLIDE)).pipe(
    Effect.tap((part) =>
      Effect.sync(() => window.scrollTo(0, Math.round(from + distance * eased(part)))),
    ),
    Effect.flatMap((part) =>
      part < 1
        ? Effect.sleep('16 millis').pipe(Effect.andThen(glide(from, distance, started)))
        : Effect.void,
    ),
  )

const GlideToCard = define('GlideToCard', {
  messages: [GrewCard],
  execute: Effect.suspend(() =>
    Option.match(cardRest(), {
      onNone: () => Effect.void,
      onSome: (rest) => {
        const from = window.scrollY
        return Math.abs(rest - from) <= NUDGE
          ? Effect.void
          : glide(from, rest - from, performance.now())
      },
    }),
  ).pipe(Effect.as(GrewCard())),
})

const clamp = (value: number, max: number): number => Math.max(0, Math.min(max, value))

const firstResult = (groups: ReadonlyArray<SearchGroup>): number => (groups.length > 0 ? 1 : 0)

const CHARS_PER_SECOND = 26

const toggled = (player: Player): Player => {
  if (player.playing) {
    return { ...player, playing: false }
  }
  const from = player.struck >= CHARACTERS ? 0 : player.struck
  return {
    ...player,
    struck: from,
    beat: from === 0 ? 0 : player.beat,
    playing: true,
    output: Option.none(),
  }
}

const stepped = (model: Model, delta: number): Step => {
  const beat = model.player.beat + (Math.min(delta, 32) / 1000) * CHARS_PER_SECOND
  if (beat >= RUN) {
    return {
      model: {
        ...model,
        player: { ...model.player, struck: CHARACTERS, beat: RUN, playing: false },
      },
      commands: [MoveStage({ to: 'foot' })],
    }
  }
  const struck = struckBy(beat)
  return {
    model: { ...model, player: { ...model.player, struck, beat } },
    commands: struck === model.player.struck ? [] : [MoveStage({ to: 'caret' })],
  }
}

const update = (model: Model, message: Message): Step =>
  Match.value(message).pipe(
    Match.withReturnType<Step>(),
    Match.tagsExhaustive({
      ToggledPlay: () => ({ model: { ...model, player: toggled(model.player) } }),
      Ticked: ({ delta }) => stepped(model, delta),
      SkippedToEnd: () => ({
        model: {
          ...model,
          player: { ...model.player, struck: CHARACTERS, beat: RUN, playing: false },
        },
        commands: [MoveStage({ to: 'foot' })],
      }),
      ReplayedDocument: () => ({
        model: {
          ...model,
          player: { struck: 0, beat: 0, playing: false, output: Option.none(), full: false },
        },
        commands: [MoveStage({ to: 'head' })],
      }),
      ToggledFullHeight: () =>
        model.player.full
          ? { model: { ...model, player: { ...model.player, full: false } } }
          : { model, commands: [GlideToCard()] },
      GrewCard: () => ({ model: { ...model, player: { ...model.player, full: true } } }),
      ShowedOutput: ({ which }) => ({
        model: {
          ...model,
          player: {
            ...model.player,
            output: Option.contains(model.player.output, which)
              ? Option.none()
              : Option.some(which),
          },
        },
      }),
      StageMoved: () => ({ model }),
      SelectedSection: ({ id }) => ({
        model: { ...model, activeSection: id, drawerOpen: false },
        commands: [ScrollToSection({ id })],
      }),
      SectionScrolled: () => ({ model }),
      SpottedSection: ({ id }) =>
        id === model.activeSection ? { model } : { model: { ...model, activeSection: id } },
      WentTo: ({ route }) =>
        drawsInPlace(route) || Option.isSome(model.book)
          ? { model: { ...model, route, searchOpen: false } }
          : { model, commands: [LoadPage({ href: pathOf(route) })] },
      OpenedChapter: ({ slug }) => ({
        model: { ...model, chapter: slug, activeSection: '', drawerOpen: false },
        commands: [ScrollToTop()],
      }),
      PickedRuntime: ({ runtime }) => ({ model: { ...model, runtime } }),
      OpenedDrawer: () => ({ model: { ...model, drawerOpen: true } }),
      ClosedDrawer: () => ({ model: { ...model, drawerOpen: false } }),
      OpenedSearch: () => ({
        model: { ...model, searchOpen: true, focus: 0 },
        commands: [FocusPalette()],
      }),
      FocusedPalette: () => ({ model }),
      ClosedSearch: () => ({
        model: {
          ...model,
          searchOpen: false,
          query: '',
          focus: 0,
          caret: 0,
          searching: false,
          found: [],
        },
      }),
      MovedCaret: ({ at }) => ({ model: { ...model, caret: at } }),
      Typed: ({ query }) =>
        searchable(query)
          ? {
              model: { ...model, query, focus: 0, searching: true },
              commands: [Search({ query, exact: model.exact })],
            }
          : { model: { ...model, query, focus: 0, searching: false, found: [] } },
      ToggledExact: () => {
        const exact = !model.exact
        return searchable(model.query)
          ? {
              model: { ...model, exact, focus: 0, searching: true },
              commands: [Search({ query: model.query, exact }), FocusPalette()],
            }
          : { model: { ...model, exact }, commands: [FocusPalette()] }
      },
      Found: ({ query, exact, groups }) =>
        query === model.query && exact === model.exact
          ? { model: { ...model, found: groups, searching: false, focus: firstResult(groups) } }
          : { model },
      OpenedHit: ({ href, words, before, area }) => ({
        model,
        commands: [OpenFound({ href, words, before, area })],
      }),
      MovedFocus: ({ delta, count }) => ({
        model: { ...model, focus: clamp(model.focus + delta, Math.max(0, count - 1)) },
      }),
      Copied: ({ id, text }) => ({
        model: { ...model, copied: id },
        commands: [CopyThenReset({ text })],
      }),
      CopyReset: () => ({ model: { ...model, copied: '' } }),
    }),
  )

const SPY_OFFSET = 100
const SPY_TARGETS = '.docs-article h2[id]'

const activeSectionId = (): Option.Option<string> => {
  const targets = Array.fromIterable(document.querySelectorAll<HTMLElement>(SPY_TARGETS))
  return pipe(
    Array.last(Array.filter(targets, (el) => el.getBoundingClientRect().top <= SPY_OFFSET)),
    Option.orElse(() => Array.head(targets)),
    Option.map((el) => el.id),
    Option.filter((id) => id.length > 0),
  )
}

const windowEvents = <E extends Event>(
  type: string,
  toMessage: (event: E) => Option.Option<Message>,
  options?: { readonly passive?: boolean },
): Stream.Stream<Message> =>
  Stream.fromEventListener<E>(window, type, options).pipe(
    Stream.filterMap(Filter.fromPredicateOption(toMessage)),
  )

const typingIn = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))

const slashOpens = (event: KeyboardEvent): Option.Option<Message> =>
  event.key === '/' && !event.metaKey && !event.ctrlKey && !event.altKey && !typingIn(event.target)
    ? Option.some(OpenedSearch())
    : Option.none()

const paletteCaret = (): Option.Option<number> =>
  pipe(
    Option.fromNullishOr(document.querySelector<HTMLInputElement>('.palette-input')),
    Option.filter((field) => field === document.activeElement),
    Option.flatMapNullishOr((field) => field.selectionStart),
  )

const inlineCopy = (event: MouseEvent): Option.Option<Message> =>
  pipe(
    Option.liftPredicate(event.target, (target): target is Element => target instanceof Element),
    Option.flatMapNullishOr((target) => target.closest<HTMLElement>('[data-copy]')),
    Option.flatMapNullishOr((button) => button.dataset.copy),
    Option.map((text) => Copied({ id: `inline:${text}`, text })),
  )

const caretMoves: Stream.Stream<Message> = pipe(
  [
    Stream.fromEventListener(document, 'selectionchange'),
    Stream.fromEventListener(window, 'keyup'),
    Stream.fromEventListener(window, 'mouseup'),
    Stream.fromEventListener(window, 'input'),
  ],
  Stream.mergeAll({ concurrency: 'unbounded' }),
  Stream.filterMap(
    Filter.fromPredicateOption(() => Option.map(paletteCaret(), (at) => MovedCaret({ at }))),
  ),
)

const subscriptions = Subscription.make<Model, Message>()((entry) => ({
  sectionSpy: entry(
    { spying: S.Boolean },
    {
      modelToDependencies: (model) => ({
        spying: model.route === 'docs' || model.route === 'source',
      }),
      dependenciesToStream: ({ spying }) =>
        spying
          ? windowEvents(
              'scroll',
              () => Option.map(activeSectionId(), (id) => SpottedSection({ id })),
              { passive: true },
            )
          : Stream.empty,
    },
  ),
  inlineCopies: entry(
    { reading: S.Boolean },
    {
      modelToDependencies: (model) => ({
        reading: model.route === 'docs' || model.route === 'source',
      }),
      dependenciesToStream: ({ reading }) =>
        reading ? windowEvents<MouseEvent>('click', inlineCopy) : Stream.empty,
    },
  ),
  opening: entry(
    { closed: S.Boolean },
    {
      modelToDependencies: (model) => ({ closed: !model.searchOpen }),
      dependenciesToStream: ({ closed }) =>
        closed
          ? Dom.streamFromEventFilterMapPreventDefault({
              target: window,
              type: 'keydown',
              filterMapEvent: slashOpens,
            })
          : Stream.empty,
    },
  ),
  caret: entry(
    { open: S.Boolean },
    {
      modelToDependencies: (model) => ({ open: model.searchOpen }),
      dependenciesToStream: ({ open }) => (open ? caretMoves : Stream.empty),
    },
  ),
  typing: animationFrameEntry<Model, Message>({
    isActive: (model) => model.player.playing,
    toMessage: (delta) => Ticked({ delta }),
  }),
  shrinking: entry(
    { full: S.Boolean },
    {
      modelToDependencies: (model) => ({ full: model.player.full }),
      dependenciesToStream: ({ full }) =>
        full
          ? windowEvents<KeyboardEvent>('keydown', (event) =>
              event.key === 'Escape' ? Option.some(ToggledFullHeight()) : Option.none(),
            )
          : Stream.empty,
    },
  ),
}))

import './landing.css'
import './reload'

const application = Runtime.makeApplication({
  Model,
  Flags: Model,
  init: (seed: Model): Step => ({ model: seed, commands: [RevealChapter(), LandOnFound()] }),
  update,
  view,
  subscriptions,
  container: document.getElementById('root'),
})

Runtime.hydrate(application, { buildId: new URL(import.meta.url).pathname })
