import { Array, Effect, Match, Option, Queue, Schema as S, Stream } from 'effect'
import { Command, Subscription } from 'foldkit'
import { html } from 'foldkit/html'
import type { Html, KeyboardModifiers } from 'foldkit/html'
import { m } from 'foldkit/message'
import { clsx } from 'clsx'
import { LoomSourceSchema, NoteSchema, RectSchema, type Note, type Rect } from './note'

const PendingSchema = S.Union([
  S.Struct({ kind: S.tag('dom'), selector: S.String, label: S.String, rect: RectSchema }),
  S.Struct({ kind: S.tag('loom'), source: LoomSourceSchema, label: S.String, rect: RectSchema }),
])
type Pending = typeof PendingSchema.Type

const HoverSchema = S.Struct({ rect: RectSchema, tag: S.String })
type Hover = typeof HoverSchema.Type

const TabSchema = S.Literals(['open', 'resolved'])
type Tab = typeof TabSchema.Type

export const Model = S.Struct({
  base: S.String,
  project: S.String,
  route: S.String,
  notes: S.Array(NoteSchema),
  reachable: S.Boolean,
  tab: TabSchema,
  open: S.Boolean,
  collapsed: S.Boolean,
  atBottom: S.Boolean,
  pendingScroll: S.Boolean,
  picking: S.Boolean,
  hover: S.optional(HoverSchema),
  pending: S.optional(PendingSchema),
  draft: S.String,
  editing: S.optional(S.Number),
  editText: S.String,
})
export type Model = typeof Model.Type

export const Toggled = m('Toggled')
export const ToggledPick = m('ToggledPick')
export const ToggledCollapse = m('ToggledCollapse')
export const Hovered = m('Hovered', { hover: HoverSchema })
export const Picked = m('Picked', { pending: PendingSchema })
export const Escaped = m('Escaped')
export const DraftChanged = m('DraftChanged', { value: S.String })
export const Sent = m('Sent')
export const GotNotes = m('GotNotes', { notes: S.Array(NoteSchema) })
export const Unreachable = m('Unreachable')
export const AtBottom = m('AtBottom', { at: S.Boolean })
export const JumpToBottom = m('JumpToBottom')
export const Scrolled = m('Scrolled')
export const SelectedTab = m('SelectedTab', { tab: TabSchema })
export const Resolved = m('Resolved', { seq: S.Number })
export const Discarded = m('Discarded', { seq: S.Number })
export const StartedEdit = m('StartedEdit', { seq: S.Number, text: S.String })
export const EditChanged = m('EditChanged', { value: S.String })
export const SavedEdit = m('SavedEdit')
export const CancelledEdit = m('CancelledEdit')

export const Message = S.Union([
  Toggled,
  ToggledPick,
  ToggledCollapse,
  Hovered,
  Picked,
  Escaped,
  DraftChanged,
  Sent,
  GotNotes,
  Unreachable,
  AtBottom,
  JumpToBottom,
  Scrolled,
  SelectedTab,
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

const tagFor = (el: Element): string =>
  Option.match(Option.fromNullishOr(el.closest('[data-loom-chapter][data-loom-section]')), {
    onSome: (loom) => loom.getAttribute('data-loom-section') ?? '',
    onNone: () => selectorFor(el),
  })

const overlayHostId = 'loom-notes-overlay'
const notesListId = 'loom-notes-list'

const hostElement = (target: EventTarget | null): Option.Option<Element> =>
  target instanceof Element && target.id !== overlayHostId ? Option.some(target) : Option.none()

const isEditable = (el: Element | null): boolean =>
  el instanceof HTMLInputElement ||
  el instanceof HTMLTextAreaElement ||
  (el instanceof HTMLElement && el.isContentEditable)

const isTyping = (): boolean =>
  isEditable(document.activeElement) ||
  isEditable(document.getElementById(overlayHostId)?.shadowRoot?.activeElement ?? null)

const shortcut = (event: KeyboardEvent): Option.Option<Message> =>
  isTyping() || !event.altKey || event.ctrlKey || event.metaKey
    ? Option.none()
    : Match.value(event.code).pipe(
        Match.withReturnType<Option.Option<Message>>(),
        Match.when('KeyA', () => Option.some(ToggledPick())),
        Match.when('KeyN', () => Option.some(Toggled())),
        Match.when('KeyB', () => Option.some(ToggledCollapse())),
        Match.orElse(() => Option.none()),
      )

const cursorLock: Stream.Stream<Message> = Stream.scoped(
  Stream.fromEffect(
    Effect.acquireRelease(
      Effect.sync(() => {
        const style = document.createElement('style')
        style.textContent = '*, *::before, *::after { cursor: crosshair !important }'
        document.head.appendChild(style)
        return style
      }),
      (style) => Effect.sync(() => style.remove()),
    ),
  ),
).pipe(Stream.flatMap(() => Stream.never))

const noteListElement = (): Element | null =>
  document.getElementById(overlayHostId)?.shadowRoot?.querySelector(`#${notesListId}`) ?? null

const ScrollNotes = Command.define('ScrollNotes', Scrolled)(
  Effect.sync(() => {
    requestAnimationFrame(() => {
      const list = noteListElement()
      if (list !== null) list.scrollTop = list.scrollHeight
    })
    return Scrolled()
  }),
)

const nearBottom = (list: Element): boolean =>
  list.scrollHeight - list.scrollTop - list.clientHeight < 40

const bottomStream: Stream.Stream<Message> = Stream.callback<Message>((queue) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const watch: { list: Element | null; onScroll: (() => void) | null; live: boolean } = {
        list: null,
        onScroll: null,
        live: true,
      }
      const attach = (): void => {
        if (!watch.live) return
        const list = noteListElement()
        if (list === null) {
          requestAnimationFrame(attach)
          return
        }
        const onScroll = (): void => {
          Queue.offerUnsafe(queue, AtBottom({ at: nearBottom(list) }))
        }
        list.addEventListener('scroll', onScroll, { passive: true })
        watch.list = list
        watch.onScroll = onScroll
        onScroll()
      }
      attach()
      return watch
    }),
    (watch) =>
      Effect.sync(() => {
        watch.live = false
        if (watch.list !== null && watch.onScroll !== null) {
          watch.list.removeEventListener('scroll', watch.onScroll)
        }
      }),
  ).pipe(Effect.flatMap(() => Effect.never)),
)

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
                Option.map(hostElement(event.target), (el) =>
                  Hovered({ hover: { rect: rectOf(el), tag: tagFor(el) } }),
                ),
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
  pickCursor: entry(
    { picking: S.Boolean },
    {
      modelToDependencies: (model) => ({ picking: model.picking }),
      dependenciesToStream: ({ picking }) => (picking ? cursorLock : Stream.empty),
    },
  ),
  bottomWatch: entry(
    { open: S.Boolean },
    {
      modelToDependencies: (model) => ({ open: model.open }),
      dependenciesToStream: ({ open }) => (open ? bottomStream : Stream.empty),
    },
  ),
  escapeKey: entry(
    { active: S.Boolean },
    {
      modelToDependencies: (model) => ({ active: model.picking || model.pending !== undefined }),
      dependenciesToStream: ({ active }) =>
        active
          ? Subscription.fromEventFilterMap<KeyboardEvent, Message>({
              target: document,
              type: 'keydown',
              options: { capture: true },
              toMessage: (event) => (event.key === 'Escape' ? Option.some(Escaped()) : Option.none()),
            })
          : Stream.empty,
    },
  ),
  shortcuts: entry(
    { project: S.String },
    {
      modelToDependencies: (model) => ({ project: model.project }),
      dependenciesToStream: () =>
        Subscription.fromEventFilterMap<KeyboardEvent, Message>({
          target: document,
          type: 'keydown',
          options: { capture: true },
          toMessage: (event) => {
            const message = shortcut(event)
            if (Option.isSome(message)) event.preventDefault()
            return message
          },
        }),
    },
  ),
}))

const sent = (model: Model): readonly [Model, ReadonlyArray<Command.Command<Message>>] =>
  model.pending === undefined
    ? [
        { ...model, draft: '', pendingScroll: true },
        [SendChat({ base: model.base, project: model.project, route: model.route, text: model.draft })],
      ]
    : [
        { ...model, draft: '', pending: undefined, pendingScroll: true },
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
    Match.tagsExhaustive({
      Toggled: () =>
        model.open
          ? [{ ...model, open: false }, []]
          : [
              { ...model, open: true, collapsed: false, pendingScroll: true },
              [FetchNotes({ base: model.base, project: model.project }), ScrollNotes()],
            ],
      ToggledPick: () => [
        { ...model, picking: !model.picking, open: false, collapsed: false },
        [],
      ],
      ToggledCollapse: () => [
        { ...model, collapsed: !model.collapsed, open: false, picking: false },
        [],
      ],
      Hovered: ({ hover }) => [{ ...model, hover }, []],
      Picked: ({ pending }) => [
        { ...model, picking: false, pending, hover: undefined, open: true },
        [],
      ],
      Escaped: () => [
        { ...model, picking: false, pending: undefined, hover: undefined },
        [],
      ],
      DraftChanged: ({ value }) => [{ ...model, draft: value }, []],
      Sent: () => (model.draft.trim() === '' ? [model, []] : sent(model)),
      GotNotes: ({ notes }) =>
        model.pendingScroll
          ? [{ ...model, notes, reachable: true, pendingScroll: false, atBottom: true }, [ScrollNotes()]]
          : [{ ...model, notes, reachable: true }, []],
      Unreachable: () => [{ ...model, reachable: false }, []],
      AtBottom: ({ at }) => [{ ...model, atBottom: at }, []],
      JumpToBottom: () => [{ ...model, atBottom: true }, [ScrollNotes()]],
      Scrolled: () => [model, []],
      SelectedTab: ({ tab }) => [{ ...model, tab }, []],
      Resolved: ({ seq }) => [
        model,
        [SendResolve({ base: model.base, project: model.project, seq })],
      ],
      Discarded: ({ seq }) => [
        model,
        [SendDiscard({ base: model.base, project: model.project, seq })],
      ],
      StartedEdit: ({ seq, text }) => [{ ...model, editing: seq, editText: text }, []],
      EditChanged: ({ value }) => [{ ...model, editText: value }, []],
      SavedEdit: () => saved(model),
      CancelledEdit: () => [{ ...model, editing: undefined }, []],
    }),
  )

const crosshairIcon =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8"/><line x1="12" x2="12" y1="2" y2="5"/><line x1="12" x2="12" y1="19" y2="22"/><line x1="2" x2="5" y1="12" y2="12"/><line x1="19" x2="22" y1="12" y2="12"/></svg>'

const messageIcon =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>'

const chevronDownIcon =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>'

const chevronUpIcon =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>'

const icon = (svg: string, tone: string): Html =>
  h.span([h.Class(clsx('block h-[15px] w-[15px] shrink-0', tone)), h.InnerHTML(svg)], [])

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
    [
      h.Class(clsx('cursor-pointer rounded px-1.5 py-0.5 text-[11px] transition hover:bg-white/5', tone)),
      h.OnClick(message),
    ],
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
    [h.Class('flex flex-col gap-2 px-3 py-2.5')],
    [
      h.textarea(
        [
          h.Class(
            'w-full resize-none rounded-md border border-white/[0.12] bg-bg px-2.5 py-2 font-sans text-[12.5px] text-fg focus:border-mint focus:outline-none',
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
              h.Class(
                'cursor-pointer rounded-md bg-mint px-2.5 py-1 text-[11px] font-medium text-bg transition hover:brightness-105',
              ),
              h.OnClick(SavedEdit()),
            ],
            ['Save'],
          ),
          h.button(
            [
              h.Class(
                'cursor-pointer rounded-md border border-white/[0.12] px-2.5 py-1 text-[11px] text-fg-2 transition hover:text-fg',
              ),
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
        [h.Class('group px-3 py-2.5')],
        [
          meta(note),
          h.div([h.Class('font-sans text-[12.5px] leading-relaxed text-fg')], [note.text]),
          controls(note),
        ],
      )

const openCount = (notes: ReadonlyArray<Note>): number =>
  Array.filter(notes, (note) => !note.addressed).length

const nameField = (model: Model): Html =>
  h.span([h.Class('whitespace-nowrap text-fg')], [model.project])

const pickControl = (model: Model): Html =>
  h.button(
    [
      h.Class(
        clsx(
          'inline-flex h-full cursor-pointer items-center px-3 text-mint transition hover:bg-bg-3',
          model.picking && 'bg-mint/[0.16]',
        ),
      ),
      h.OnClick(ToggledPick()),
      h.Title(model.picking ? 'Picking… (escape to cancel)' : 'Pick an element (Alt+A)'),
    ],
    [icon(crosshairIcon, '')],
  )

const notesControl = (model: Model): Html => {
  const open = openCount(model.notes)
  return h.button(
    [
      h.Class(
        clsx(
          'inline-flex h-full cursor-pointer items-center gap-1.5 px-3 transition hover:bg-bg-3 hover:text-fg',
          model.open ? 'text-fg' : 'text-fg-3',
        ),
      ),
      h.OnClick(Toggled()),
      h.Title('Notes (Alt+N)'),
    ],
    [icon(messageIcon, ''), ...(open === 0 ? [] : [h.span([h.Class('text-mint')], [String(open)])])],
  )
}

const collapseControl = (): Html =>
  h.button(
    [
      h.Class(
        'inline-flex h-full cursor-pointer items-center px-3 text-fg-2 transition hover:bg-bg-3 hover:text-fg',
      ),
      h.OnClick(ToggledCollapse()),
      h.Title('Hide the bar (Alt+B)'),
    ],
    [icon(chevronDownIcon, '')],
  )

const bar = (model: Model): Html =>
  h.div(
    [
      h.Class(
        'pointer-events-auto fixed inset-x-0 bottom-0 flex h-8 items-center gap-2 border-t border-white/[0.12] bg-bg-2 pl-4 pr-3 text-[12px] text-fg-2',
      ),
    ],
    [
      h.div(
        [h.Class('flex items-center gap-4')],
        [nameField(model)],
      ),
      h.div([h.Class('flex-1')], []),
      pickControl(model),
      notesControl(model),
      collapseControl(),
    ],
  )

const handle = (model: Model): Html => {
  const open = openCount(model.notes)
  return h.button(
    [
      h.Class(
        'pointer-events-auto fixed bottom-0 right-6 inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-t-md border-l border-r border-t border-white/[0.12] bg-bg-2 px-3 text-[12px] text-fg-2 transition hover:bg-bg-3 hover:text-fg',
      ),
      h.OnClick(ToggledCollapse()),
      h.Title('Show the bar (Alt+B)'),
    ],
    [icon(chevronUpIcon, 'text-mint'), ...(open === 0 ? [] : [h.span([h.Class('text-mint')], [String(open)])])],
  )
}

const composerKey =
  (draft: string) =>
  (key: string, mods: KeyboardModifiers): Option.Option<Message> => {
    if (key !== 'Enter') return Option.none()
    if (mods.ctrlKey || mods.metaKey) return Option.some(DraftChanged({ value: `${draft}\n` }))
    if (mods.shiftKey) return Option.none()
    return Option.some(Sent())
  }

const highlight = (hover: Hover): Html =>
  h.div(
    [
      h.Class('pointer-events-none fixed rounded-lg border-2 border-mint bg-mint/[0.09]'),
      h.Style({
        left: `${hover.rect.x}px`,
        top: `${hover.rect.y}px`,
        width: `${hover.rect.width}px`,
        height: `${hover.rect.height}px`,
      }),
    ],
    [
      h.span(
        [
          h.Class(
            'absolute -top-[22px] -left-0.5 whitespace-nowrap rounded bg-mint px-1.5 py-px font-mono text-[11px] text-bg',
          ),
        ],
        [hover.tag],
      ),
    ],
  )

const draftArea = (model: Model, placeholder: string): Html =>
  h.textarea(
    [
      h.Class(
        'h-16 w-full resize-none rounded-md border border-white/[0.12] bg-bg px-2.5 py-2 font-sans text-[12.5px] leading-relaxed text-fg placeholder:text-fg-4 focus:border-mint focus:outline-none',
      ),
      h.Value(model.draft),
      h.Placeholder(placeholder),
      h.OnInput((value: string) => DraftChanged({ value })),
      h.OnKeyDownPreventDefault(composerKey(model.draft)),
    ],
    [],
  )

const sendButton = (label: string): Html =>
  h.button(
    [
      h.Class(
        'flex-1 cursor-pointer rounded-md bg-mint py-2 text-[12px] font-medium text-bg transition hover:brightness-105',
      ),
      h.OnClick(Sent()),
    ],
    [label],
  )

const pickButton = (model: Model): Html =>
  h.button(
    [
      h.Class(
        clsx(
          'flex-1 cursor-pointer rounded-md border py-2 text-[12px] transition',
          model.picking
            ? 'border-mint bg-mint/[0.14] text-mint'
            : 'border-white/[0.12] bg-bg-3 text-fg-2 hover:border-white/20 hover:text-fg',
        ),
      ),
      h.OnClick(ToggledPick()),
    ],
    [model.picking ? '◎ Picking…' : '◎ Pick element'],
  )

const scrollDown = (): Html =>
  h.button(
    [
      h.Class(
        'absolute -top-12 right-2 inline-flex h-9 w-9 cursor-pointer items-center justify-center rounded-full border border-white/[0.12] bg-bg-3 text-fg-2 shadow-[0_6px_20px_rgba(0,0,0,0.5)] transition hover:text-fg',
      ),
      h.OnClick(JumpToBottom()),
      h.Title('Jump to the latest'),
    ],
    [icon(chevronDownIcon, '')],
  )

const composer = (model: Model): Html =>
  h.div(
    [h.Class('relative border-t border-white/[0.07] p-3')],
    [
      ...(model.atBottom ? [] : [scrollDown()]),
      draftArea(model, 'Leave a note…'),
      h.div([h.Class('mt-2 flex gap-2')], [pickButton(model), sendButton('Send')]),
    ],
  )

const visibleNotes = (model: Model): ReadonlyArray<Note> =>
  Array.filter(model.notes, (note) => (model.tab === 'resolved' ? note.addressed : !note.addressed))

const emptyState = (model: Model): Html =>
  h.div(
    [h.Class('px-3.5 py-10 text-center font-sans text-[12.5px] leading-relaxed text-fg-3')],
    [
      model.tab === 'resolved'
        ? 'No resolved notes yet.'
        : 'No open notes. Point at something on the page, or type one below.',
    ],
  )

const noteList = (model: Model): Html => {
  const notes = visibleNotes(model)
  return h.div(
    [h.Id(notesListId), h.Class('flex min-h-0 flex-1 flex-col divide-y divide-white/[0.07] overflow-auto')],
    notes.length === 0
      ? [emptyState(model)]
      : Array.map(notes, (note) => noteRow(note, model.editing, model.editText)),
  )
}

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

const tabButton = (label: string, value: Tab, active: boolean): Html =>
  h.button(
    [
      h.Class(
        clsx(
          'cursor-pointer border-b-2 pb-1 text-[12px] transition',
          active ? 'border-mint text-fg' : 'border-transparent text-fg-3 hover:text-fg',
        ),
      ),
      h.OnClick(SelectedTab({ tab: value })),
    ],
    [label],
  )

const header = (model: Model): Html =>
  h.div(
    [h.Class('flex items-center gap-4 border-b border-white/[0.07] px-3 py-2.5 text-[13px]')],
    [
      tabButton('Open', 'open', model.tab === 'open'),
      tabButton('Resolved', 'resolved', model.tab === 'resolved'),
      h.button(
        [
          h.Class(
            'ml-auto flex h-6 w-6 cursor-pointer items-center justify-center rounded-md border border-white/[0.12] text-fg-2 transition hover:bg-white/5 hover:text-fg',
          ),
          h.OnClick(Toggled()),
          h.Title('Close (Alt+N)'),
        ],
        ['✕'],
      ),
    ],
  )

const panel = (model: Model): Html =>
  h.div(
    [
      h.Class(
        'pointer-events-auto fixed bottom-10 right-4 flex max-h-[80vh] w-[360px] flex-col overflow-hidden rounded-[10px] border border-white/[0.12] bg-bg-2 font-mono text-[13px] text-fg shadow-[0_18px_50px_rgba(0,0,0,0.45)]',
      ),
    ],
    [header(model), ...(model.reachable ? [] : [banner()]), noteList(model), composer(model)],
  )

const popover = (model: Model, pending: Pending): Html =>
  h.div(
    [
      h.Class(
        'pointer-events-auto fixed bottom-12 left-1/2 w-[340px] max-w-[86vw] -translate-x-1/2 rounded-[10px] border border-mint bg-bg-2 p-3 font-mono text-[13px] text-fg shadow-[0_12px_40px_rgba(0,0,0,0.5)]',
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
              h.Class(
                'flex-1 cursor-pointer rounded-md border border-white/[0.12] bg-bg-3 py-2 text-[12px] text-fg-2 transition hover:text-fg',
              ),
              h.OnClick(Escaped()),
            ],
            ['Cancel'],
          ),
          sendButton('Add note'),
        ],
      ),
    ],
  )

const view = (model: Model): Html => {
  const pointing = model.picking || model.pending !== undefined
  return h.div(
    [h.Class('pointer-events-none fixed inset-0 font-mono')],
    [
      ...(pointing ? [] : model.collapsed ? [handle(model)] : [bar(model)]),
      ...(model.open && model.pending === undefined ? [panel(model)] : []),
      ...(model.picking && model.hover !== undefined ? [highlight(model.hover)] : []),
      ...(model.pending !== undefined ? [popover(model, model.pending)] : []),
    ],
  )
}

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

import { makeElement, run } from 'foldkit/runtime'

const init = (): readonly [Model, ReadonlyArray<Command.Command<Message>>] => {
  const { base, project } = config()
  return [
    {
      base,
      project,
      route: location.pathname,
      notes: [],
      reachable: true,
      tab: 'open',
      open: false,
      collapsed: false,
      atBottom: true,
      pendingScroll: false,
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
