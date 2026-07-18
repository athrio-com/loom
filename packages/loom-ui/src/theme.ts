import { html, type Html } from 'foldkit/html'

export type Theme = 'light' | 'dark'

export const themeClass = (theme: Theme): string => `loom-theme-${theme}`

export const nextTheme = (theme: Theme): Theme =>
  theme === 'light' ? 'dark' : 'light'

export const themeToggle = <M>(props: { theme: Theme; onToggle: M }): Html => {
  const h = html<M>()
  return h.button(
    [
      h.Class('loom-theme-toggle'),
      h.AriaLabel('Toggle theme'),
      h.OnClick(props.onToggle),
    ],
    [
      h.span(
        [
          h.Class(
            props.theme === 'dark'
              ? 'loom-theme-knob is-dark'
              : 'loom-theme-knob',
          ),
        ],
        [],
      ),
    ],
  )
}
