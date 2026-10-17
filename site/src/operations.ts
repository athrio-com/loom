import { Array, Match } from 'effect'
import type { Html, HtmlBuilder } from 'foldkit/html'
import { Copied, type Message, type Model } from './model'
import { broadSeam, carpetMark, operationsCarpet } from './components'
import initDrawing from './init.svg?raw'
import tangleDrawing from './tangle.svg?raw'
import ejectDrawing from './eject.svg?raw'

type Operation = {
  readonly command: string
  readonly colour: string
  readonly wash: string
  readonly says: string
  readonly drawing?: string
  readonly json?: ReadonlyArray<ReadonlyArray<readonly [string, string]>>
}

export const operations: ReadonlyArray<Operation> = [
  {
    command: 'loom init',
    colour: '#00996B',
    wash: 'rgba(0, 153, 107, 0.13)',
    says: 'Scaffolds the workspace: a .loom directory holding its config.yaml, and a corpus you make for the documents you write — read in order, top to bottom.',
    drawing: initDrawing,
  },
  {
    command: 'loom tangle',
    colour: '#2E6FF2',
    wash: 'rgba(46, 111, 242, 0.10)',
    says: 'A section names the file its code belongs to. One document can fill several files, and several documents can fill one.',
    drawing: tangleDrawing,
  },
  {
    command: 'loom weave',
    colour: '#8B5CF6',
    wash: 'rgba(139, 92, 246, 0.10)',
    says: 'The whole corpus as one document — prose, headings, bindings, and a pointer into each tangled file. Any site generator can render it.',
    json: [
      [['{', 'punctuation']],
      [
        ['  "parts"', 'key'],
        [': [', 'punctuation'],
        ['"The board"', 'string'],
        [', ', 'punctuation'],
        ['"Rules"', 'string'],
        [', … ],', 'punctuation'],
      ],
      [
        ['  "sections"', 'key'],
        [': ', 'punctuation'],
        ['38', 'number'],
        [',', 'punctuation'],
      ],
      [
        ['  "sinks"', 'key'],
        [': [', 'punctuation'],
        ['"board.ts"', 'string'],
        [', ', 'punctuation'],
        ['"store.sql"', 'string'],
        [', … ]', 'punctuation'],
      ],
      [['}', 'punctuation']],
    ],
  },
  {
    command: 'loom eject',
    colour: '#CE3F5C',
    wash: 'rgba(206, 63, 92, 0.12)',
    says: 'Loom does not lock you in. There is always a way out: the corpus is archived, and the tangled source is left running.',
    drawing: ejectDrawing,
  },
]

const jsonLine = (
  line: ReadonlyArray<readonly [string, string]>,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class('json-line')],
    Array.map(line, ([text, kind]) => h.span([h.Class(`tok-${kind}`)], [text])),
  )

const jsonBlock = (
  lines: ReadonlyArray<ReadonlyArray<readonly [string, string]>>,
  h: HtmlBuilder<Message>,
): Html =>
  h.div([h.Class('px-json')], Array.map(lines, (line) => jsonLine(line, h)))

const illustration = (operation: Operation, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('ops-frame')],
    [
      Match.value(operation.drawing).pipe(
        Match.when(Match.undefined, () =>
          h.div([h.Class('ops-art')], [jsonBlock(operation.json ?? [], h)]),
        ),
        Match.orElse((drawing) => h.div([h.Class('ops-svg'), h.InnerHTML(drawing)], [])),
      ),
    ],
  )

const operationCard = (operation: Operation, copied: string, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('ops-card')],
    [
      h.div(
        [h.Class('ops-head')],
        [
          h.button(
            [
              h.Class('ops-pill'),
              h.Type('button'),
              h.Title('Copy command'),
              h.Style({ color: operation.colour, background: operation.wash }),
              h.OnClick(Copied({ id: operation.command, text: operation.command })),
            ],
            [operation.command],
          ),
          h.span(
            [
              h.Class(copied === operation.command ? 'ops-took shown' : 'ops-took'),
              h.Style({ color: operation.colour }),
            ],
            ['copied'],
          ),
        ],
      ),
      illustration(operation, h),
      h.p([h.Class('ops-says')], [operation.says]),
    ],
  )

export const fromInitToEject = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('section'), h.Id('loom-operations')],
    [
      h.div(
        [h.Class('section-head')],
        [
          carpetMark(operationsCarpet, '42px', broadSeam),
          h.div(
            [h.Class('lines')],
            [
              h.span([h.Class('eyebrow')], ['Loom CLI']),
              h.h2([], ['From init to eject']),
            ],
          ),
        ],
      ),
      h.div(
        [h.Class('ops-grid')],
        Array.map(operations, (operation) => operationCard(operation, model.copied, h)),
      ),
    ],
  )
