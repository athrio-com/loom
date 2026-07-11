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

export const Message = S.Union([
  Toggled,
  ToggledPick,
  Hovered,
  Picked,
  Escaped,
  DraftChanged,
  Sent,
  GotNotes,
])
export type Message = typeof Message.Type

const h = html<Message>()

const feedUrl = (base: string, project: string): string =>
  `${base}/notes/feed?project=${encodeURIComponent(project)}`

const fetchFeed = (base: string, project: string) =>
  Effect.promise(() => fetch(feedUrl(base, project)).then((response) => response.json())).pipe(
    Effect.map((data) => GotNotes({ notes: S.decodeUnknownSync(S.Array(NoteSchema))(data) })),
  )

const post = (base: string, body: unknown): Effect.Effect<Response> =>
  Effect.promise(() =>
    fetch(`${base}/notes/capture`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )

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
  post(base, { kind: 'chat', project, route, text }).pipe(Effect.andThen(fetchFeed(base, project))),
)

const SendAnnotation = Command.define(
  'SendAnnotation',
  { base: S.String, project: S.String, route: S.String, pending: PendingSchema, text: S.String },
  GotNotes,
)(({ base, project, route, pending, text }) =>
  post(base, { ...pending, project, route, text }).pipe(Effect.andThen(fetchFeed(base, project))),
)

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

const highlight = (rect: Rect): Html =>
  h.div(
    [
      h.Class('pointer-events-none fixed border-2 border-emerald-400 bg-emerald-400/10'),
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
          h.Class('w-full resize-none rounded border border-white/10 bg-slate-950 p-2 text-slate-200'),
          h.Value(model.draft),
          h.OnInput((value: string) => DraftChanged({ value })),
        ],
        [],
      ),
      h.button(
        [h.Class('mt-2 w-full rounded bg-emerald-400 py-2 text-slate-900 disabled:opacity-40'), h.OnClick(Sent())],
        [label],
      ),
      action,
    ],
  )

const pickButton = (model: Model): Html =>
  h.button(
    [
      h.Class(clsx('mt-2 w-full rounded border border-white/10 py-2 text-slate-300', model.picking && 'border-emerald-400 text-emerald-400')),
      h.OnClick(ToggledPick()),
    ],
    ['◎ Pick an element'],
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
      composer(model, pickButton(model), 'Send'),
    ],
  )

const popover = (model: Model, pending: Pending): Html =>
  h.div(
    [
      h.Class(
        'pointer-events-auto fixed bottom-6 left-1/2 w-96 max-w-[86vw] -translate-x-1/2 rounded-lg border border-emerald-400 bg-slate-900 p-3 font-mono text-sm text-slate-200 shadow-xl',
      ),
    ],
    [
      h.div([h.Class('mb-2 truncate text-xs text-emerald-400')], [`◎ ${pending.label}`]),
      composer(model, h.div([], []), 'Add'),
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

const view = (model: Model): Html =>
  h.div(
    [h.Class('pointer-events-none fixed inset-0')],
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
    { base, project, route: location.pathname, notes: [], open: false, picking: false, draft: '' },
    [FetchNotes({ base, project })],
  ]
}

export const start = (): void => {
  if (document.getElementById(overlayHostId)) return
  run(makeElement({ Model, init, update, view, subscriptions, container: mountPoint() }))
}

start()
