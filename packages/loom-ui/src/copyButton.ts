import { Effect, Match, Schema as S } from 'effect'
import { define, type Command } from 'foldkit/command'
import { html } from 'foldkit/html'
import { defineView } from 'foldkit/submodel'
import { m } from 'foldkit/message'

export const Model = S.Struct({ copied: S.Boolean })
export type Model = typeof Model.Type

export const init: Model = { copied: false }

export const Pressed = m('Pressed', { text: S.String })
export const Reset = m('Reset')

export const Message = S.Union([Pressed, Reset])
export type Message = typeof Message.Type

const h = html<Message>()

const CopyText = define('CopyText', { text: S.String }, Reset)(({ text }) =>
  Effect.tryPromise(() => navigator.clipboard.writeText(text)).pipe(
    Effect.ignore,
    Effect.andThen(Effect.sleep('1500 millis')),
    Effect.as(Reset()),
  ),
)

export type Return = readonly [Model, ReadonlyArray<Command<Message>>]

export const update = (model: Model, message: Message): Return =>
  Match.value(message).pipe(
    Match.withReturnType<Return>(),
    Match.tagsExhaustive({
      Pressed: ({ text }) => [{ ...model, copied: true }, [CopyText({ text })]],
      Reset: () => [{ ...model, copied: false }, []],
    }),
  )

export type ViewInputs = { text: string }

export const view = defineView<Model, Message, ViewInputs>((model, inputs) =>
  h.button(
    [
      h.Class(model.copied ? 'loom-copy is-copied' : 'loom-copy'),
      h.OnClick(Pressed({ text: inputs.text })),
    ],
    [model.copied ? 'Copied' : 'Copy'],
  ),
)
