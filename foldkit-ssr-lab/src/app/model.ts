import { Array, Match, Schema as S } from 'effect'
import { html } from 'foldkit/html'
import { m } from 'foldkit/message'

export const Todo = S.Struct({
  id: S.String,
  text: S.String,
  done: S.Boolean,
})
export type Todo = typeof Todo.Type

export const Filter = S.Literals(['all', 'active', 'completed'])
export type Filter = typeof Filter.Type

export const Model = S.Struct({
  todos: S.Array(Todo),
  draft: S.String,
  filter: Filter,
  seq: S.Number,
})
export type Model = typeof Model.Type

export const Flags = Model
export type Flags = typeof Flags.Type

export const ChangedDraft = m('ChangedDraft', { text: S.String })
export const SubmittedDraft = m('SubmittedDraft')
export const ToggledTodo = m('ToggledTodo', { id: S.String })
export const RemovedTodo = m('RemovedTodo', { id: S.String })
export const SetFilter = m('SetFilter', { filter: Filter })
export const ClearedCompleted = m('ClearedCompleted')
export const Persisted = m('Persisted')

export const Message = S.Union([
  ChangedDraft,
  SubmittedDraft,
  ToggledTodo,
  RemovedTodo,
  SetFilter,
  ClearedCompleted,
  Persisted,
])
export type Message = typeof Message.Type

export const h = html<Message>()

const matchesFilter = (filter: Filter, todo: Todo): boolean =>
  Match.value(filter).pipe(
    Match.when('all', () => true),
    Match.when('active', () => !todo.done),
    Match.when('completed', () => todo.done),
    Match.exhaustive,
  )

export const visibleTodos = (model: Model): ReadonlyArray<Todo> =>
  Array.filter(model.todos, (todo) => matchesFilter(model.filter, todo))

export const remaining = (model: Model): number =>
  Array.filter(model.todos, (todo) => !todo.done).length
