import { Array } from 'effect'
import { type Html, inertHtml as ih } from 'foldkit/html'
import { type Carpet, carpetStyle, fineSeam, loomMark } from './components'

const NAVY = '#14204A'

export const pixels = (carpet: Carpet, className: string): Html =>
  ih.span(
    [ih.AriaHidden(true), ih.Class(className), ih.Style(carpetStyle(carpet, fineSeam))],
    [],
  )

type Place = {
  readonly name: string
  readonly action: string
  readonly href: string
  readonly emblem: Carpet
  readonly key: 'github' | 'telegram'
}

const places: ReadonlyArray<Place> = [
  {
    name: 'GitHub',
    action: 'Star the repo',
    href: 'https://github.com/athrio-com/loom',
    key: 'github',
    emblem: {
      rows: ['...a...', '..aaa..', 'aaaaaaa', '.aaaaa.', '..aaa..', '.aa.aa.', '.a...a.'],
      threads: { '.': NAVY, a: '#FFC53D' },
    },
  },
  {
    name: 'Telegram',
    action: 'Join community',
    href: 'https://t.me/athrio',
    key: 'telegram',
    emblem: {
      rows: ['.bbbbb.', 'bbbbbbb', 'bbbbbpb', 'bppppbb', 'bbbpbbb', 'bbbbbbb', '.bbbbb.'],
      threads: { '.': NAVY, b: '#2E6FF2', p: '#F2EFE6' },
    },
  },
]

const placeCard = (place: Place): Html =>
  ih.a(
    [ih.Class(`place-card ${place.key}`), ih.Href(place.href)],
    [
      pixels(place.emblem, 'place-emblem'),
      ih.span(
        [ih.Class('place-lines')],
        [
          ih.span([ih.Class('eyebrow')], [place.name]),
          ih.span([ih.Class('place-title')], [place.action]),
        ],
      ),
    ],
  )

export const pageHead = (id: string, title: string, lead: string): Html =>
  ih.div(
    [ih.Class('section section-hero page-hero'), ih.Id(id)],
    [
      ih.div([ih.Class('page-title')], [loomMark('paper', 0.8), ih.h1([], [title])]),
      ih.div(
        [ih.Class('page-head-grid')],
        [
          ih.p([ih.Class('prose page-lead')], [lead]),
          ih.div([ih.Class('page-places')], Array.map(places, placeCard)),
        ],
      ),
    ],
  )
