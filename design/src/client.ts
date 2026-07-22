import { Array, Effect, Match, Option, pipe, Schema as S, Stream } from 'effect'
import { Runtime, Subscription } from 'foldkit'
import { define, mapMessages, type Command } from 'foldkit/command'
import { ssrHydration } from '@athrio/foldkit-hydration'
import { view } from './view'
import { ROTATOR_WORDS } from './hero'
import {
  CopyReset,
  GotGameMessage,
  type Message,
  Model,
  RotatedIn,
  RotatedOut,
  RotatorSettled,
  SectionScrolled,
  SelectedSection,
  SpottedSection,
} from './model'
import * as Gomoku from '../../examples/gomoku/gomoku'

type Step = readonly [Model, ReadonlyArray<Command<Message>>]

const CopyThenReset = define('CopyThenReset', { text: S.String }, CopyReset)(
  ({ text }) =>
    Effect.tryPromise(() => navigator.clipboard.writeText(text)).pipe(
      Effect.ignore,
      Effect.andThen(Effect.sleep('1400 millis')),
      Effect.as(CopyReset()),
    ),
)

const DelayRotateOut = define('DelayRotateOut', RotatedOut)(
  Effect.sleep('2200 millis').pipe(Effect.as(RotatedOut())),
)
const DelayRotateIn = define('DelayRotateIn', RotatedIn)(
  Effect.sleep('350 millis').pipe(Effect.as(RotatedIn())),
)
const DelayRotatorSettled = define('DelayRotatorSettled', RotatorSettled)(
  Effect.sleep('40 millis').pipe(Effect.as(RotatorSettled())),
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

const clamp = (value: number, max: number): number =>
  Math.max(0, Math.min(max, value))

const update = (model: Model, message: Message): Step =>
  Match.value(message).pipe(
    Match.withReturnType<Step>(),
    Match.tagsExhaustive({
      SelectedTab: ({ tab }) => {
        const replay = tab === 'play' && model.exampleTab === 'play'
        if (!replay) {
          return [{ ...model, exampleTab: tab }, []]
        }
        const [game, commands] = Gomoku.update(model.game, Gomoku.Reset())
        return [{ ...model, game }, mapMessages(commands, (message) => GotGameMessage({ message }))]
      },
      SelectedLoomView: ({ view }) => [{ ...model, loomView: view }, []],
      ExpandedExample: () => [{ ...model, exampleExpanded: true }, []],
      GotGameMessage: ({ message }) => {
        const [game, commands] = Gomoku.update(model.game, message)
        return [{ ...model, game }, mapMessages(commands, (message) => GotGameMessage({ message }))]
      },
      SelectedSection: ({ id }) => [
        { ...model, activeSection: id, exampleExpanded: true },
        [ScrollToSection({ id })],
      ],
      SectionScrolled: () => [model, []],
      SpottedSection: ({ id }) =>
        id === model.activeSection ? [model, []] : [{ ...model, activeSection: id }, []],
      Typed: ({ query }) => [{ ...model, query, focus: 0 }, []],
      MovedFocus: ({ delta, count }) => [
        { ...model, focus: clamp(model.focus + delta, Math.max(0, count - 1)) },
        [],
      ],
      SelectedPackageManager: ({ packageManager }) => [{ ...model, packageManager }, []],
      Copied: ({ id, text }) => [{ ...model, copied: id }, [CopyThenReset({ text })]],
      CopyReset: () => [{ ...model, copied: '' }, []],
      RotatedOut: () => [{ ...model, rotatorPhase: 'out' }, [DelayRotateIn()]],
      RotatedIn: () => [
        {
          ...model,
          rotatorIndex: (model.rotatorIndex + 1) % ROTATOR_WORDS.length,
          rotatorPhase: 'in-start',
        },
        [DelayRotatorSettled()],
      ],
      RotatorSettled: () => [{ ...model, rotatorPhase: 'normal' }, [DelayRotateOut()]],
    }),
  )

const SPY_OFFSET = 96

const activeSectionId = (): Option.Option<string> => {
  const headings = Array.fromIterable(
    document.querySelectorAll<HTMLElement>('.how-file-title, .how-section-h'),
  )
  return pipe(
    Array.last(Array.filter(headings, (el) => el.getBoundingClientRect().top <= SPY_OFFSET)),
    Option.orElse(() => Array.head(headings)),
    Option.map((el) => el.id),
    Option.filter((id) => id.length > 0),
  )
}

const subscriptions = Subscription.make<Model, Message>()((entry) => ({
  sectionSpy: entry(
    { previewing: S.Boolean },
    {
      modelToDependencies: (model) => ({
        previewing: model.exampleTab === 'loom' && model.loomView === 'preview',
      }),
      dependenciesToStream: ({ previewing }) =>
        previewing
          ? Subscription.fromEventFilterMap<Event, Message>({
              target: window,
              type: 'scroll',
              options: { passive: true },
              toMessage: () => Option.map(activeSectionId(), (id) => SpottedSection({ id })),
            })
          : Stream.empty,
    },
  ),
}))

import '@fontsource/ia-writer-quattro'
import './landing.css'

const emptyModel: Model = {
  rotatorIndex: 0,
  rotatorPhase: 'normal',
  activeSection: '',
  exampleTab: 'loom',
  loomView: 'preview',
  exampleExpanded: false,
  game: Gomoku.newGame(),
  version: '0.0.7',
  query: '',
  focus: 0,
  copied: '',
  packageManager: 'npm',
}

const flags: Effect.Effect<Model> = Effect.sync(() => {
  const inlined = Option.fromNullishOr(
    document.getElementById('foldkit-model')?.textContent,
  )
  return Option.match(inlined, {
    onSome: (text) => S.decodeUnknownSync(Model)(JSON.parse(text)),
    onNone: () => emptyModel,
  })
})

const application = Runtime.makeApplication({
  Model,
  Flags: Model,
  flags,
  init: (seed: Model): Step => [seed, [DelayRotateOut()]],
  update,
  view,
  subscriptions,
  container: document.getElementById('root'),
  hydrate: ssrHydration(),
})

Runtime.run(application)
