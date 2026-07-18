import { html, type Html } from 'foldkit/html'

export const button = <M>(props: {
  label: string
  onClick: M
  primary?: boolean
  disabled?: boolean
}): Html => {
  const h = html<M>()
  return h.button(
    [
      h.Class(props.primary ? 'loom-btn loom-btn-primary' : 'loom-btn'),
      h.OnClick(props.onClick),
      ...(props.disabled ? [h.Disabled(true)] : []),
    ],
    [props.label],
  )
}

export const toggle = <M>(props: {
  label: string
  active: boolean
  onClick: M
}): Html => {
  const h = html<M>()
  return h.button(
    [
      h.Class(props.active ? 'loom-toggle loom-toggle-on' : 'loom-toggle'),
      h.OnClick(props.onClick),
    ],
    [props.label],
  )
}

export const textField = <M>(props: {
  value: string
  onInput: (value: string) => M
  placeholder?: string
}): Html => {
  const h = html<M>()
  return h.input([
    h.Class('loom-field'),
    h.Value(props.value),
    h.OnInput(props.onInput),
    ...(props.placeholder ? [h.Placeholder(props.placeholder)] : []),
  ])
}

export const iconButton = <M>(props: {
  icon: string
  label: string
  onClick: M
}): Html => {
  const h = html<M>()
  return h.button(
    [
      h.Class('loom-icon-btn'),
      h.AriaLabel(props.label),
      h.OnClick(props.onClick),
    ],
    [props.icon],
  )
}
