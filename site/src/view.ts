import { Match } from 'effect'
import type { Document, Html, HtmlBuilder } from 'foldkit/html'
import { footer, nav, pager, palette } from './chrome'
import { example } from './example'
import { documentationPage, sourcePage } from './docs-page'
import { hero } from './hero'
import { fromInitToEject } from './operations'
import { vocabulary } from './vocabulary'
import { whyLoom } from './why-loom'
import { community } from './community'
import { license } from './license'
import { type Message, type Model, type Route } from './model'

const overlay = (model: Model, h: HtmlBuilder<Message>): ReadonlyArray<Html> =>
  model.searchOpen ? [palette(model, h)] : []

const marketingPage = (
  model: Model,
  sections: ReadonlyArray<Html>,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [],
    [
      nav(model, h),
      h.main([], [...sections, pager(model.route, h)]),
      footer(h),
      ...overlay(model, h),
    ],
  )

const woven = (model: Model, page: Html, h: HtmlBuilder<Message>): Html =>
  h.div([], [nav(model, h), h.main([], [page]), footer(h), ...overlay(model, h)])

const pageFor = Match.fn((model: Model, _h: HtmlBuilder<Message>) => model.route).pipe(
  Match.withReturnType<Html>(),
  Match.when('home', (_route, model, h) =>
    marketingPage(
      model,
      [hero(model, h), example(model, h), vocabulary(), fromInitToEject(model, h)],
      h,
    ),
  ),
  Match.when('docs', (_route, model, h) => woven(model, documentationPage(model, h), h)),
  Match.when('why-loom', (_route, model, h) => marketingPage(model, whyLoom(), h)),
  Match.when('community', (_route, model, h) => marketingPage(model, community(), h)),
  Match.when('license', (_route, model, h) => marketingPage(model, license(), h)),
  Match.when('source', (_route, model, h) => woven(model, sourcePage(model, h), h)),
  Match.exhaustive,
)

const titleOf: (route: Route) => string = Match.type<Route>().pipe(
  Match.when('home', () => 'Loom — literate programming framework'),
  Match.when('docs', () => 'Docs — Loom'),
  Match.when('why-loom', () => 'Why Loom'),
  Match.when('community', () => 'Community — Loom'),
  Match.when('source', () => 'Source — Loom'),
  Match.when('license', () => 'License — Loom'),
  Match.exhaustive,
)

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: titleOf(model.route),
  body: pageFor(model, h),
})
