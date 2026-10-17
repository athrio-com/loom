import { Array, Effect, Match, Option, pipe, Schema as S, Stream } from 'effect'
import { Runtime, Subscription } from 'foldkit'
import { define, mapMessages, type Command } from 'foldkit/command'
import { ssrHydration } from '@athrio/foldkit-hydration'
import { view } from './view'
import {
  CopyReset,
  GrewCard,
  type Message,
  Model,
  type Player,
  routeOf,
  SectionScrolled,
  SelectedSection,
  SpottedSection,
  StageMoved,
  Ticked,
  ToggledFullHeight,
} from './model'
import { CHARACTERS, RUN, struckBy } from './example'

type Step = readonly [Model, ReadonlyArray<Command<Message>>]

const CopyThenReset = define('CopyThenReset', { text: S.String }, CopyReset)(
  ({ text }) =>
    Effect.tryPromise(() => navigator.clipboard.writeText(text)).pipe(
      Effect.ignore,
      Effect.andThen(Effect.sleep('1400 millis')),
      Effect.as(CopyReset()),
    ),
)

const scrollIntoPreview = (id: string): void =>
  Option.match(Option.fromNullishOr(document.getElementById(id)), {
    onNone: () => undefined,
    onSome: (target) => target.scrollIntoView({ behavior: 'smooth', block: 'start' }),
  })

const ScrollToSection = define('ScrollToSection', { id: S.String }, SectionScrolled)(
  ({ id }) =>
    Effect.sleep('30 millis').pipe(
      Effect.andThen(Effect.sync(() => scrollIntoPreview(id))),
      Effect.as(SectionScrolled()),
    ),
)

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

const MoveStage = define('MoveStage', { to: StageMark }, StageMoved)(
  ({ to }) =>
    (to === 'foot' ? Effect.sleep('30 millis') : Effect.void).pipe(
      Effect.andThen(Effect.sync(() => moveStage(to))),
      Effect.as(StageMoved()),
    ),
)

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

const GlideToCard = define('GlideToCard', GrewCard)(
  Effect.suspend(() =>
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
)

const clamp = (value: number, max: number): number =>
  Math.max(0, Math.min(max, value))

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
    return [
      { ...model, player: { ...model.player, struck: CHARACTERS, beat: RUN, playing: false } },
      [MoveStage({ to: 'foot' })],
    ]
  }
  const struck = struckBy(beat)
  return [
    { ...model, player: { ...model.player, struck, beat } },
    struck === model.player.struck ? [] : [MoveStage({ to: 'caret' })],
  ]
}

const update = (model: Model, message: Message): Step =>
  Match.value(message).pipe(
    Match.withReturnType<Step>(),
    Match.tagsExhaustive({
      ToggledPlay: () => [{ ...model, player: toggled(model.player) }, []],
      Ticked: ({ delta }) => stepped(model, delta),
      SkippedToEnd: () => [
        { ...model, player: { ...model.player, struck: CHARACTERS, beat: RUN, playing: false } },
        [MoveStage({ to: 'foot' })],
      ],
      ReplayedDocument: () => [
        {
          ...model,
          player: { struck: 0, beat: 0, playing: false, output: Option.none(), full: false },
        },
        [MoveStage({ to: 'head' })],
      ],
      ToggledFullHeight: () =>
        model.player.full
          ? [{ ...model, player: { ...model.player, full: false } }, []]
          : [model, [GlideToCard()]],
      GrewCard: () => [{ ...model, player: { ...model.player, full: true } }, []],
      ShowedOutput: ({ which }) => [
        {
          ...model,
          player: {
            ...model.player,
            output: Option.contains(model.player.output, which)
              ? Option.none()
              : Option.some(which),
          },
        },
        [],
      ],
      StageMoved: () => [model, []],
      SelectedSection: ({ id }) => [{ ...model, activeSection: id }, [ScrollToSection({ id })]],
      SectionScrolled: () => [model, []],
      SpottedSection: ({ id }) =>
        id === model.activeSection ? [model, []] : [{ ...model, activeSection: id }, []],
      WentTo: ({ route }) => [{ ...model, route, searchOpen: false }, []],
      OpenedChapter: ({ slug }) => [
        { ...model, chapter: slug, activeSection: '', drawerOpen: false },
        [],
      ],
      PickedRuntime: ({ runtime }) => [{ ...model, runtime }, []],
      ScrolledBar: ({ hidden }) =>
        hidden === model.navHidden ? [model, []] : [{ ...model, navHidden: hidden }, []],
      OpenedDrawer: () => [{ ...model, drawerOpen: true }, []],
      ClosedDrawer: () => [{ ...model, drawerOpen: false }, []],
      OpenedSearch: () => [{ ...model, searchOpen: true, focus: 0 }, []],
      ClosedSearch: () => [
        { ...model, searchOpen: false, query: '', focus: 0, caret: 0, searching: false },
        [],
      ],
      MovedCaret: ({ at }) => [{ ...model, caret: at }, []],
      SettledSearch: () => [{ ...model, searching: false }, []],
      Typed: ({ query }) => [{ ...model, query, focus: 0 }, []],
      MovedFocus: ({ delta, count }) => [
        { ...model, focus: clamp(model.focus + delta, Math.max(0, count - 1)) },
        [],
      ],
      Copied: ({ id, text }) => [{ ...model, copied: id }, [CopyThenReset({ text })]],
      CopyReset: () => [{ ...model, copied: '' }, []],
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

const subscriptions = Subscription.make<Model, Message>()((entry) => ({
  sectionSpy: entry(
    { spying: S.Boolean },
    {
      modelToDependencies: (model) => ({
        spying: model.route === 'docs',
      }),
      dependenciesToStream: ({ spying }) =>
        spying
          ? Subscription.fromEventFilterMap<Event, Message>({
              target: window,
              type: 'scroll',
              options: { passive: true },
              toMessage: () => Option.map(activeSectionId(), (id) => SpottedSection({ id })),
            })
          : Stream.empty,
    },
  ),
  typing: Subscription.animationFrame<Model, Message>({
    isActive: (model) => model.player.playing,
    toMessage: (delta) => Ticked({ delta }),
  }),
  shrinking: entry(
    { full: S.Boolean },
    {
      modelToDependencies: (model) => ({ full: model.player.full }),
      dependenciesToStream: ({ full }) =>
        full
          ? Subscription.fromEventFilterMap<KeyboardEvent, Message>({
              target: window,
              type: 'keydown',
              toMessage: (event) =>
                event.key === 'Escape' ? Option.some(ToggledFullHeight()) : Option.none(),
            })
          : Stream.empty,
    },
  ),
}))

import './landing.css'

const emptyModel: Model = {
  route: 'home',
  chapter: '',
  navHidden: false,
  drawerOpen: false,
  runtime: 'bun',
  searchOpen: false,
  caret: 0,
  searching: false,
  activeSection: '',
  player: { struck: 0, beat: 0, playing: false, output: Option.none(), full: false },
  version: '0.0.11',
  query: '',
  focus: 0,
  copied: '',
}

const routed = (model: Model): Model =>
  Option.match(routeOf(window.location.pathname), {
    onNone: () => model,
    onSome: (route) => ({ ...model, route }),
  })

const flags: Effect.Effect<Model> = Effect.sync(() =>
  routed(
    Option.match(
      Option.fromNullishOr(document.getElementById('foldkit-model')?.textContent),
      {
        onSome: (text) => S.decodeUnknownSync(Model)(JSON.parse(text)),
        onNone: () => emptyModel,
      },
    ),
  ),
)

const application = Runtime.makeApplication({
  Model,
  Flags: Model,
  flags,
  init: (seed: Model): Step => [seed, []],
  update,
  view,
  subscriptions,
  container: document.getElementById('root'),
  hydrate: ssrHydration(),
})

Runtime.run(application)
