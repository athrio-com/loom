import { Array, Effect, Match, Option, Schema as S } from 'effect'
import { Command, Runtime } from '@athrio/foldkit'
import { ssrHydration } from '@athrio/foldkit-hydration'
import { view } from './view'
import {
  ChangedDraft,
  ClearedCompleted,
  Flags,
  Message,
  Model,
  Persisted,
  RemovedTodo,
  SetFilter,
  SubmittedDraft,
  ToggledTodo,
} from './model'

type Step = readonly [Model, ReadonlyArray<Command.Command<Message>>]

const STORAGE_KEY = 'foldkit-ssr-todos'

const Persist = Command.define('Persist', { json: S.String }, Persisted)(({ json }) =>
  Effect.sync(() => window.localStorage.setItem(STORAGE_KEY, json)).pipe(Effect.as(Persisted())),
)

const persist = (model: Model): Step => [model, [Persist({ json: JSON.stringify(model) })]]

const emptyModel: Model = { todos: [], draft: '', filter: 'all', seq: 0 }

const decodeModel = (text: string): Flags => S.decodeUnknownSync(Flags)(JSON.parse(text))

const flags: Effect.Effect<Flags> = Effect.sync(() => {
  const saved = Option.fromNullishOr(window.localStorage.getItem(STORAGE_KEY))
  const inlined = Option.fromNullishOr(document.getElementById('foldkit-model')?.textContent)
  return Option.match(Option.orElse(saved, () => inlined), {
    onSome: decodeModel,
    onNone: () => emptyModel,
  })
})

const addTodo = (model: Model): Model => {
  const text = model.draft.trim()
  return text.length === 0
    ? model
    : {
        ...model,
        todos: [...model.todos, { id: String(model.seq), text, done: false }],
        draft: '',
        seq: model.seq + 1,
      }
}

const update = (model: Model, message: Message): Step =>
  Match.value(message).pipe(
    Match.withReturnType<Step>(),
    Match.tagsExhaustive({
      ChangedDraft: ({ text }) => [{ ...model, draft: text }, []],
      SubmittedDraft: () => persist(addTodo(model)),
      ToggledTodo: ({ id }) =>
        persist({
          ...model,
          todos: Array.map(model.todos, (todo) =>
            todo.id === id ? { ...todo, done: !todo.done } : todo,
          ),
        }),
      RemovedTodo: ({ id }) =>
        persist({ ...model, todos: Array.filter(model.todos, (todo) => todo.id !== id) }),
      SetFilter: ({ filter }) => persist({ ...model, filter }),
      ClearedCompleted: () =>
        persist({ ...model, todos: Array.filter(model.todos, (todo) => !todo.done) }),
      Persisted: () => [model, []],
    }),
  )

const application = Runtime.makeApplication({
  Model,
  Flags,
  flags,
  init: (seed: Flags): Step => [seed, []],
  update,
  view,
  container: document.getElementById('root'),
  hydrate: ssrHydration(),
})

Runtime.run(application)
