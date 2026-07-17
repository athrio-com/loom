import { Array, Effect, Match, Option, Schema as S, Stream, pipe } from 'effect'
import { Command, Runtime, Subscription } from '@athrio/foldkit'
import * as AsyncData from '@athrio/foldkit/asyncData'
import {
  BOUNDARY_FILL_EVENT,
  bufferedFills,
  markBooted,
  ssrHydration,
} from '@athrio/foldkit-hydration'
import { view } from './view'
import { messagesOf, sessions as seedSessions } from './conversations'
import {
  ChangedDraft,
  ChatMessage,
  Feed,
  Flags,
  Message,
  MessagesArrived,
  Model,
  SavedDraft,
  SelectedSession,
  SentMessage,
} from './model'

type Step = readonly [Model, ReadonlyArray<Command.Command<Message>>]

const DRAFT_KEY = 'foldkit-ssr-chat-draft'

const SaveDraft = Command.define('SaveDraft', { text: S.String }, SavedDraft)(({ text }) =>
  Effect.sync(() => window.localStorage.setItem(DRAFT_KEY, text)).pipe(Effect.as(SavedDraft())),
)

const draftStep = (model: Model, text: string): Step => [
  { ...model, draft: text },
  [SaveDraft({ text })],
]

const LoadConversation = Command.define('LoadConversation', { id: S.String }, MessagesArrived)(
  ({ id }) =>
    Effect.sleep('600 millis').pipe(
      Effect.as(MessagesArrived({ sessionId: id, messages: messagesOf(id) })),
    ),
)

const DecodedFill = S.Struct({ sessionId: S.String, messages: S.Array(ChatMessage) })
const decodeFill = S.decodeUnknownSync(DecodedFill)

const defaultSessionId = pipe(
  Array.head(seedSessions),
  Option.map((session) => session.id),
  Option.getOrElse(() => ''),
)

const fallbackModel: Model = {
  sessions: seedSessions,
  activeSessionId: defaultSessionId,
  messages: Feed.Loading(),
  draft: '',
}

const decodeModel = (text: string): Flags => S.decodeUnknownSync(Flags)(JSON.parse(text))

const seedMessages = (activeId: string, inlined: Model['messages']): Model['messages'] =>
  pipe(
    bufferedFills(),
    Array.map((fill) => decodeFill(fill.data)),
    Array.findFirst((fill) => fill.sessionId === activeId),
    Option.map((fill) => Feed.Success({ data: fill.messages })),
    Option.getOrElse(() => inlined),
  )

const flags: Effect.Effect<Flags> = Effect.sync(() => {
  markBooted()
  const inlined = Option.fromNullishOr(document.getElementById('foldkit-model')?.textContent)
  const shell = Option.match(inlined, { onSome: decodeModel, onNone: () => fallbackModel })
  const draft = Option.getOrElse(
    Option.fromNullishOr(window.localStorage.getItem(DRAFT_KEY)),
    () => shell.draft,
  )
  return { ...shell, draft, messages: seedMessages(shell.activeSessionId, shell.messages) }
})

const appended = (messages: ReadonlyArray<ChatMessage>, text: string): ReadonlyArray<ChatMessage> =>
  [...messages, { id: `me-${messages.length}`, author: 'me' as const, text }]

const sendStep = (model: Model): Step => {
  const text = model.draft.trim()
  return pipe(
    AsyncData.getData(model.messages),
    Option.match({
      onNone: (): Step => [model, []],
      onSome: (messages): Step =>
        text.length === 0
          ? [model, []]
          : [
              { ...model, messages: Feed.Success({ data: appended(messages, text) }), draft: '' },
              [SaveDraft({ text: '' })],
            ],
    }),
  )
}

const update = (model: Model, message: Message): Step =>
  Match.value(message).pipe(
    Match.withReturnType<Step>(),
    Match.tagsExhaustive({
      ChangedDraft: ({ text }) => draftStep(model, text),
      SelectedSession: ({ id }) =>
        id === model.activeSessionId
          ? [model, []]
          : [{ ...model, activeSessionId: id, messages: Feed.Loading() }, [LoadConversation({ id })]],
      MessagesArrived: ({ sessionId, messages }) =>
        sessionId === model.activeSessionId
          ? [{ ...model, messages: Feed.Success({ data: messages }) }, []]
          : [model, []],
      SentMessage: () => sendStep(model),
      SavedDraft: () => [model, []],
    }),
  )

const fillMessage = (data: unknown): Message => {
  const fill = decodeFill(data)
  return MessagesArrived({ sessionId: fill.sessionId, messages: fill.messages })
}

const bufferedFillStream: Stream.Stream<Message> = Stream.suspend(() =>
  Stream.fromIterable(Array.map(bufferedFills(), (fill) => fillMessage(fill.data))),
)

const liveFillStream: Stream.Stream<Message> = Subscription.fromEvent<CustomEvent, Message>({
  target: window,
  type: BOUNDARY_FILL_EVENT,
  toMessage: (event) => fillMessage(event.detail.data),
})

const subscriptions = Subscription.make<Model, Message>()(() => ({
  fills: Subscription.persistent(Stream.concat(bufferedFillStream, liveFillStream)),
}))

const application = Runtime.makeApplication({
  Model,
  Flags,
  flags,
  init: (seed: Flags): Step =>
    AsyncData.hasData(seed.messages)
      ? [seed, []]
      : [seed, [LoadConversation({ id: seed.activeSessionId })]],
  update,
  view,
  subscriptions,
  container: document.getElementById('root'),
  hydrate: ssrHydration(),
})

Runtime.run(application)
