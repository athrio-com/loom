import { Array } from 'effect'
import type { Document, Html } from 'foldkit/html'
import {
  ChangedDraft,
  ClearedCompleted,
  RemovedTodo,
  SetFilter,
  SubmittedDraft,
  ToggledTodo,
  h,
  remaining,
  visibleTodos,
  type Filter,
  type Model,
  type Todo,
} from './model'

const draftField = (model: Model): Html =>
  h.header(
    [h.Class('head')],
    [
      h.h1([], ['Todos']),
      h.div(
        [h.Class('compose')],
        [
          h.input([
            h.Class('new'),
            h.Placeholder('What needs doing?'),
            h.Value(model.draft),
            h.OnInput((text) => ChangedDraft({ text })),
          ]),
          h.button([h.Class('add'), h.OnClick(SubmittedDraft())], ['Add']),
        ],
      ),
    ],
  )

const todoItem = (todo: Todo): Html =>
  h.li(
    [h.Key(todo.id), h.Class(todo.done ? 'item done' : 'item')],
    [
      h.input([
        h.Class('check'),
        h.Type('checkbox'),
        h.Checked(todo.done),
        h.OnChange(() => ToggledTodo({ id: todo.id })),
      ]),
      h.span([h.Class('text')], [todo.text]),
      h.button([h.Class('remove'), h.OnClick(RemovedTodo({ id: todo.id }))], ['×']),
    ],
  )

const listView = (model: Model): Html =>
  h.ul([h.Class('list')], Array.map(visibleTodos(model), todoItem))

const filterButton = (current: Filter, filter: Filter, label: string): Html =>
  h.button(
    [h.Class(current === filter ? 'filter on' : 'filter'), h.OnClick(SetFilter({ filter }))],
    [label],
  )

const footerView = (model: Model): Html =>
  h.footer(
    [h.Class('foot')],
    [
      h.span([h.Class('count')], [`${remaining(model)} left`]),
      h.div(
        [h.Class('filters')],
        [
          filterButton(model.filter, 'all', 'All'),
          filterButton(model.filter, 'active', 'Active'),
          filterButton(model.filter, 'completed', 'Completed'),
        ],
      ),
      h.button([h.Class('clear'), h.OnClick(ClearedCompleted())], ['Clear completed']),
    ],
  )

const appView = (model: Model): Html =>
  h.div(
    [h.Id('app'), h.Class('todo')],
    [draftField(model), listView(model), footerView(model)],
  )

export const view = (model: Model): Document => ({
  title: 'Foldkit SSR — Todos',
  body: appView(model),
})
