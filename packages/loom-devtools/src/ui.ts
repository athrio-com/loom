import { Effect, Match, Schema as S } from 'effect'
import { Command } from '@athrio/foldkit'
import { html } from '@athrio/foldkit/html'
import type { Html } from '@athrio/foldkit/html'
import { m } from '@athrio/foldkit/message'
import { makeElement, run } from '@athrio/foldkit/runtime'

export const Model = S.Struct({
  origin: S.String,
  project: S.String,
  copied: S.Boolean,
})
export type Model = typeof Model.Type

export const ProjectChanged = m('ProjectChanged', { value: S.String })
export const CopyRequested = m('CopyRequested')
export const Copied = m('Copied')

export const Message = S.Union([ProjectChanged, CopyRequested, Copied])
export type Message = typeof Message.Type

const h = html<Message>()

const scriptFor = (model: Model): string =>
  `<script type="module" src="${model.origin}/notes.js" data-loom-project="${
    model.project.trim() || 'my-app'
  }"></script>`

const Copy = Command.define('Copy', { text: S.String }, Copied, Copied)(({ text }) =>
  Effect.tryPromise(() => navigator.clipboard.writeText(text)).pipe(
    Effect.as(Copied()),
    Effect.catchCause(() => Effect.succeed(Copied())),
  ),
)

const update = (
  model: Model,
  message: Message,
): readonly [Model, ReadonlyArray<Command.Command<Message>>] =>
  Match.value(message).pipe(
    Match.withReturnType<readonly [Model, ReadonlyArray<Command.Command<Message>>]>(),
    Match.tagsExhaustive({
      ProjectChanged: ({ value }) => [{ ...model, project: value, copied: false }, []],
      CopyRequested: () => [model, [Copy({ text: scriptFor(model) })]],
      Copied: () => [{ ...model, copied: true }, []],
    }),
  )

const view = (model: Model): Html =>
  h.div(
    [h.Class('card')],
    [
      h.div([h.Class('title')], ['Loom ', h.span([h.Class('mint')], ['Devtools'])]),
      h.div(
        [h.Class('lede')],
        [
          'Drop this script into the app you are reviewing. A Notes bar appears over the page — leave a note on an element or type a message — and a coding agent reads them over the Model Context Protocol.',
        ],
      ),
      h.div([h.Class('label')], ['project id']),
      h.input([
        h.Class('input'),
        h.Value(model.project),
        h.OnInput((value: string) => ProjectChanged({ value })),
      ]),
      h.div([h.Class('snippet')], [scriptFor(model)]),
      h.button(
        [h.Class('copy'), h.OnClick(CopyRequested())],
        [model.copied ? 'Copied' : 'Copy script'],
      ),
    ],
  )

const init = (): readonly [Model, ReadonlyArray<Command.Command<Message>>] => [
  { origin: window.location.origin, project: 'my-app', copied: false },
  [],
]

export const start = (): void => {
  const container = document.getElementById('app')
  if (container === null) return
  run(makeElement({ Model, init, update, view, container }))
}

start()
