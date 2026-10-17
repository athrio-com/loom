import { Array, Effect, Filter, Match, Option, pipe, Schema as S, Stream } from 'effect'
import { Dom, Runtime, Subscription } from 'foldkit'
import { define } from 'foldkit/command'
import { afterCommit } from 'foldkit/render'
import { animationFrameEntry } from 'foldkit/subscription'
import type { Return } from 'foldkit/update'
import { view } from './view'
import {
  CopyReset,
  FocusedPalette,
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
    return {
      model: { ...model, player: { ...model.player, struck: CHARACTERS, beat: RUN, playing: false } },
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
        model: { ...model, player: { ...model.player, struck: CHARACTERS, beat: RUN, playing: false } },
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
      WentTo: ({ route }) => ({ model: { ...model, route, searchOpen: false } }),
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
        model: { ...model, searchOpen: false, query: '', focus: 0, caret: 0, searching: false },
      }),
      MovedCaret: ({ at }) => ({ model: { ...model, caret: at } }),
      SettledSearch: () => ({ model: { ...model, searching: false } }),
      Typed: ({ query }) => ({ model: { ...model, query, focus: 0 } }),
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
        spying: model.route === 'docs',
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

const application = Runtime.makeApplication({
  Model,
  Flags: Model,
  init: (seed: Model): Step => ({ model: seed }),
  update,
  view,
  subscriptions,
  container: document.getElementById('root'),
})

Runtime.hydrate(application, { buildId: new URL(import.meta.url).pathname })
