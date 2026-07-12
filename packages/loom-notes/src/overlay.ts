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
  reachable: S.Boolean,
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
export const Unreachable = m('Unreachable')
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
  Unreachable,
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
  Effect.tryPromise(() =>
    fetch(feedUrl(base, project))
      .then((response) => response.json())
      .then((data) => GotNotes({ notes: S.decodeUnknownSync(S.Array(NoteSchema))(data) })),
  ).pipe(Effect.catchCause(() => Effect.succeed(Unreachable())))

const postJson = (base: string, path: string, body: unknown) =>
  Effect.tryPromise(() =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )

const settle = (base: string, project: string, path: string, body: unknown) =>
  postJson(base, path, body).pipe(
    Effect.andThen(fetchFeed(base, project)),
    Effect.catchCause(() => Effect.succeed(Unreachable())),
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
  Unreachable,
)(({ base, project }) => fetchFeed(base, project))

const SendChat = Command.define(
  'SendChat',
  { base: S.String, project: S.String, route: S.String, text: S.String },
  GotNotes,
  Unreachable,
)(({ base, project, route, text }) =>
  settle(base, project, '/notes/capture', { kind: 'chat', project, route, text }),
)

const SendAnnotation = Command.define(
  'SendAnnotation',
  { base: S.String, project: S.String, route: S.String, pending: PendingSchema, text: S.String },
  GotNotes,
  Unreachable,
)(({ base, project, route, pending, text }) =>
  settle(base, project, '/notes/capture', { ...pending, project, route, text }),
)

const SendResolve = Command.define(
  'SendResolve',
  { base: S.String, project: S.String, seq: S.Number },
  GotNotes,
  Unreachable,
)(({ base, project, seq }) => settle(base, project, '/notes/resolve', { project, seq }))

const SendDiscard = Command.define(
  'SendDiscard',
  { base: S.String, project: S.String, seq: S.Number },
  GotNotes,
  Unreachable,
)(({ base, project, seq }) => settle(base, project, '/notes/discard', { project, seq }))

const SendEdit = Command.define(
  'SendEdit',
  { base: S.String, project: S.String, seq: S.Number, text: S.String },
  GotNotes,
  Unreachable,
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
    Match.tag('GotNotes', ({ notes }) => [{ ...model, notes, reachable: true }, []]),
    Match.tag('Unreachable', () => [{ ...model, reachable: false }, []]),
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

const kindColor = (note: Note): string =>
  Match.value(note).pipe(
    Match.when({ kind: 'chat' }, () => 'text-cyan'),
    Match.when({ kind: 'dom' }, () => 'text-mint'),
    Match.when({ kind: 'loom' }, () => 'text-violet'),
    Match.exhaustive,
  )

const pointerOf = (note: Note): Option.Option<string> =>
  Match.value(note).pipe(
    Match.withReturnType<Option.Option<string>>(),
    Match.when({ kind: 'dom' }, (annotation) => Option.some(annotation.selector)),
    Match.when({ kind: 'loom' }, (annotation) => Option.some(annotation.source.section)),
    Match.when({ kind: 'chat' }, () => Option.none()),
    Match.exhaustive,
  )

const control = (label: string, message: Message, tone: string): Html =>
  h.button(
    [h.Class(clsx('rounded px-1.5 py-0.5 text-[11px] transition hover:bg-white/5', tone)), h.OnClick(message)],
    [label],
  )

const controls = (note: Note): Html =>
  h.div(
    [h.Class('mt-1.5 flex gap-1 opacity-0 transition group-hover:opacity-100')],
    [
      control('edit', StartedEdit({ seq: note.seq, text: note.text }), 'text-fg-3 hover:text-fg'),
      ...(note.addressed ? [] : [control('resolve', Resolved({ seq: note.seq }), 'text-mint')]),
      control('discard', Discarded({ seq: note.seq }), 'text-fg-3 hover:text-fg'),
    ],
  )

const meta = (note: Note): Html =>
  h.div(
    [h.Class('mb-1 flex items-center gap-2 text-[11px]')],
    [
      h.span([h.Class('text-fg-3')], [`#${note.seq}`]),
      h.span([h.Class(kindColor(note))], [note.kind]),
      ...Option.match(pointerOf(note), {
        onNone: () => [],
        onSome: (pointer) => [h.span([h.Class('truncate text-violet')], [pointer])],
      }),
      h.span([h.Class('ml-auto shrink-0 text-fg-4')], [note.route]),
    ],
  )

const editRow = (editText: string): Html =>
  h.div(
    [h.Class('flex flex-col gap-2 border-b border-white/[0.07] px-3 py-2.5')],
    [
      h.textarea(
        [
          h.Class(
            'w-full resize-none rounded-md border border-white/10 bg-bg px-2.5 py-2 font-sans text-[12.5px] text-fg focus:border-mint focus:outline-none',
          ),
          h.Value(editText),
          h.OnInput((value: string) => EditChanged({ value })),
        ],
        [],
      ),
      h.div(
        [h.Class('flex gap-2')],
        [
          h.button(
            [
              h.Class('rounded-md bg-mint px-2.5 py-1 text-[11px] font-medium text-bg transition hover:brightness-105'),
              h.OnClick(SavedEdit()),
            ],
            ['Save'],
          ),
          h.button(
            [
              h.Class('rounded-md border border-white/10 px-2.5 py-1 text-[11px] text-fg-2 transition hover:text-fg'),
              h.OnClick(CancelledEdit()),
            ],
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
        [h.Class(clsx('group border-b border-white/[0.07] px-3 py-2.5', note.addressed && 'opacity-40'))],
        [
          meta(note),
          h.div([h.Class('font-sans text-[12.5px] leading-relaxed text-fg')], [note.text]),
          controls(note),
        ],
      )

const highlight = (rect: Rect): Html =>
  h.div(
    [
      h.Class('pointer-events-none fixed rounded-md border-2 border-mint bg-mint/10'),
      h.Style({ left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` }),
    ],
    [],
  )

const draftArea = (model: Model, placeholder: string): Html =>
  h.textarea(
    [
      h.Class(
        'h-16 w-full resize-none rounded-md border border-white/10 bg-bg px-2.5 py-2 font-sans text-[12.5px] leading-relaxed text-fg placeholder:text-fg-4 focus:border-mint focus:outline-none',
      ),
      h.Value(model.draft),
      h.Placeholder(placeholder),
      h.OnInput((value: string) => DraftChanged({ value })),
    ],
    [],
  )

const sendButton = (label: string): Html =>
  h.button(
    [
      h.Class('flex-1 rounded-md bg-mint py-2 text-[12px] font-medium text-bg transition hover:brightness-105'),
      h.OnClick(Sent()),
    ],
    [label],
  )

const pickButton = (model: Model): Html =>
  h.button(
    [
      h.Class(
        clsx(
          'flex-1 rounded-md border py-2 text-[12px] transition',
          model.picking
            ? 'border-mint bg-mint/[0.14] text-mint'
            : 'border-white/10 bg-bg-3 text-fg-2 hover:border-white/20 hover:text-fg',
        ),
      ),
      h.OnClick(ToggledPick()),
    ],
    [model.picking ? '◎ Picking…' : '◎ Pick element'],
  )

const composer = (model: Model): Html =>
  h.div(
    [h.Class('border-t border-white/[0.07] p-3')],
    [draftArea(model, 'Leave a note…'), h.div([h.Class('mt-2 flex gap-2')], [pickButton(model), sendButton('Send')])],
  )

const emptyState = (): Html =>
  h.div(
    [h.Class('px-3.5 py-10 text-center font-sans text-[12.5px] leading-relaxed text-fg-3')],
    ['No notes yet. Point at something on the page, or type one below.'],
  )

const noteList = (model: Model): Html =>
  h.div(
    [h.Class('flex flex-1 flex-col overflow-auto')],
    model.notes.length === 0
      ? [emptyState()]
      : Array.map(model.notes, (note) => noteRow(note, model.editing, model.editText)),
  )

const banner = (): Html =>
  h.div(
    [h.Class('border-b border-white/[0.07] bg-amber/[0.08] px-3 py-2.5 font-sans text-[12px] leading-relaxed')],
    [
      h.div([h.Class('text-amber')], ["The notes server isn't running."]),
      h.div(
        [h.Class('mt-0.5 text-fg-3')],
        ['Start it with ', h.span([h.Class('font-mono text-fg')], ['loom start']), '.'],
      ),
    ],
  )

const header = (model: Model): Html =>
  h.div(
    [h.Class('flex items-center gap-2 border-b border-white/[0.07] px-3 py-2.5 text-[13px] text-fg-3')],
    [
      h.span([h.Class('text-fg')], ['Notes']),
      h.span([h.Class('text-fg-4')], [String(model.notes.length)]),
      h.button(
        [
          h.Class(
            'ml-auto flex h-6 w-6 items-center justify-center rounded-md border border-white/10 text-fg-2 transition hover:bg-white/5 hover:text-fg',
          ),
          h.OnClick(Toggled()),
        ],
        ['✕'],
      ),
    ],
  )

const panel = (model: Model): Html =>
  h.div(
    [
      h.Class(
        'pointer-events-auto fixed bottom-[4.5rem] right-4 flex max-h-[min(560px,calc(100vh-6rem))] w-[340px] flex-col overflow-hidden rounded-[10px] border border-white/10 bg-bg-2 font-mono text-[13px] text-fg shadow-[0_18px_50px_rgba(0,0,0,0.45)]',
      ),
    ],
    [header(model), ...(model.reachable ? [] : [banner()]), noteList(model), composer(model)],
  )

const popover = (model: Model, pending: Pending): Html =>
  h.div(
    [
      h.Class(
        'pointer-events-auto fixed bottom-6 left-1/2 w-[340px] max-w-[86vw] -translate-x-1/2 rounded-[10px] border border-mint bg-bg-2 p-3 font-mono text-[13px] text-fg shadow-[0_12px_40px_rgba(0,0,0,0.5)]',
      ),
    ],
    [
      h.div([h.Class('mb-2 flex items-center gap-1.5 truncate text-[11.5px] text-mint')], [`◎ ${pending.label}`]),
      draftArea(model, 'What should this element say or do?'),
      h.div(
        [h.Class('mt-2.5 flex gap-2')],
        [
          h.button(
            [
              h.Class('flex-1 rounded-md border border-white/10 bg-bg-3 py-2 text-[12px] text-fg-2 transition hover:text-fg'),
              h.OnClick(Escaped()),
            ],
            ['Cancel'],
          ),
          sendButton('Add note'),
        ],
      ),
    ],
  )

const launcher = (model: Model): Html => {
  const open = Array.filter(model.notes, (note) => !note.addressed).length
  return h.button(
    [
      h.Class(
        'pointer-events-auto fixed bottom-4 right-4 inline-flex items-center gap-2 rounded-md bg-mint px-3 py-2 font-mono text-[12px] font-medium text-bg shadow-[0_8px_24px_rgba(0,0,0,0.4)] transition hover:brightness-105',
      ),
      h.OnClick(Toggled()),
    ],
    ['✎ Annotate', ...(open === 0 ? [] : [h.span([h.Class('text-bg/60')], [`· ${open}`])])],
  )
}

const view = (model: Model): Html =>
  h.div(
    [h.Class('pointer-events-none fixed inset-0 font-mono')],
    [
      launcher(model),
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
    {
      base,
      project,
      route: location.pathname,
      notes: [],
      reachable: true,
      open: false,
      picking: false,
      draft: '',
      editText: '',
    },
    [FetchNotes({ base, project })],
  ]
}

export const start = (): void => {
  if (document.getElementById(overlayHostId)) return
  run(makeElement({ Model, init, update, view, subscriptions, container: mountPoint() }))
}

start()
