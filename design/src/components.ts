import { Array } from 'effect'
import type { Html } from 'foldkit/html'
import { Copied, h } from './model'

const strokeIcon = (size: string, paths: ReadonlyArray<Html>): Html =>
  h.svg(
    [
      h.Width(size),
      h.Height(size),
      h.ViewBox('0 0 24 24'),
      h.Fill('none'),
      h.Stroke('currentColor'),
      h.StrokeWidth('2'),
      h.StrokeLinecap('round'),
      h.StrokeLinejoin('round'),
    ],
    paths,
  )

const strokePath = (d: string): Html => h.path([h.D(d)], [])

export const copyIcon = (): Html =>
  strokeIcon('13', [
    h.rect([h.X('9'), h.Y('9'), h.Width('11'), h.Height('11'), h.Rx('2')], []),
    strokePath('M5 15V5a2 2 0 0 1 2-2h10'),
  ])

export const bookIcon = (): Html =>
  h.svg(
    [
      h.Class('arrow'),
      h.Width('14'),
      h.Height('14'),
      h.ViewBox('0 0 24 24'),
      h.Fill('none'),
      h.Stroke('currentColor'),
      h.StrokeWidth('2'),
      h.StrokeLinecap('round'),
      h.StrokeLinejoin('round'),
      h.AriaHidden(true),
    ],
    [
      strokePath('M12 7v14'),
      strokePath(
        'M3 18a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z',
      ),
    ],
  )

export const externalIcon = (): Html =>
  h.svg(
    [
      h.Width('13'),
      h.Height('13'),
      h.ViewBox('0 0 24 24'),
      h.Fill('none'),
      h.Stroke('currentColor'),
      h.StrokeWidth('2'),
      h.StrokeLinecap('round'),
      h.StrokeLinejoin('round'),
      h.AriaHidden(true),
    ],
    [
      strokePath('M15 3h6v6'),
      strokePath('M10 14 21 3'),
      strokePath('M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h6'),
    ],
  )

export const arrowIcon = (): Html =>
  h.svg(
    [
      h.Class('arrow'),
      h.Width('14'),
      h.Height('14'),
      h.ViewBox('0 0 14 14'),
      h.Fill('none'),
      h.AriaHidden(true),
    ],
    [
      h.path(
        [
          h.D('M3 7h8M7 3l4 4-4 4'),
          h.Stroke('currentColor'),
          h.StrokeWidth('1.6'),
          h.StrokeLinecap('round'),
          h.StrokeLinejoin('round'),
        ],
        [],
      ),
    ],
  )

export const copyButton = (props: {
  id: string
  text: string
  copied: string
  label?: string
}): Html => {
  const isCopied = props.copied === props.id
  return h.button(
    [
      h.Class(isCopied ? 'copy-btn copied' : 'copy-btn'),
      h.AriaLabel('Copy'),
      h.OnClick(Copied({ id: props.id, text: props.text })),
    ],
    [
      copyIcon(),
      h.span([h.Class('copy-label')], [isCopied ? 'copied' : props.label ?? 'copy']),
    ],
  )
}

export const titlebar = (): Html =>
  h.div(
    [h.Class('titlebar'), h.Role('banner')],
    [
      h.div(
        [h.Class('traffic')],
        [h.span([], []), h.span([], []), h.span([], [])],
      ),
      h.div(
        [h.Class('crumbs')],
        [
          h.span([], ['loom']),
          h.span([h.Class('sep')], ['/']),
          h.span([], ['greeter']),
          h.span([h.Class('sep')], ['/']),
          h.span([h.Class('file')], ['a-first-loom.loom']),
        ],
      ),
      h.div(
        [h.Class('right')],
        [
          h.span([h.Class('live-dot'), h.Title('tangled')], []),
          h.span([], ['v0.9.0 · literate programming']),
          h.span([], [h.kbd([], ['⌘']), ' ', h.kbd([], ['K'])]),
        ],
      ),
    ],
  )

const NAV = [
  { label: 'landing', href: '#', here: true },
  { label: 'docs', href: '#' },
  { label: 'annotations', href: '#' },
  { label: 'devtools', href: '#' },
]

export const tabbar = (): Html =>
  h.nav(
    [h.Class('tabbar'), h.AriaLabel('Site')],
    Array.map(NAV, (link) =>
      h.a(
        [h.Class(link.here ? 'tab active' : 'tab'), h.Href(link.href)],
        [h.span([h.Class('dot')], []), link.label],
      ),
    ),
  )
