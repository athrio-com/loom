import { Match, Schema as S } from 'effect'
import { html } from '@athrio/foldkit/html'
import type { Html } from '@athrio/foldkit/html'
import { m } from '@athrio/foldkit/message'
import { clsx } from 'clsx'

export const Model = S.Struct({
  open: S.Boolean,
  draft: S.String,
})
export type Model = typeof Model.Type

export const Toggled = m('Toggled')
export const DraftChanged = m('DraftChanged', { value: S.String })
export const Sent = m('Sent')

export const Message = S.Union([Toggled, DraftChanged, Sent])
export type Message = typeof Message.Type

const h = html<Message>()

const update = (model: Model, message: Message): readonly [Model, ReadonlyArray<never>] =>
  Match.value(message).pipe(
    Match.tag('Toggled', () => [{ ...model, open: !model.open }, []] as const),
    Match.tag('DraftChanged', ({ value }) => [{ ...model, draft: value }, []] as const),
    Match.tag('Sent', () => [{ ...model, draft: '' }, []] as const),
    Match.exhaustive,
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
      h.div([h.Class('flex-1 overflow-auto px-3 py-2')], []),
      h.div(
        [h.Class('border-t border-white/10 p-3')],
        [
          h.textarea(
            [
              h.Class(
                'w-full resize-none rounded border border-white/10 bg-slate-950 p-2 text-slate-200',
              ),
              h.Value(model.draft),
              h.OnInput((value: string) => DraftChanged({ value })),
            ],
            [],
          ),
          h.button(
            [
              h.Class(
                'mt-2 w-full rounded bg-emerald-400 py-2 text-slate-900 disabled:opacity-40',
              ),
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

export const start = (): void => {
  if (document.getElementById('loom-notes-overlay')) return
  const application = makeElement({
    Model,
    init: () => [{ open: false, draft: '' }, []] as const,
    update,
    view,
    container: mountPoint(),
  })
  run(application)
}

start()
