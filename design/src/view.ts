import { Array } from 'effect'
import type { Document, Html } from 'foldkit/html'
import { arrowIcon, tabbar, titlebar } from './components'
import { hero } from './hero'
import { middle } from './middle'
import { h, type Model } from './model'

const tk = (cls: string, text: string): Html => h.span([h.Class(cls)], [text])

const configPanel = (): Html =>
  h.div(
    [h.Class('config'), h.AriaHidden(true)],
    [
      h.div(
        [h.Class('panel-head')],
        [
          h.span([h.Class('dot')], []),
          h.span([], ['~/greeter/loom.json']),
          h.span([h.Class('right')], ['workspace']),
        ],
      ),
      h.div(
        [h.Class('config-body')],
        [
          tk('com', '// loom.json — the workspace config'),
          '\n',
          tk('pun', '{'),
          '\n',
          '  ', tk('k', '"primary"'), tk('pun', ':'), '   ', tk('v', '"TypeScript"'), tk('pun', ','),
          '\n',
          '  ', tk('k', '"languages"'), tk('pun', ':'), ' ', tk('pun', '['), tk('v', '"TypeScript"'), tk('pun', ','), ' ', tk('v', '"Bash"'), tk('pun', ','), ' ', tk('v', '"JSON"'), tk('pun', ']'), tk('pun', ','),
          '\n',
          '  ', tk('k', '"anchor"'), tk('pun', ':'), '    ', tk('v', '"::' + '[name]"'), tk('pun', ','),
          '\n',
          '  ', tk('k', '"book"'), tk('pun', ':'), '      ', tk('v', '"corpus/book.loom"'),
          '\n',
          tk('pun', '}'),
        ],
      ),
    ],
  )

const signupRight = (): Html =>
  h.div(
    [h.Class('actions')],
    [
      h.a([h.Class('btn primary'), h.Href('#')], ['Read the book', arrowIcon()]),
      h.a([h.Class('btn'), h.Href('#')], ['Browse the source']),
    ],
  )

const getStarted = (model: Model): Html =>
  h.section(
    [h.Class('s'), h.Id('start')],
    [
      h.div(
        [h.Class('wrap')],
        [
          h.div(
            [h.Class('sec-head')],
            [
              h.div(
                [h.Class('sec-num')],
                [h.span([h.Class('arrow')], ['▸']), ' 02 · GET STARTED'],
              ),
              h.div(
                [],
                [
                  h.h2(
                    [h.Class('sec-h')],
                    ['From zero to your', h.br([]), 'first tangle.'],
                  ),
                  h.p(
                    [h.Class('sec-lede')],
                    [
                      'What those commands produce is one workspace config, shown here. From there, the whole book goes further.',
                    ],
                  ),
                ],
              ),
            ],
          ),
          h.div([h.Class('signup')], [configPanel(), signupRight()]),
        ],
      ),
    ],
  )

const footColumn = (
  title: string,
  links: ReadonlyArray<{ label: string; href: string }>,
): Html =>
  h.div(
    [h.Class('foot-col')],
    [
      h.h4([], [title]),
      h.ul(
        [],
        Array.map(links, (link) =>
          h.li([], [h.a([h.Href(link.href)], [link.label])]),
        ),
      ),
    ],
  )

const footer = (): Html =>
  h.footer(
    [h.Class('foot')],
    [
      h.div(
        [h.Class('wrap')],
        [
          h.div(
            [h.Class('foot-grid')],
            [
              h.div(
                [h.Class('foot-col foot-mark')],
                [
                  h.a(
                    [h.Class('brand'), h.Href('#')],
                    [h.span([h.Class('b-mark')], ['~']), h.span([], ['loom'])],
                  ),
                  h.p(
                    [h.Class('tag')],
                    [
                      'A literate programming framework in Effect-TS. Prose and code, woven into one source — then tangled into the real thing.',
                    ],
                  ),
                ],
              ),
              footColumn('// Framework', [
                { label: 'The book', href: '#' },
                { label: 'Getting started', href: '#start' },
                { label: 'How it works', href: '#how' },
              ]),
              footColumn('// Reference', [
                { label: 'Language', href: '#' },
                { label: 'Packages', href: '#' },
                { label: 'Effect-TS', href: 'https://effect.website' },
              ]),
              footColumn('// Source', [
                { label: 'The corpus', href: '#' },
                { label: 'Releases', href: '#' },
                { label: 'License', href: '#' },
              ]),
            ],
          ),
        ],
      ),
    ],
  )

const page = (model: Model): Html =>
  h.div(
    [],
    [
      titlebar(),
      tabbar(),
      h.main([], [hero(model), middle(model), getStarted(model)]),
      footer(),
    ],
  )

export const view = (model: Model): Document => ({
  title: 'loom — programs written to be read',
  body: page(model),
})
