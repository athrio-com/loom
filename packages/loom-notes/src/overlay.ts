import { Array, Effect, Match, Option, Schema as S } from 'effect'
import { Command } from '@athrio/foldkit'
import { html } from '@athrio/foldkit/html'
import type { Html } from '@athrio/foldkit/html'
import { m } from '@athrio/foldkit/message'
import { clsx } from 'clsx'
import { NoteSchema, type Note } from './note'

export const Model = S.Struct({
  base: S.String,
  project: S.String,
  route: S.String,
  notes: S.Array(NoteSchema),
  open: S.Boolean,
  draft: S.String,
})
export type Model = typeof Model.Type

export const Toggled = m('Toggled')
export const DraftChanged = m('DraftChanged', { value: S.String })
export const Sent = m('Sent')
export const GotNotes = m('GotNotes', { notes: S.Array(NoteSchema) })

export const Message = S.Union([Toggled, DraftChanged, Sent, GotNotes])
export type Message = typeof Message.Type

const h = html<Message>()

const feedUrl = (base: string, project: string): string =>
  `${base}/notes/feed?project=${encodeURIComponent(project)}`

const fetchFeed = (base: string, project: string): Effect.Effect<Message> =>
  Effect.promise(() => fetch(feedUrl(base, project)).then((response) => response.json())).pipe(
    Effect.map((data) => GotNotes({ notes: S.decodeUnknownSync(S.Array(NoteSchema))(data) })),
  )

const config = (): { readonly base: string; readonly project: string } =>
  Option.match(Option.fromNullishOr(document.querySelector('script[data-loom-project]')), {
    onNone: () => ({ base: location.origin, project: 'local' }),
    onSome: (tag) => ({
      base: new URL(tag.getAttribute('src') ?? location.href, location.href).origin,
      project: tag.getAttribute('data-loom-project') ?? 'local',
    }),
  })

const FetchNotes = Command.define(
  'FetchNotes',
  { base: S.String, project: S.String },
  GotNotes,
)(({ base, project }) => fetchFeed(base, project))

const SendChat = Command.define(
  'SendChat',
  { base: S.String, project: S.String, route: S.String, text: S.String },
  GotNotes,
)(({ base, project, route, text }) =>
  Effect.promise(() =>
    fetch(`${base}/notes/capture`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'chat', project, route, text }),
    }),
  ).pipe(Effect.andThen(fetchFeed(base, project))),
)

const update = (
  model: Model,
  message: Message,
): readonly [Model, ReadonlyArray<Command.Command<Message>>] =>
  Match.value(message).pipe(
    Match.withReturnType<readonly [Model, ReadonlyArray<Command.Command<Message>>]>(),
    Match.tag('Toggled', () => [
      { ...model, open: !model.open },
      model.open ? [] : [FetchNotes({ base: model.base, project: model.project })],
    ]),
    Match.tag('DraftChanged', ({ value }) => [{ ...model, draft: value }, []]),
    Match.tag('Sent', () =>
      model.draft.trim() === ''
        ? [model, []]
        : [
            { ...model, draft: '' },
            [
              SendChat({
                base: model.base,
                project: model.project,
                route: model.route,
                text: model.draft,
              }),
            ],
          ],
    ),
    Match.tag('GotNotes', ({ notes }) => [{ ...model, notes }, []]),
    Match.exhaustive,
  )

const glyphOf = (note: Note): string =>
  Match.value(note).pipe(
    Match.when({ kind: 'dom' }, () => '◎'),
    Match.when({ kind: 'loom' }, () => '⧉'),
    Match.when({ kind: 'chat' }, () => '›'),
    Match.exhaustive,
  )

const noteRow = (note: Note): Html =>
  h.div(
    [h.Class(clsx('flex gap-2 border-b border-white/10 py-2', note.addressed && 'opacity-40'))],
    [
      h.span([h.Class('text-emerald-400')], [glyphOf(note)]),
      h.span([h.Class('min-w-0 break-words')], [note.text]),
    ],
  )

const launcher = (): Html =>
  h.button(
    [
      h.Class(
        'pointer-events-auto fixed bottom-4 right-4 rounded-md bg-emerald-400 px-3 py-2 font-mono text-sm text-slate-900 shadow-lg',
      ),
      h.OnClick(Toggled()),
    ],
    ['✎ Annotate'],
  )

const panel = (model: Model): Html =>
  h.div(
    [
      h.Class(
        'pointer-events-auto fixed right-0 top-0 flex h-screen w-80 flex-col border-l border-white/10 bg-slate-900 font-mono text-sm text-slate-200',
      ),
    ],
    [
      h.div([h.Class('border-b border-white/10 px-3 py-2 text-slate-400')], ['Loom · Notes']),
      h.div([h.Class('flex-1 overflow-auto px-3 py-2')], Array.map(model.notes, noteRow)),
      h.div(
        [h.Class('border-t border-white/10 p-3')],
        [
          h.textarea(
            [
              h.Class('w-full resize-none rounded border border-white/10 bg-slate-950 p-2 text-slate-200'),
              h.Value(model.draft),
              h.OnInput((value: string) => DraftChanged({ value })),
            ],
            [],
          ),
          h.button(
            [
              h.Class('mt-2 w-full rounded bg-emerald-400 py-2 text-slate-900 disabled:opacity-40'),
              h.OnClick(Sent()),
            ],
            ['Send'],
          ),
        ],
      ),
    ],
  )

const view = (model: Model): Html =>
  h.div(
    [h.Class('pointer-events-none fixed inset-0')],
    [launcher(), ...(model.open ? [panel(model)] : [])],
  )

const overlayStyles = '__LOOM_NOTES_CSS__'

const mountPoint = (): HTMLElement => {
  const host = document.createElement('div')
  host.id = 'loom-notes-overlay'
  host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483000'
  const shadow = host.attachShadow({ mode: 'open' })
  const style = document.createElement('style')
  style.textContent = overlayStyles
  shadow.appendChild(style)
  const container = document.createElement('div')
  container.id = 'loom-notes-app'
  shadow.appendChild(container)
  document.body.appendChild(host)
  return container
}

import { makeElement, run } from '@athrio/foldkit/runtime'

const init = (): readonly [Model, ReadonlyArray<Command.Command<Message>>] => {
  const { base, project } = config()
  return [
    { base, project, route: location.pathname, notes: [], open: false, draft: '' },
    [FetchNotes({ base, project })],
  ]
}

export const start = (): void => {
  if (document.getElementById('loom-notes-overlay')) return
  run(makeElement({ Model, init, update, view, container: mountPoint() }))
}

start()
