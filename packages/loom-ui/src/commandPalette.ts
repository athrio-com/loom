import { Array, Match, Option, Schema as S } from 'effect'
import { html } from 'foldkit/html'
import { defineView } from 'foldkit/submodel'
import { m } from 'foldkit/message'
import type { ReturnWithOutMessage } from 'foldkit/update'

export const Model = S.Struct({ query: S.String, highlighted: S.Number })
export type Model = typeof Model.Type

export const init: Model = { query: '', highlighted: 0 }

export const Typed = m('Typed', { query: S.String })
export const Moved = m('Moved', { delta: S.Number, count: S.Number })
export const Chose = m('Chose', { id: S.String })
export const Dismissed = m('Dismissed')
export const Ignored = m('Ignored')

export const Message = S.Union([Typed, Moved, Chose, Dismissed, Ignored])
export type Message = typeof Message.Type

const h = html<Message>()

export const Selected = m('Selected', { id: S.String })
export const Closed = m('Closed')

export const OutMessage = S.Union([Selected, Closed])
export type OutMessage = typeof OutMessage.Type

export type Return = ReturnWithOutMessage<Model, Message, OutMessage>

const clamp = (value: number, max: number): number =>
  Math.max(0, Math.min(max, value))

export const update = (model: Model, message: Message): Return =>
  Match.value(message).pipe(
    Match.withReturnType<Return>(),
    Match.tagsExhaustive({
      Typed: ({ query }) => [{ ...model, query, highlighted: 0 }, [], Option.none()],
      Moved: ({ delta, count }) => [
        { ...model, highlighted: clamp(model.highlighted + delta, count - 1) },
        [],
        Option.none(),
      ],
      Chose: ({ id }) => [model, [], Option.some(Selected({ id }))],
      Dismissed: () => [model, [], Option.some(Closed())],
      Ignored: () => [model, [], Option.none()],
    }),
  )

export type Command = { id: string; label: string }

const matches =
  (query: string) =>
  (command: Command): boolean =>
    command.label.toLowerCase().includes(query.toLowerCase())

const keyMessage = (
  key: string,
  results: ReadonlyArray<Command>,
  highlighted: number,
): Message =>
  Match.value(key).pipe(
    Match.when('ArrowDown', () => Moved({ delta: 1, count: results.length })),
    Match.when('ArrowUp', () => Moved({ delta: -1, count: results.length })),
    Match.when('Enter', () =>
      Option.match(Array.get(results, highlighted), {
        onNone: () => Ignored(),
        onSome: (command) => Chose({ id: command.id }),
      }),
    ),
    Match.when('Escape', () => Dismissed()),
    Match.orElse(() => Ignored()),
  )

export type ViewInputs = { commands: ReadonlyArray<Command> }

const rowView =
  (highlighted: number) =>
  (command: Command, index: number) =>
    h.li(
      [
        h.Class(
          index === highlighted ? 'loom-cmd-item is-active' : 'loom-cmd-item',
        ),
        h.OnClick(Chose({ id: command.id })),
      ],
      [command.label],
    )

export const view = defineView<Model, Message, ViewInputs>((model, inputs) => {
  const results = Array.filter(inputs.commands, matches(model.query))
  return h.div(
    [h.Class('loom-cmd')],
    [
      h.input([
        h.Class('loom-cmd-input'),
        h.Value(model.query),
        h.Placeholder('Type a command…'),
        h.OnInput((query) => Typed({ query })),
        h.OnKeyDown((key) => keyMessage(key, results, model.highlighted)),
      ]),
      h.ul(
        [h.Class('loom-cmd-list')],
        Array.map(results, rowView(model.highlighted)),
      ),
    ],
  )
})
