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

export const playIcon = (): Html =>
  h.svg(
    [h.Width('12'), h.Height('12'), h.ViewBox('0 0 24 24'), h.Fill('currentColor'), h.AriaHidden(true)],
    [h.path([h.D('M8 5v14l11-7z')], [])],
  )

export const loomIcon = (): Html =>
  h.svg(
    [h.Width('15'), h.Height('15'), h.ViewBox('0 0 100 100'), h.Fill('none'), h.AriaHidden(true)],
    [
      h.g(
        [
          h.Transform('rotate(-13 50 50)'),
          h.Stroke('currentColor'),
          h.StrokeWidth('13'),
          h.StrokeLinecap('round'),
        ],
        [
          strokePath('M18 38C34 36 66 36 82 38'),
          strokePath('M18 62C34 60 66 64 82 62'),
          strokePath('M38 18V54'), strokePath('M38 70V82'),
          strokePath('M62 18V30'), strokePath('M62 46V82'),
        ],
      ),
    ],
  )

const badge = (fill: string, marks: ReadonlyArray<Html>): Html =>
  h.svg(
    [h.Width('18'), h.Height('18'), h.ViewBox('0 0 24 24'), h.AriaHidden(true)],
    [h.rect([h.X('1'), h.Y('1'), h.Width('22'), h.Height('22'), h.Rx('6'), h.Fill(fill)], []), ...marks],
  )

const bar = (x: string, fill: string): Html =>
  h.rect([h.X(x), h.Y('7.5'), h.Width('3.4'), h.Height('9'), h.Fill(fill)], [])

export const npmIcon = (): Html =>
  badge('#CB3837', [
    bar('5.4', '#fff'),
    bar('10.3', '#fff'),
    bar('15.2', '#fff'),
    h.rect([h.X('12.2'), h.Y('10.5'), h.Width('1.5'), h.Height('6'), h.Fill('#CB3837')], []),
    h.rect([h.X('18.6'), h.Y('7.5'), h.Width('1.5'), h.Height('5'), h.Fill('#CB3837')], []),
  ])

export const pnpmIcon = (): Html =>
  h.svg(
    [h.Width('18'), h.Height('18'), h.ViewBox('0 0 24 24'), h.AriaHidden(true)],
    [
      h.rect([h.X('13'), h.Y('2'), h.Width('9'), h.Height('9'), h.Rx('2'), h.Fill('#F9AD00')], []),
      h.rect([h.X('2'), h.Y('13'), h.Width('9'), h.Height('9'), h.Rx('2'), h.Fill('#F9AD00')], []),
      h.rect([h.X('13'), h.Y('13'), h.Width('9'), h.Height('9'), h.Rx('2'), h.Fill('#4A4A4A')], []),
    ],
  )

export const bunIcon = (): Html =>
  h.svg(
    [h.Width('18'), h.Height('18'), h.ViewBox('0 0 24 24'), h.AriaHidden(true)],
    [
      h.rect([h.X('1'), h.Y('1'), h.Width('22'), h.Height('22'), h.Rx('11'), h.Fill('#FBF0DF'), h.Stroke('#E7D9BE'), h.StrokeWidth('1')], []),
      h.rect([h.X('7'), h.Y('10.5'), h.Width('2.6'), h.Height('2.6'), h.Rx('1.3'), h.Fill('#1b1b1b')], []),
      h.rect([h.X('14.4'), h.Y('10.5'), h.Width('2.6'), h.Height('2.6'), h.Rx('1.3'), h.Fill('#1b1b1b')], []),
      h.rect([h.X('5'), h.Y('14'), h.Width('2.2'), h.Height('2.2'), h.Rx('1.1'), h.Fill('#F4B8B8')], []),
      h.rect([h.X('16.8'), h.Y('14'), h.Width('2.2'), h.Height('2.2'), h.Rx('1.1'), h.Fill('#F4B8B8')], []),
      h.path([h.D('M9.3 15.2c1.6 1.6 3.8 1.6 5.4 0'), h.Stroke('#1b1b1b'), h.StrokeWidth('1'), h.Fill('none'), h.StrokeLinecap('round')], []),
    ],
  )

export const denoIcon = (): Html =>
  badge('#111827', [
    h.rect([h.X('6.5'), h.Y('12'), h.Width('9'), h.Height('7'), h.Rx('3.5'), h.Fill('#f4f4f5')], []),
    h.path([h.D('M13 15.5C13 10 14 8 16.5 8'), h.Stroke('#f4f4f5'), h.StrokeWidth('2.6'), h.Fill('none'), h.StrokeLinecap('round')], []),
    h.rect([h.X('14.6'), h.Y('6'), h.Width('3.4'), h.Height('3.4'), h.Rx('1.7'), h.Fill('#f4f4f5')], []),
    h.rect([h.X('16.4'), h.Y('7.1'), h.Width('1'), h.Height('1'), h.Rx('0.5'), h.Fill('#111827')], []),
  ])

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

export const titlebar = (version: string): Html =>
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
          h.span([], [`v${version} · literate programming`]),
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
