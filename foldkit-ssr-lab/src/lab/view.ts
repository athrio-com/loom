import { Array } from 'effect'
import { type Document, type Html } from '@athrio/foldkit/html'
import { BOUNDARY_ATTRIBUTE } from '@athrio/foldkit-hydration'
import * as AsyncData from '@athrio/foldkit/asyncData'
import { h, type Card, type LogEntry, type Model } from './model'

export const loadedBody = (body: string): Html => h.div([h.Key('bd'), h.Class('body')], [body])

const skeleton = (): Html => h.div([h.Key('sk'), h.Class('skeleton')], [])

const bodyNode = (card: Card): Html =>
  AsyncData.match(card.content, {
    onIdle: skeleton,
    onLoading: skeleton,
    onRefreshing: loadedBody,
    onFailure: () => loadedBody('—'),
    onStale: ({ data }) => loadedBody(data),
    onSuccess: loadedBody,
  })

const region = (card: Card): Html =>
  h.div(
    card.strategy === 'streaming'
      ? [h.Class('region'), h.Attribute(BOUNDARY_ATTRIBUTE, card.id)]
      : [h.Class('region')],
    [bodyNode(card)],
  )

const cardView = (card: Card): Html =>
  h.div(
    [
      h.Key(card.id),
      h.Class(`card ${card.strategy}`),
      h.Attribute('data-card', card.id),
      h.Attribute('data-strategy', card.strategy),
    ],
    [
      h.div(
        [h.Class('card-head')],
        [h.span([h.Class('tag')], [card.strategy]), h.span([h.Class('title')], [card.title])],
      ),
      region(card),
    ],
  )

const logRow = (entry: LogEntry): Html =>
  h.li(
    [h.Class(`entry ${entry.strategy}`)],
    [h.span([h.Class('at')], [`${entry.at}ms`]), h.span([h.Class('label')], [entry.label])],
  )

export const view = (model: Model): Document => ({
  title: 'SSR strategies — a comparison lab',
  body: h.div(
    [h.Id('app'), h.Class('lab')],
    [
      h.header(
        [h.Class('bar')],
        [
          h.h1([], ['SSR fill strategies']),
          h.p(
            [h.Class('legend')],
            [
              h.span([h.Class('key native')], ['native — in the shell']),
              h.span([h.Class('key streaming')], ['streaming — server-pushed']),
              h.span([h.Class('key client')], ['client — fetched by priority']),
            ],
          ),
        ],
      ),
      h.div(
        [h.Class('split')],
        [
          h.section([h.Id('cards'), h.Class('cards')], Array.map(model.cards, cardView)),
          h.section(
            [h.Class('log')],
            [
              h.h2([], ['DOM changes, as they happen']),
              h.ol([h.Class('entries')], Array.map(model.log, logRow)),
            ],
          ),
        ],
      ),
    ],
  ),
})
