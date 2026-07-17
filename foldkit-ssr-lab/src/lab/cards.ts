import { Array, Option, pipe } from 'effect'
import { Body, type Card } from './model'

type Seed = {
  readonly id: string
  readonly title: string
  readonly strategy: Card['strategy']
  readonly priority: number
  readonly body: string
}

const seeds: ReadonlyArray<Seed> = [
  { id: 'metrics', title: 'Service metrics', strategy: 'native', priority: 0, body: 'uptime 99.98% · p95 142ms · 3.2k req/s' },
  { id: 'profile', title: 'Profile card', strategy: 'native', priority: 0, body: 'Ada Lovelace · staff engineer · joined 2021' },
  { id: 'feed', title: 'Activity feed', strategy: 'streaming', priority: 0, body: '12 new events · deploy #4821 succeeded' },
  { id: 'reco', title: 'Recommendations', strategy: 'streaming', priority: 0, body: '3 picks · loom-lang, foldkit, effect' },
  { id: 'chart', title: 'Heavy chart', strategy: 'client', priority: 1, body: '▁▂▄▆█▆▄▂ eight-week trend, rendered client-side' },
  { id: 'map', title: 'Map widget', strategy: 'client', priority: 2, body: '4 regions · 12 nodes healthy' },
]

export const cards: ReadonlyArray<Seed> = seeds

export const bodyOf = (id: string): string =>
  pipe(
    Array.findFirst(seeds, (seed) => seed.id === id),
    Option.map((seed) => seed.body),
    Option.getOrElse(() => ''),
  )

export const initialCards: ReadonlyArray<Card> = Array.map(seeds, (seed) => ({
  id: seed.id,
  title: seed.title,
  strategy: seed.strategy,
  priority: seed.priority,
  content: seed.strategy === 'native' ? Body.Success({ data: seed.body }) : Body.Loading(),
}))
