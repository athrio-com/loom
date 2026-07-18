import { Array } from 'effect'
import { html, type Html } from 'foldkit/html'

const h = html()

export const trafficLights = (): Html =>
  h.span(
    [h.Class('loom-traffic')],
    [
      h.span([h.Class('loom-traffic-dot loom-traffic-close')], []),
      h.span([h.Class('loom-traffic-dot loom-traffic-min')], []),
      h.span([h.Class('loom-traffic-dot loom-traffic-max')], []),
    ],
  )

const crumbsView = (crumbs: ReadonlyArray<string>): ReadonlyArray<Html> =>
  Array.flatMap(crumbs, (crumb, index) => [
    ...(index > 0 ? [h.span([h.Class('loom-crumb-sep')], ['/'])] : []),
    h.span(
      [
        h.Class(
          index === crumbs.length - 1
            ? 'loom-crumb loom-crumb-file'
            : 'loom-crumb',
        ),
      ],
      [crumb],
    ),
  ])

export const titlebar = (props: {
  crumbs: ReadonlyArray<string>
  right?: ReadonlyArray<Html>
}): Html =>
  h.div(
    [h.Class('loom-titlebar')],
    [
      trafficLights(),
      h.div([h.Class('loom-crumbs')], crumbsView(props.crumbs)),
      h.div([h.Class('loom-titlebar-right')], props.right ?? []),
    ],
  )

export const liveDot = (props: { label?: string }): Html =>
  h.span(
    [h.Class('loom-live')],
    [
      h.span([h.Class('loom-live-dot')], []),
      ...(props.label
        ? [h.span([h.Class('loom-live-label')], [props.label])]
        : []),
    ],
  )

export const topNav = (props: {
  links: ReadonlyArray<{ label: string; href: string; here?: boolean }>
}): Html =>
  h.nav(
    [h.Class('loom-topnav')],
    Array.map(props.links, (link) =>
      h.a(
        [
          h.Class(link.here ? 'loom-topnav-link is-here' : 'loom-topnav-link'),
          h.Href(link.href),
        ],
        [link.label],
      ),
    ),
  )

import { type Tone } from './presentational'

export const tabBar = <M>(props: {
  tabs: ReadonlyArray<{ id: string; label: string; tone?: Tone }>
  active: string
  onSelect: (id: string) => M
}): Html => {
  const hm = html<M>()
  return hm.div(
    [hm.Class('loom-tabbar')],
    Array.map(props.tabs, (tab) =>
      hm.button(
        [
          hm.Class(tab.id === props.active ? 'loom-tab is-active' : 'loom-tab'),
          hm.OnClick(props.onSelect(tab.id)),
        ],
        [
          hm.span(
            [hm.Class(`loom-tab-dot loom-tone-${tab.tone ?? 'accent'}`)],
            [],
          ),
          tab.label,
        ],
      ),
    ),
  )
}
