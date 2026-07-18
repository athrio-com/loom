import { Effect, Match, Option, Schema as S } from 'effect'
import { Runtime } from 'foldkit'
import { define, type Command } from 'foldkit/command'
import { ssrHydration } from '@athrio/foldkit-hydration'
import { view } from './view'
import { ROTATOR_WORDS } from './hero'
import {
  CopyReset,
  type Message,
  Model,
  RotatedIn,
  RotatedOut,
  RotatorSettled,
  TypingTicked,
} from './model'

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
const DelayTyping = define('DelayTyping', { ms: S.Number }, TypingTicked)(
  ({ ms }) => Effect.sleep(`${ms} millis`).pipe(Effect.as(TypingTicked())),
)

const PHRASES = [
  '::' + '[A friendly greeting]',
  'greet("world")',
]

const tickTyping = (model: Model): Step => {
  const phrase = PHRASES[model.typingIndex] ?? PHRASES[0]
  if (!model.typingDeleting) {
    if (model.typingCount >= phrase.length)
      return [{ ...model, typed: phrase, typingDeleting: true }, [DelayTyping({ ms: 1400 })]]
    const grown = model.typingCount + 1
    return [
      { ...model, typed: phrase.slice(0, grown), typingCount: grown },
      [DelayTyping({ ms: 55 })],
    ]
  }
  if (model.typingCount <= 0) {
    const nextIndex = (model.typingIndex + 1) % PHRASES.length
    return [
      { ...model, typed: '', typingCount: 0, typingDeleting: false, typingIndex: nextIndex },
      [DelayTyping({ ms: 300 })],
    ]
  }
  const shrunk = model.typingCount - 1
  return [
    { ...model, typed: phrase.slice(0, shrunk), typingCount: shrunk },
    [DelayTyping({ ms: 26 })],
  ]
}

const clamp = (value: number, max: number): number =>
  Math.max(0, Math.min(max, value))

const update = (model: Model, message: Message): Step =>
  Match.value(message).pipe(
    Match.withReturnType<Step>(),
    Match.tagsExhaustive({
      SelectedTab: ({ id }) => [{ ...model, activeTab: id }, []],
      SelectedStep: ({ step }) => [{ ...model, howStep: step }, []],
      Typed: ({ query }) => [{ ...model, query, focus: 0 }, []],
      MovedFocus: ({ delta, count }) => [
        { ...model, focus: clamp(model.focus + delta, Math.max(0, count - 1)) },
        [],
      ],
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
      TypingTicked: () => tickTyping(model),
    }),
  )

import './landing.css'

const emptyModel: Model = {
  activeTab: 'a-first-loom.loom',
  rotatorIndex: 0,
  rotatorPhase: 'normal',
  typed: '',
  typingIndex: 0,
  typingCount: 0,
  typingDeleting: false,
  howStep: 1,
  query: '',
  focus: 0,
  copied: '',
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
  init: (seed: Model): Step => [seed, [DelayRotateOut(), DelayTyping({ ms: 500 })]],
  update,
  view,
  container: document.getElementById('root'),
  hydrate: ssrHydration(),
})

Runtime.run(application)
