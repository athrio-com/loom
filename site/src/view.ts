import { Match } from 'effect'
import type { Document, Html, HtmlBuilder } from 'foldkit/html'
import { docsBar, footer, nav, pager, palette } from './chrome'
import { example } from './example'
import { documentationPage } from './docs-page'
import { hero } from './hero'
import { fromInitToEject } from './operations'
import { vocabulary } from './vocabulary'
import { whyLoom } from './why-loom'
import { community } from './community'
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

const documentation = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.div(
    [],
    [
      docsBar(model, h),
      h.main([], [documentationPage(model, h)]),
      footer(h),
      ...overlay(model, h),
    ],
  )

const beingWritten = (title: string, line: string, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('section')],
    [
      h.div(
        [h.Class('section-head')],
        [
          h.div(
            [h.Class('lines')],
            [
              h.span([h.Class('eyebrow')], ['Being written']),
              h.h2([], [title]),
            ],
          ),
        ],
      ),
      h.p([h.Class('prose')], [line]),
    ],
  )

const pageFor = (model: Model, h: HtmlBuilder<Message>): Html =>
  Match.value(model.route).pipe(
    Match.when('home', () =>
      marketingPage(
        model,
        [hero(model, h), example(model, h), vocabulary(), fromInitToEject(model, h)],
        h,
      ),
    ),
    Match.when('docs', () => documentation(model, h)),
    Match.when('why-loom', () => marketingPage(model, whyLoom(), h)),
    Match.when('community', () => marketingPage(model, community(), h)),
    Match.when('source', () =>
      marketingPage(model, [
        beingWritten(
          'Source',
          'Loom’s own book, read the way Loom renders one. It weaves to more than a megabyte, so this page fetches a chapter at a time rather than shipping the whole corpus to the browser.',
          h,
        ),
      ], h),
    ),
    Match.exhaustive,
  )

const titleOf = (route: Route): string =>
  Match.value(route).pipe(
    Match.when('home', () => 'Loom — literate programming for AI-assisted engineering'),
    Match.when('docs', () => 'Docs — Loom'),
    Match.when('why-loom', () => 'Why Loom'),
    Match.when('community', () => 'Community — Loom'),
    Match.when('source', () => 'Source — Loom'),
    Match.exhaustive,
  )

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: titleOf(model.route),
  body: pageFor(model, h),
})
