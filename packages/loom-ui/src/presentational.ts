import { Array } from 'effect'
import { html, type Html } from 'foldkit/html'

const h = html()

export type Tone = 'accent' | 'success' | 'warning' | 'danger' | 'neutral'

const toneClass = (tone: Tone): string => `loom-tone-${tone}`

export const badge = (props: { label: string; tone?: Tone }): Html =>
  h.span(
    [h.Class(`loom-badge ${toneClass(props.tone ?? 'neutral')}`)],
    [props.label],
  )

export const kbd = (props: { keys: ReadonlyArray<string> }): Html =>
  h.span(
    [h.Class('loom-kbd')],
    Array.map(props.keys, (key) => h.kbd([], [key])),
  )

export const statusDot = (props: { tone?: Tone; label?: string }): Html =>
  h.span(
    [h.Class('loom-status')],
    [
      h.span([h.Class(`loom-status-dot ${toneClass(props.tone ?? 'accent')}`)], []),
      ...(props.label
        ? [h.span([h.Class('loom-status-label')], [props.label])]
        : []),
    ],
  )

export const eyebrow = (props: { label: string }): Html =>
  h.div([h.Class('loom-eyebrow')], [props.label])

export const panel = (props: {
  children: ReadonlyArray<Html>
  title?: string
}): Html =>
  h.div(
    [h.Class('loom-panel')],
    [
      ...(props.title
        ? [h.div([h.Class('loom-panel-title')], [props.title])]
        : []),
      h.div([h.Class('loom-panel-body')], props.children),
    ],
  )

export const link = (props: {
  label: string
  href: string
  primary?: boolean
}): Html =>
  h.a(
    [
      h.Class(props.primary ? 'loom-btn loom-btn-primary' : 'loom-btn'),
      h.Href(props.href),
    ],
    [props.label],
  )
