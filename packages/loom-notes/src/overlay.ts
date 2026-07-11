import { Array, Effect, Match, Option, Schema as S, Stream } from 'effect'
import { Command, Subscription } from '@athrio/foldkit'
import { html } from '@athrio/foldkit/html'
import type { Html } from '@athrio/foldkit/html'
import { m } from '@athrio/foldkit/message'
import { clsx } from 'clsx'
import { LoomSourceSchema, NoteSchema, RectSchema, type Note, type Rect } from './note'

const PendingSchema = S.Union([
  S.Struct({ kind: S.tag('dom'), selector: S.String, label: S.String, rect: RectSchema }),
  S.Struct({ kind: S.tag('loom'), source: LoomSourceSchema, label: S.String, rect: RectSchema }),
])
type Pending = typeof PendingSchema.Type

export const Model = S.Struct({
  base: S.String,
  project: S.String,
  route: S.String,
  notes: S.Array(NoteSchema),
  open: S.Boolean,
  picking: S.Boolean,
  hover: S.optional(RectSchema),
  pending: S.optional(PendingSchema),
  draft: S.String,
  editing: S.optional(S.Number),
  editText: S.String,
})
export type Model = typeof Model.Type

export const Toggled = m('Toggled')
export const ToggledPick = m('ToggledPick')
export const Hovered = m('Hovered', { rect: RectSchema })
export const Picked = m('Picked', { pending: PendingSchema })
export const Escaped = m('Escaped')
export const DraftChanged = m('DraftChanged', { value: S.String })
export const Sent = m('Sent')
export const GotNotes = m('GotNotes', { notes: S.Array(NoteSchema) })
export const Resolved = m('Resolved', { seq: S.Number })
export const Discarded = m('Discarded', { seq: S.Number })
export const StartedEdit = m('StartedEdit', { seq: S.Number, text: S.String })
export const EditChanged = m('EditChanged', { value: S.String })
export const SavedEdit = m('SavedEdit')
export const CancelledEdit = m('CancelledEdit')

export const Message = S.Union([
  Toggled,
  ToggledPick,
  Hovered,
  Picked,
  Escaped,
  DraftChanged,
  Sent,
  GotNotes,
  Resolved,
  Discarded,
  StartedEdit,
  EditChanged,
  SavedEdit,
  CancelledEdit,
])
export type Message = typeof Message.Type

const h = html<Message>()

const feedUrl = (base: string, project: string): string =>
  `${base}/notes/feed?project=${encodeURIComponent(project)}`

const fetchFeed = (base: string, project: string) =>
  Effect.promise(() => fetch(feedUrl(base, project)).then((response) => response.json())).pipe(
    Effect.map((data) => GotNotes({ notes: S.decodeUnknownSync(S.Array(NoteSchema))(data) })),
  )

const postJson = (base: string, path: string, body: unknown): Effect.Effect<Response> =>
  Effect.promise(() =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )

const settle = (base: string, project: string, path: string, body: unknown) =>
  postJson(base, path, body).pipe(Effect.andThen(fetchFeed(base, project)))

const config = (): { readonly base: string; readonly project: string } =>
  Option.match(Option.fromNullishOr(document.querySelector('script[data-loom-project]')), {
    onNone: () => ({ base: location.origin, project: 'local' }),
    onSome: (tag) => ({
      base: new URL(tag.getAttribute('src') ?? location.href, location.href).origin,
      project: tag.getAttribute('data-loom-project') ?? 'local',
    }),
  })

const FetchNotes = Command.define('FetchNotes', { base: S.String, project: S.String }, GotNotes)(
  ({ base, project }) => fetchFeed(base, project),
)

const SendChat = Command.define(
  'SendChat',
  { base: S.String, project: S.String, route: S.String, text: S.String },
  GotNotes,
)(({ base, project, route, text }) =>
  settle(base, project, '/notes/capture', { kind: 'chat', project, route, text }),
)

const SendAnnotation = Command.define(
  'SendAnnotation',
  { base: S.String, project: S.String, route: S.String, pending: PendingSchema, text: S.String },
  GotNotes,
)(({ base, project, route, pending, text }) =>
  settle(base, project, '/notes/capture', { ...pending, project, route, text }),
)

const SendResolve = Command.define(
  'SendResolve',
  { base: S.String, project: S.String, seq: S.Number },
  GotNotes,
)(({ base, project, seq }) => settle(base, project, '/notes/resolve', { project, seq }))

const SendDiscard = Command.define(
  'SendDiscard',
  { base: S.String, project: S.String, seq: S.Number },
  GotNotes,
)(({ base, project, seq }) => settle(base, project, '/notes/discard', { project, seq }))

const SendEdit = Command.define(
  'SendEdit',
  { base: S.String, project: S.String, seq: S.Number, text: S.String },
  GotNotes,
)(({ base, project, seq, text }) => settle(base, project, '/notes/edit', { project, seq, text }))

const rectOf = (el: Element): Rect => {
  const box = el.getBoundingClientRect()
  return { x: box.x, y: box.y, width: box.width, height: box.height }
}

const labelOf = (el: Element): string =>
  `${el.tagName.toLowerCase()} "${(el.textContent ?? '').trim().slice(0, 40)}"`

const nthOfType = (el: Element): string => {
  const tag = el.tagName.toLowerCase()
  return Option.match(Option.fromNullishOr(el.parentElement), {
    onNone: () => tag,
    onSome: (parent) => {
      const twins = Array.filter(Array.fromIterable(parent.children), (child) => child.tagName === el.tagName)
      const nth = Option.getOrElse(Array.findFirstIndex(twins, (child) => child === el), () => 0) + 1
      return twins.length > 1 ? `${tag}:nth-of-type(${nth})` : tag
    },
  })
}

const pathTo = (el: Element, budget: number): string =>
  el.parentElement === null || el.parentElement === document.body || budget === 0
    ? nthOfType(el)
    : `${pathTo(el.parentElement, budget - 1)} > ${nthOfType(el)}`

const selectorFor = (el: Element): string => (el.id === '' ? pathTo(el, 5) : `#${el.id}`)

const anchorOf = (el: Element): Pending =>
  Option.match(Option.fromNullishOr(el.closest('[data-loom-chapter][data-loom-section]')), {
    onSome: (loom) => ({
      kind: 'loom' as const,
      source: {
        chapter: loom.getAttribute('data-loom-chapter') ?? '',
        section: loom.getAttribute('data-loom-section') ?? '',
      },
      label: labelOf(el),
      rect: rectOf(el),
    }),
    onNone: () => ({ kind: 'dom' as const, selector: selectorFor(el), label: labelOf(el), rect: rectOf(el) }),
  })

const overlayHostId = 'loom-notes-overlay'

const hostElement = (target: EventTarget | null): Option.Option<Element> =>
  target instanceof Element && target.id !== overlayHostId ? Option.some(target) : Option.none()

const subscriptions = Subscription.make<Model, Message>()((entry) => ({
  hoverElement: entry(
    { picking: S.Boolean },
    {
      modelToDependencies: (model) => ({ picking: model.picking }),
      dependenciesToStream: ({ picking }) =>
        picking
          ? Subscription.fromEventFilterMap({
              target: document,
              type: 'mousemove',
              options: { capture: true },
              toMessage: (event: Event) =>
                Option.map(hostElement(event.target), (el) => Hovered({ rect: rectOf(el) })),
            })
          : Stream.empty,
    },
  ),
  clickElement: entry(
    { picking: S.Boolean },
    {
      modelToDependencies: (model) => ({ picking: model.picking }),
      dependenciesToStream: ({ picking }) =>
        picking
          ? Subscription.fromEventFilterMap({
              target: document,
              type: 'click',
              options: { capture: true },
              toMessage: (event: Event) =>
                Option.map(hostElement(event.target), (el) => {
                  event.preventDefault()
                  event.stopPropagation()
                  return Picked({ pending: anchorOf(el) })
                }),
            })
          : Stream.empty,
    },
  ),
}))

const sent = (model: Model): readonly [Model, ReadonlyArray<Command.Command<Message>>] =>
  model.pending === undefined
    ? [
        { ...model, draft: '' },
        [SendChat({ base: model.base, project: model.project, route: model.route, text: model.draft })],
      ]
    : [
        { ...model, draft: '', pending: undefined },
        [
          SendAnnotation({
            base: model.base,
            project: model.project,
            route: model.route,
            pending: model.pending,
            text: model.draft,
          }),
        ],
      ]

const saved = (model: Model): readonly [Model, ReadonlyArray<Command.Command<Message>>] =>
  model.editing === undefined
    ? [model, []]
    : [
        { ...model, editing: undefined },
        [SendEdit({ base: model.base, project: model.project, seq: model.editing, text: model.editText })],
      ]

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
    Match.tag('ToggledPick', () => [{ ...model, picking: !model.picking, open: false }, []]),
    Match.tag('Hovered', ({ rect }) => [{ ...model, hover: rect }, []]),
    Match.tag('Picked', ({ pending }) => [
      { ...model, picking: false, pending, hover: undefined, open: true },
      [],
    ]),
    Match.tag('Escaped', () => [
      { ...model, picking: false, pending: undefined, hover: undefined },
      [],
    ]),
    Match.tag('DraftChanged', ({ value }) => [{ ...model, draft: value }, []]),
    Match.tag('Sent', () => (model.draft.trim() === '' ? [model, []] : sent(model))),
    Match.tag('GotNotes', ({ notes }) => [{ ...model, notes }, []]),
    Match.tag('Resolved', ({ seq }) => [
      model,
      [SendResolve({ base: model.base, project: model.project, seq })],
    ]),
    Match.tag('Discarded', ({ seq }) => [
      model,
      [SendDiscard({ base: model.base, project: model.project, seq })],
    ]),
    Match.tag('StartedEdit', ({ seq, text }) => [{ ...model, editing: seq, editText: text }, []]),
    Match.tag('EditChanged', ({ value }) => [{ ...model, editText: value }, []]),
    Match.tag('SavedEdit', () => saved(model)),
    Match.tag('CancelledEdit', () => [{ ...model, editing: undefined }, []]),
    Match.exhaustive,
  )

const glyphOf = (note: Note): string =>
  Match.value(note).pipe(
    Match.when({ kind: 'dom' }, () => '◎'),
    Match.when({ kind: 'loom' }, () => '⧉'),
    Match.when({ kind: 'chat' }, () => '›'),
    Match.exhaustive,
  )

const control = (label: string, message: Message): Html =>
  h.button(
    [h.Class('rounded px-1 text-slate-500 hover:bg-white/10 hover:text-slate-200'), h.OnClick(message)],
    [label],
  )

const controls = (note: Note): Html =>
  h.div(
    [h.Class('ml-auto flex shrink-0 gap-1 opacity-0 group-hover:opacity-100')],
    [
      control('✎', StartedEdit({ seq: note.seq, text: note.text })),
      ...(note.addressed ? [] : [control('✓', Resolved({ seq: note.seq }))]),
      control('🗑', Discarded({ seq: note.seq })),
    ],
  )

const editRow = (editText: string): Html =>
  h.div(
    [h.Class('flex flex-col gap-1 border-b border-white/10 py-2')],
    [
      h.textarea(
        [
          h.Class('w-full resize-none rounded border border-white/10 bg-slate-950 p-2 text-slate-200'),
          h.Value(editText),
          h.OnInput((value: string) => EditChanged({ value })),
        ],
        [],
      ),
      h.div(
        [h.Class('flex gap-1')],
        [
          h.button(
            [h.Class('rounded bg-emerald-400 px-2 py-1 text-xs text-slate-900'), h.OnClick(SavedEdit())],
            ['Save'],
          ),
          h.button(
            [h.Class('rounded border border-white/10 px-2 py-1 text-xs text-slate-300'), h.OnClick(CancelledEdit())],
            ['Cancel'],
          ),
        ],
      ),
    ],
  )

const noteRow = (note: Note, editing: number | undefined, editText: string): Html =>
  note.seq === editing
    ? editRow(editText)
    : h.div(
        [h.Class(clsx('group flex gap-2 border-b border-white/10 py-2', note.addressed && 'opacity-40'))],
        [
          h.span([h.Class('text-emerald-400')], [glyphOf(note)]),
          h.span([h.Class('min-w-0 break-words')], [note.text]),
          controls(note),
        ],
      )

const highlight = (rect: Rect): Html =>
  h.div(
    [
      h.Class('pointer-events-none fixed rounded border-2 border-emerald-400 bg-emerald-400/10'),
      h.Style({ left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` }),
    ],
    [],
  )

const composer = (model: Model, action: Html, label: string): Html =>
  h.div(
    [h.Class('border-t border-white/10 p-3')],
    [
      h.textarea(
        [
          h.Class(
            'h-16 w-full resize-none rounded-md border border-white/10 bg-slate-950 p-2 text-slate-100 focus:border-emerald-400 focus:outline-none',
          ),
          h.Value(model.draft),
          h.OnInput((value: string) => DraftChanged({ value })),
        ],
        [],
      ),
      h.button(
        [
          h.Class(
            'mt-2 w-full rounded-md bg-emerald-400 py-1.5 font-medium text-slate-900 transition hover:bg-emerald-300',
          ),
          h.OnClick(Sent()),
        ],
        [label],
      ),
      action,
    ],
  )

const pickButton = (model: Model): Html =>
  h.button(
    [
      h.Class(
        clsx(
          'mt-2 w-full rounded-md border py-1.5 transition',
          model.picking
            ? 'border-emerald-400 text-emerald-400'
            : 'border-white/10 text-slate-400 hover:border-white/20 hover:text-slate-200',
        ),
      ),
      h.OnClick(ToggledPick()),
    ],
    ['◎ Pick an element'],
  )

const emptyState = (): Html =>
  h.div(
    [h.Class('px-3 py-12 text-center text-xs leading-relaxed text-slate-500')],
    ['No notes yet — write one below, or pick an element on the page.'],
  )

const noteList = (model: Model): Html =>
  h.div(
    [h.Class('flex-1 overflow-auto px-3')],
    model.notes.length === 0
      ? [emptyState()]
      : Array.map(model.notes, (note) => noteRow(note, model.editing, model.editText)),
  )

const header = (): Html =>
  h.div(
    [h.Class('flex items-center justify-between border-b border-white/10 px-3 py-2.5 text-slate-300')],
    [
      h.div(
        [h.Class('flex items-center gap-2')],
        [h.span([h.Class('h-2 w-2 rounded-full bg-emerald-400')], []), h.span([], ['Loom Notes'])],
      ),
      h.button(
        [
          h.Class('rounded px-1.5 text-slate-500 transition hover:bg-white/10 hover:text-slate-200'),
          h.OnClick(Toggled()),
        ],
        ['×'],
      ),
    ],
  )

const panel = (model: Model): Html =>
  h.div(
    [
      h.Class(
        'pointer-events-auto fixed right-0 top-0 flex h-screen w-[360px] flex-col border-l border-white/10 bg-slate-900/95 font-mono text-sm text-slate-200 shadow-2xl backdrop-blur',
      ),
    ],
    [header(), noteList(model), composer(model, pickButton(model), 'Send')],
  )

const popover = (model: Model, pending: Pending): Html =>
  h.div(
    [
      h.Class(
        'pointer-events-auto fixed bottom-6 left-1/2 w-96 max-w-[86vw] -translate-x-1/2 rounded-xl border border-emerald-400/60 bg-slate-900/95 p-3 font-mono text-sm text-slate-200 shadow-2xl backdrop-blur',
      ),
    ],
    [
      h.div([h.Class('mb-2 truncate text-xs text-emerald-400')], [`◎ ${pending.label}`]),
      composer(model, h.div([], []), 'Add note'),
    ],
  )

const launcher = (): Html =>
  h.button(
    [
      h.Class(
        'pointer-events-auto fixed bottom-4 right-4 flex items-center gap-1.5 rounded-full bg-emerald-400 px-4 py-2 font-mono text-sm font-medium text-slate-900 shadow-lg transition hover:bg-emerald-300',
      ),
      h.OnClick(Toggled()),
    ],
    ['✎ Annotate'],
  )

const view = (model: Model): Html =>
  h.div(
    [h.Class('pointer-events-none fixed inset-0 font-mono')],
    [
      launcher(),
      ...(model.open && model.pending === undefined ? [panel(model)] : []),
      ...(model.picking && model.hover !== undefined ? [highlight(model.hover)] : []),
      ...(model.pending !== undefined ? [popover(model, model.pending)] : []),
    ],
  )

const overlayStyles = '__LOOM_NOTES_CSS__'

const mountPoint = (): HTMLElement => {
  const host = document.createElement('div')
  host.id = overlayHostId
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
    { base, project, route: location.pathname, notes: [], open: false, picking: false, draft: '', editText: '' },
    [FetchNotes({ base, project })],
  ]
}

export const start = (): void => {
  if (document.getElementById(overlayHostId)) return
  run(makeElement({ Model, init, update, view, subscriptions, container: mountPoint() }))
}

start()
