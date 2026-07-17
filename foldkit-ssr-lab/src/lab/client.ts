import { Array, Duration, Effect, Match, Option, Schema as S, Stream, pipe } from 'effect'
import { Command, Runtime, Subscription } from '@athrio/foldkit'
import * as AsyncData from '@athrio/foldkit/asyncData'
import {
  BOUNDARY_FILL_EVENT,
  bufferedFills,
  markBooted,
  ssrHydration,
} from '@athrio/foldkit-hydration'
import { view } from './view'
import { bodyOf, initialCards } from './cards'
import {
  Body,
  CardLoaded,
  Flags,
  type LogEntry,
  Message,
  Model,
  Observed,
} from './model'

type Step = readonly [Model, ReadonlyArray<Command.Command<Message>>]

const LoadCard = Command.define('LoadCard', { id: S.String, delayMs: S.Number }, CardLoaded)(
  ({ id, delayMs }) =>
    Effect.sleep(Duration.millis(delayMs)).pipe(Effect.as(CardLoaded({ id, body: bodyOf(id) }))),
)

const clientLoads = (model: Model): ReadonlyArray<Command.Command<Message>> =>
  pipe(
    model.cards,
    Array.filter((card) => card.strategy === 'client' && !AsyncData.hasData(card.content)),
    Array.map((card) => LoadCard({ id: card.id, delayMs: card.priority * 600 })),
  )

const decodeBody = S.decodeUnknownSync(S.String)

const seedCards = (current: Model['cards']): Model['cards'] =>
  Array.reduce(bufferedFills(), current, (soFar, fill) =>
    Array.map(soFar, (card) =>
      card.id === fill.id ? { ...card, content: Body.Success({ data: decodeBody(fill.data) }) } : card,
    ),
  )

const bufferedLog = (): ReadonlyArray<LogEntry> =>
  (window as unknown as { __domlog?: ReadonlyArray<LogEntry> }).__domlog ?? []

const flags: Effect.Effect<Flags> = Effect.sync(() => {
  markBooted()
  const inlined = Option.fromNullishOr(document.getElementById('foldkit-model')?.textContent)
  const shell = Option.match(inlined, {
    onSome: (text) => S.decodeUnknownSync(Flags)(JSON.parse(text)),
    onNone: (): Flags => ({ cards: initialCards, log: [] }),
  })
  return { ...shell, cards: seedCards(shell.cards), log: [...bufferedLog()] }
})

const withCardLoaded = (model: Model, id: string, body: string): Model => ({
  ...model,
  cards: Array.map(model.cards, (card) =>
    card.id === id ? { ...card, content: Body.Success({ data: body }) } : card,
  ),
})

const update = (model: Model, message: Message): Step =>
  Match.value(message).pipe(
    Match.withReturnType<Step>(),
    Match.tagsExhaustive({
      CardLoaded: ({ id, body }) => [withCardLoaded(model, id, body), []],
      Observed: ({ at, label, strategy }) => [
        { ...model, log: [...model.log, { at, label, strategy }] },
        [],
      ],
    }),
  )

const fillStream: Stream.Stream<Message> = Subscription.fromEvent<CustomEvent, Message>({
  target: window,
  type: BOUNDARY_FILL_EVENT,
  toMessage: (event) => CardLoaded({ id: event.detail.id, body: decodeBody(event.detail.data) }),
})

const domObservations: Stream.Stream<Message> = Subscription.fromEvent<CustomEvent, Message>({
  target: window,
  type: 'lab:dom',
  toMessage: (event) =>
    Observed({ at: event.detail.at, label: event.detail.label, strategy: event.detail.strategy }),
})

const subscriptions = Subscription.make<Model, Message>()(() => ({
  fills: Subscription.persistent(fillStream),
  observations: Subscription.persistent(domObservations),
}))

const application = Runtime.makeApplication({
  Model,
  Flags,
  flags,
  init: (seed: Flags): Step => [seed, clientLoads(seed)],
  update,
  view,
  subscriptions,
  container: document.getElementById('root'),
  hydrate: ssrHydration(),
})

Runtime.run(application)
