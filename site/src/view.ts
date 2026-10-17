import { Match } from 'effect'
import type { Document, Html } from 'foldkit/html'
import { docsBar, footer, nav, pager, palette } from './chrome'
import { example } from './example'
import { documentationPage } from './docs-page'
import { hero } from './hero'
import { fromInitToEject } from './operations'
import { vocabulary } from './vocabulary'
import { h, type Model, type Route } from './model'

const overlay = (model: Model): ReadonlyArray<Html> =>
  model.searchOpen ? [palette(model)] : []

const marketingPage = (model: Model, sections: ReadonlyArray<Html>): Html =>
  h.div(
    [],
    [nav(model), h.main([], [...sections, pager(model.route)]), footer(), ...overlay(model)],
  )

const documentation = (model: Model): Html =>
  h.div(
    [],
    [docsBar(model), h.main([], [documentationPage(model)]), footer(), ...overlay(model)],
  )

const beingWritten = (title: string, line: string): Html =>
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

const pageFor = (model: Model): Html =>
  Match.value(model.route).pipe(
    Match.when('home', () =>
      marketingPage(model, [
        hero(model),
        example(model),
        vocabulary(),
        fromInitToEject(model),
      ]),
    ),
    Match.when('docs', () => documentation(model)),
    Match.when('why-loom', () =>
      marketingPage(model, [
        beingWritten(
          'Why Loom',
          'The case for writing the document first, against the three approaches it replaces.',
        ),
      ]),
    ),
    Match.when('community', () =>
      marketingPage(model, [
        beingWritten('Community', 'The people, the corpora in the wild, and where to ask.'),
      ]),
    ),
    Match.when('source', () =>
      marketingPage(model, [
        beingWritten(
          'Source',
          'Loom’s own book, read the way Loom renders one. It weaves to more than a megabyte, so this page fetches a chapter at a time rather than shipping the whole corpus to the browser.',
        ),
      ]),
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

export const view = (model: Model): Document => ({
  title: titleOf(model.route),
  body: pageFor(model),
})
