import { Array, Match } from 'effect'
import type { Html } from 'foldkit/html'
import { copyButton, bookIcon, externalIcon, searchIcon } from './components'
import { h, type Model } from './model'

export const ROTATOR_WORDS = ['a book', 'an article', 'a prompt']

const rotatorClass = (phase: Model['rotatorPhase']): string =>
  Match.value(phase).pipe(
    Match.when('out', () => 'rotator-word out'),
    Match.when('in-start', () => 'rotator-word in-start'),
    Match.orElse(() => 'rotator-word'),
  )

const headline = (model: Model): Html =>
  h.h1(
    [h.Class('loom-h')],
    [
      h.span([h.Class('hl-1')], ['Write programs']),
      h.br([]),
      h.span([h.Class('hl-2')], [`the way you'd write`]),
      h.br([]),
      h.span(
        [h.Class('rotator-host hl-3'), h.AriaLive('polite')],
        [
          h.span(
            [h.Class(rotatorClass(model.rotatorPhase))],
            [ROTATOR_WORDS[model.rotatorIndex] ?? ROTATOR_WORDS[0]],
          ),
        ],
      ),
      h.span([h.Class('caret'), h.AriaHidden(true)], []),
    ],
  )

const pitch = (model: Model): Html =>
  h.div(
    [],
    [
      h.div(
        [h.Class('meta-row')],
        [
          h.span(
            [h.Class('pill')],
            [h.span([h.Class('gh')], ['~']), ' loom · v0.9.0'],
          ),
          h.span([], ['literate programming · open source']),
        ],
      ),
      headline(model),
      h.p(
        [h.Class('lede')],
        [
          'Loom is an AI-friendly framework where specifications and code do not drift apart ',
          h.span([h.Class('tok-str')], ['— because prose is the program']),
          '.',
        ],
      ),
      h.div(
        [h.Class('actions')],
        [
          h.div(
            [h.Class('cmd-line'), h.Title('Copy the install command')],
            [
              h.span([h.Class('prompt')], ['$']),
              h.code([], ['bun add -g @athrio/loom-cli']),
              copyButton({
                id: 'install',
                text: 'bun add -g @athrio/loom-cli',
                copied: model.copied,
              }),
            ],
          ),
        ],
      ),
      h.div(
        [h.Class('actions'), h.Style({ marginTop: '16px' })],
        [
          h.a(
            [h.Class('btn primary'), h.Href('#')],
            ['Read the book', bookIcon()],
          ),
          h.a(
            [h.Class('btn'), h.Href('#')],
            ['Browse the source', externalIcon()],
          ),
          h.button([h.Class('btn')], [searchIcon(), 'Search the book']),
        ],
      ),
    ],
  )

const tk = (cls: string, text: string): Html => h.span([h.Class(cls)], [text])

const editorCode = (model: Model): ReadonlyArray<Html | string> => [
  tk('pun', '---'),
  '\n',
  tk('k', 'Language:'), ' ', tk('ty', 'TypeScript'),
  '\n',
  tk('k', 'Package:'), ' ', tk('ty', 'src/greeter.ts'),
  '\n',
  tk('pun', '---'),
  '\n\n',
  tk('op', '#'), ' ', tk('hd', 'A friendly greeting'),
  '\n\n',
  tk('pr', 'A greeter turns a name into a line to say back.'),
  '\n\n',
  tk('op', '=>'),
  '\n\n',
  tk('k', 'export'), ' ', tk('k', 'const'), ' ', tk('id', 'greet'), ' ',
  tk('pun', '= ('), tk('id', 'name'), tk('pun', ':'), ' ', tk('ty', 'string'), tk('pun', ') =>'),
  '\n',
  '  ', tk('str', '`Hello, ${name}.`'),
  '\n\n',
  tk('op', '#'), ' ', tk('hd', 'The module'), ' ', tk('op', '{Tangle}'),
  '\n\n',
  h.span([h.Class('glow typing'), h.Id('typing-line')], [model.typed]),
]

const gutter = Array.makeBy(17, (index) => String(index + 1)).join('\n')

const editorPanel = (model: Model): Html =>
  h.div(
    [h.Class('panel'), h.AriaHidden(true)],
    [
      h.div(
        [h.Class('panel-head')],
        [
          h.span([h.Class('dot')], []),
          h.span([], ['~/loom/greeter/a-first-loom.loom']),
          h.span([h.Class('right')], ['UTF-8 · LF · 17 lines']),
        ],
      ),
      h.div(
        [h.Class('editor')],
        [
          h.div([h.Class('gutter-col')], [gutter]),
          h.div([h.Class('code')], editorCode(model)),
        ],
      ),
    ],
  )

export const hero = (model: Model): Html =>
  h.section(
    [h.Class('hero')],
    [
      h.div(
        [h.Class('wrap')],
        [h.div([h.Class('hero-grid')], [pitch(model), editorPanel(model)])],
      ),
    ],
  )
