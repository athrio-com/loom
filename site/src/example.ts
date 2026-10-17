import { Array, Match, Option, pipe } from 'effect'
import type { Html, HtmlBuilder } from 'foldkit/html'
import {
  Copied,
  type Message,
  type Model,
  type Player,
  type PlayerOutput,
  ReplayedDocument,
  ShowedOutput,
  SkippedToEnd,
  ToggledFullHeight,
  ToggledPlay,
} from './model'
import {
  checkIcon,
  copyIcon,
  backIcon,
  broadSeam,
  carpetMark,
  collapseIcon,
  exampleCarpet,
  expandIcon,
  pauseIcon,
  playTriangle,
  replayIcon,
  skipIcon,
} from './components'

const BLUE = '#2E6FF2'
const VIOLET = '#8B5CF6'
const GREEN = '#00996B'
const ORANGE = '#E8501F'
const GREY = '#7C6F64'
const INK = '#14130F'

type Token = {
  readonly text: string
  readonly colour: string
  readonly wash: string
  readonly padded: boolean
  readonly bold: boolean
}

type Line = {
  readonly tokens: ReadonlyArray<Token>
  readonly tall: boolean
  readonly kept: boolean
  readonly rest: number
}

const WASH = {
  blue: 'rgba(46, 111, 242, 0.10)',
  violet: 'rgba(139, 92, 246, 0.10)',
  green: 'rgba(0, 153, 107, 0.12)',
  orange: 'rgba(232, 80, 31, 0.12)',
  grey: 'rgba(124, 111, 100, 0.14)',
  ink: 'rgba(20, 19, 15, 0.06)',
}

const plain = (text: string, colour: string = INK, bold: boolean = false): Token => ({
  text,
  colour,
  wash: 'transparent',
  padded: false,
  bold,
})

const chip = (text: string, colour: string, wash: string, bold: boolean = true): Token => ({
  text,
  colour,
  wash,
  padded: true,
  bold,
})

const line = (tokens: ReadonlyArray<Token>, kept: boolean, rest: number): Line => ({
  tokens,
  tall: true,
  kept,
  rest,
})

const gap: Line = { tokens: [], tall: false, kept: false, rest: 0 }

const BEAT = 14

const says = (tokens: ReadonlyArray<Token>, rest: number = 0): Line => line(tokens, false, rest)
const prose = (text: string, rest: number = 0): Line => says([plain(text)], rest)
const code = (text: string, rest: number = 0): Line => line([plain(text)], true, rest)
const heading = (text: string, rest: number): Line =>
  says([chip('#', BLUE, WASH.blue), plain(` ${text}`, BLUE, true)], rest)
const part = (text: string, rest: number): Line =>
  says([chip('##', BLUE, WASH.blue), plain(` ${text}`, BLUE, true)], rest)
const opens = (rest: number): Line => says([chip('=>', GREEN, WASH.green)], rest)
const closes = (rest: number): Line => says([chip('~', ORANGE, WASH.orange)], rest)
const anchor = (name: string, rest: number): Line =>
  line([chip(`::${'['}${name}]`, VIOLET, WASH.violet, false)], true, rest)

const DOCUMENT: ReadonlyArray<Line> = [
  heading('Loom, explained in Loom', 2 * BEAT),
  gap,
  prose('Prose first. You are writing for a person — the code lives inside the explanation.', 2 * BEAT),
  gap,
  part('Greeting', BEAT),
  gap,
  prose('Everything under a heading is prose, until an arrow opens the code.', 2 * BEAT),
  gap,
  opens(BEAT),
  gap,
  code('export function greet(who: string) {'),
  code('  return `Hello, ${who}`'),
  code('}', 2 * BEAT),
  gap,
  part('Run it', BEAT),
  gap,
  prose(
    'Nothing closed that block — code runs on to the next heading. A tilde is only for stepping back into prose mid-section.',
    2 * BEAT,
  ),
  gap,
  opens(0),
  gap,
  code("console.log(greet('world'))", BEAT),
  gap,
  closes(BEAT),
  gap,
  prose('Like so.', 2 * BEAT),
  gap,
  says(
    [chip('##', BLUE, WASH.blue), plain(' Assembling ', BLUE, true), chip('[hello.ts]', GREY, WASH.grey, false)],
    2 * BEAT,
  ),
  gap,
  prose(
    'A file name in brackets becomes a target.\n\nCode after the arrow holds the composition order.',
    2 * BEAT,
  ),
  gap,
  opens(BEAT),
  gap,
  anchor('Greeting', BEAT),
  anchor('Run it', BEAT),
  gap,
  closes(2 * BEAT),
  gap,
  says(
    [
      plain('Each anchor pulls in a section it names. '),
      chip('loom tangle', INK, WASH.ink, false),
      plain(' writes hello.ts in that order.'),
    ],
    2 * BEAT,
  ),
  gap,
  prose("That's it."),
]

const noise = (index: number): number => {
  const raw = Math.sin(index * 12.9898 + 78.233) * 43758.5453
  return raw - Math.floor(raw)
}

const CLASSES: ReadonlyArray<readonly [string, number]> = [
  [' ', 0.75],
  ['.!?', 1.9],
  [',;:', 1.8],
  ['{}()[]<>$`~=#—', 1.9],
]

const reachOf = (char: string, opening: boolean): number =>
  opening
    ? 1.35
    : pipe(
        Array.findFirst(CLASSES, ([chars]) => chars.includes(char)),
        Option.map(([, cost]) => cost),
        Option.getOrElse(() => (char >= 'A' && char <= 'Z' ? 1.5 : 1)),
      )

type Scan = {
  readonly costs: ReadonlyArray<number>
  readonly owed: number
  readonly burst: number
  readonly raw: number
  readonly struck: number
}

const strike = (scan: Scan, char: string, opening: boolean): Scan => {
  const index = scan.costs.length
  const reach =
    reachOf(char, opening) * (0.66 + noise(index) * 0.72) + (noise(index + 7) > 0.984 ? 5 : 0)
  const owed = scan.owed + reach
  const held = scan.burst > 1 && char !== ' '
  return {
    costs: [...scan.costs, held ? 0.02 : owed],
    owed: held ? owed - 0.02 : 0,
    burst: held ? scan.burst - 1 : 1 + Math.floor(noise(index + 31) * 3),
    raw: scan.raw + reach,
    struck: scan.struck + 1,
  }
}

const enter = (scan: Scan): Scan => {
  const index = scan.costs.length
  const reach = 2.4 * (0.72 + noise(index) * 0.56)
  return {
    costs: [...scan.costs, scan.owed + reach],
    owed: 0,
    burst: 1,
    raw: scan.raw + reach,
    struck: scan.struck + 1,
  }
}

const rest = (scan: Scan): Scan => ({ ...scan, costs: [...scan.costs, -1] })

const rested = (scan: Scan, beats: number): Scan =>
  beats <= 0 ? scan : rested(rest(scan), beats - 1)

const scanLine = (scan: Scan, source: Line, index: number): Scan =>
  pipe(
    index === 0 ? scan : enter(scan),
    (opened) =>
      Array.reduce(
        Array.flatMap(source.tokens, (token) => token.text.split('')),
        opened,
        (carried, char, at) => strike(carried, char, at === 0),
      ),
    (typed) => rested(typed, source.rest),
  )

const SCAN: Scan = Array.reduce(
  DOCUMENT,
  { costs: [], owed: 0, burst: 1, raw: 0, struck: 0 },
  scanLine,
)

const NORM = SCAN.struck === 0 ? 1 : SCAN.struck / SCAN.raw

export const CHARACTERS = SCAN.costs.length

const CLOCK: ReadonlyArray<number> = Array.reduce(
  SCAN.costs,
  [0] as ReadonlyArray<number>,
  (clock, cost) => [...clock, clock[clock.length - 1]! + (cost < 0 ? 1 : cost * NORM)],
)

export const RUN = CLOCK[CHARACTERS]!

export const struckBy = (beat: number): number => {
  const search = (low: number, high: number): number => {
    if (low >= high) {
      return low
    }
    const middle = (low + high) >> 1
    return CLOCK[middle + 1]! <= beat ? search(middle + 1, high) : search(low, middle)
  }
  return search(0, CHARACTERS)
}

type Shown = {
  readonly tokens: ReadonlyArray<Token>
  readonly tall: boolean
  readonly kept: boolean
  readonly caret: boolean
  readonly held: boolean
  readonly lit: boolean
}

type Cut = {
  readonly taken: ReadonlyArray<Token>
  readonly left: number
  readonly whole: boolean
}

const cutTokens = (tokens: ReadonlyArray<Token>, left: number): Cut =>
  Array.reduce(tokens, { taken: [], left, whole: true } as Cut, (cut, token) => {
    if (cut.left <= 0) {
      return { ...cut, whole: false }
    }
    const take = Math.min(cut.left, token.text.length)
    return {
      taken: [...cut.taken, { ...token, text: token.text.slice(0, take) }],
      left: cut.left - take,
      whole: cut.whole && take === token.text.length,
    }
  })

export const frameAt = (struck: number, playing: boolean): ReadonlyArray<Shown> => {
  const walk = (index: number, left: number, out: ReadonlyArray<Shown>): ReadonlyArray<Shown> => {
    if (index >= DOCUMENT.length || (left <= 0 && index > 0)) {
      return out
    }
    const source = DOCUMENT[index]!
    const opened = index === 0 ? left : left - 1
    const cut = cutTokens(source.tokens, opened)
    const after = cut.whole ? cut.left - source.rest : cut.left
    const resting = playing && cut.whole && after <= 0 && source.tokens.length > 0
    const shown: Shown = {
      tokens: cut.taken,
      tall: source.tall,
      kept: source.kept,
      caret: playing && after <= 0,
      held: resting,
      lit: playing && after <= 0,
    }
    return after <= 0 ? [...out, shown] : walk(index + 1, after, [...out, shown])
  }
  return walk(0, struck, [])
}

export const wholeDocument = (): ReadonlyArray<Shown> => frameAt(CHARACTERS, false)

const TANGLED: ReadonlyArray<string> = [
  'export function greet(who: string) {',
  '  return `Hello, ${who}`',
  '}',
  '',
  "console.log(greet('world'))",
]

const WOVEN: ReadonlyArray<string> = [
  '{',
  '  "nav": [],',
  '  "loose": [',
  '    { "number": "", "title": "Loom, explained in Loom", "slug": "hello" }',
  '  ],',
  '  "pages": [',
  '    {',
  '      "slug": "hello",',
  '      "title": "Loom, explained in Loom",',
  '      "blocks": [',
  '        {',
  '          "type": "heading",',
  '          "source": { "chapter": "hello", "section": "greeting" },',
  '          "level": 2,',
  '          "title": "Greeting",',
  '          "id": "greeting"',
  '        },',
  '        {',
  '          "type": "prose",',
  '          "source": { "chapter": "hello", "section": "greeting" },',
  '          "markdown": "Prose runs until an arrow opens the code."',
  '        },',
  '        {',
  '          "type": "code",',
  '          "source": { "chapter": "hello", "section": "greeting" },',
  '          "language": "typescript",',
  '          "code": "export function greet(who: string) {\\n  return `Hello, ${who}`\\n}",',
  '          "links": []',
  '        }',
  '      ]',
  '    }',
  '  ]',
  '}',
]

const JSON_TOKEN = /("(?:[^"\\]|\\.)*")(\s*:)?|(-?\d+)|(true|false|null)|([^"\d]+)/g

const jsonTokens = (source: string): ReadonlyArray<Token> =>
  pipe(
    Array.fromIterable(source.matchAll(JSON_TOKEN)),
    Array.flatMap((match) =>
      Match.value(match).pipe(
        Match.when(
          (found) => found[1] !== undefined && found[2] !== undefined,
          (found) => [plain(found[1]!, BLUE), plain(found[2]!, GREY)],
        ),
        Match.when(
          (found) => found[1] !== undefined,
          (found) => [plain(found[1]!, GREEN)],
        ),
        Match.when(
          (found) => found[3] !== undefined || found[4] !== undefined,
          (found) => [plain(found[3] ?? found[4]!, VIOLET)],
        ),
        Match.orElse((found) => [plain(found[5] ?? '', GREY)]),
      ),
    ),
  )

const outputLines = (which: PlayerOutput): ReadonlyArray<ReadonlyArray<Token>> =>
  Match.value(which).pipe(
    Match.when('tangle', () => Array.map(TANGLED, (source) => [plain(source)])),
    Match.when('weave', () => Array.map(WOVEN, jsonTokens)),
    Match.exhaustive,
  )

const outputFile = (which: PlayerOutput): string =>
  which === 'tangle' ? 'hello.ts' : 'hello.woven.json'

const outputMeta = (which: PlayerOutput): string =>
  which === 'tangle' ? '5 lines' : 'the corpus as data'

const tokenSpan = (token: Token, h: HtmlBuilder<Message>): Html =>
  h.span(
    [
      h.Class(token.padded ? 'pl-tok chip' : 'pl-tok'),
      h.Style({
        color: token.colour,
        background: token.wash,
        fontWeight: token.bold ? '600' : '400',
      }),
    ],
    [token.text],
  )

const shownLine = (shown: Shown, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class(shown.kept ? 'pl-line kept' : 'pl-line'), h.Style({ minHeight: shown.tall ? '1.4em' : '0.8em' })],
    [
      ...(shown.lit ? [h.span([h.AriaHidden(true), h.Class('pl-cur')], [])] : []),
      ...Array.map(shown.tokens, (token) => tokenSpan(token, h)),
      ...(shown.caret
        ? [h.span([h.AriaHidden(true), h.Class(shown.held ? 'pl-caret blink' : 'pl-caret')], [])]
        : []),
    ],
  )

const commandButton = (which: PlayerOutput, player: Player, h: HtmlBuilder<Message>): Html =>
  h.button(
    [
      h.Class(
        Option.contains(player.output, which) ? `pl-out ${which} showing` : `pl-out ${which}`,
      ),
      h.Type('button'),
      h.OnClick(ShowedOutput({ which })),
    ],
    [
      h.span([h.Class('pl-out-cmd')], [`$ loom ${which}`]),
      h.span([h.Class('pl-out-file')], [`writes ${outputFile(which)}`]),
    ],
  )

const outputPanel = (which: PlayerOutput, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class(`pl-result ${which}`)],
    [
      h.div(
        [h.Class('pl-result-head')],
        [
          h.span([h.Class('pl-result-file')], [outputFile(which)]),
          h.span([h.Class('pl-result-meta')], [outputMeta(which)]),
        ],
      ),
      h.div(
        [h.Class('pl-result-body')],
        Array.map(outputLines(which), (tokens) =>
          h.div(
            [h.Class('pl-result-line')],
            Array.map(tokens, (token) => tokenSpan(token, h)),
          ),
        ),
      ),
    ],
  )

const AMBER = '#8A5A00'
const AMBER_WASH = 'rgba(255, 197, 61, 0.2)'

type CanvasLine = { readonly tokens: ReadonlyArray<Token>; readonly kept: boolean }

type Reading = {
  readonly lines: ReadonlyArray<CanvasLine>
  readonly inFrontmatter: boolean
  readonly inCode: boolean
  readonly explicit: boolean
}

const withAnchors = (text: string): ReadonlyArray<Token> =>
  pipe(
    text.split(/(::\[[^\]]*\])/),
    Array.filter((piece) => piece !== ''),
    Array.map((piece) =>
      piece.startsWith(`::${'['}`) ? chip(piece, VIOLET, WASH.violet, false) : plain(piece),
    ),
  )

const headingTokens = (marks: string, title: string): ReadonlyArray<Token> => [
  chip(marks, BLUE, WASH.blue),
  plain(' '),
  ...pipe(
    title.split(/(\{[^}]*\}|\[[^\]]*\])/),
    Array.filter((piece) => piece !== ''),
    Array.map((piece) =>
      Match.value(piece.charAt(0)).pipe(
        Match.when('{', () => chip(piece, AMBER, AMBER_WASH)),
        Match.when('[', () => chip(piece, BLUE, WASH.blue, false)),
        Match.orElse(() => plain(piece, BLUE, true)),
      ),
    ),
  ),
]

const fieldTokens = (text: string): ReadonlyArray<Token> =>
  Option.match(Option.fromNullishOr(/^([^:]+:)(.*)$/.exec(text)), {
    onNone: () => [plain(text)],
    onSome: ([, key, value]) => [plain(key ?? '', VIOLET, true), plain(value ?? '')],
  })

const headingOf = (text: string): Option.Option<readonly [string, string]> =>
  Option.map(
    Option.fromNullishOr(/^(#{1,6}) (.*)$/.exec(text)),
    (found) => [found[1] ?? '#', found[2] ?? ''] as const,
  )

const readLine = (reading: Reading, text: string, at: number): Reading => {
  const add = (tokens: ReadonlyArray<Token>, kept: boolean, next: Partial<Reading> = {}): Reading => ({
    ...reading,
    ...next,
    lines: [...reading.lines, { tokens, kept }],
  })
  const when = (holds: boolean, read: () => Reading): Option.Option<Reading> =>
    holds ? Option.some(read()) : Option.none()
  return pipe(
    when(text.trim() === '---' && (at === 0 || reading.inFrontmatter), () =>
      add([chip('---', VIOLET, WASH.violet)], false, { inFrontmatter: !reading.inFrontmatter }),
    ),
    Option.orElse(() => when(reading.inFrontmatter, () => add(fieldTokens(text), false))),
    Option.orElse(() =>
      when(/^~(\s|$)/.test(text), () =>
        add([chip('~', ORANGE, WASH.orange)], false, { inCode: false, explicit: false }),
      ),
    ),
    Option.orElse(() => (reading.explicit ? Option.none() : headingOf(text)).pipe(
      Option.map(([marks, title]) => add(headingTokens(marks, title), false, { inCode: false })),
    )),
    Option.orElse(() =>
      when(!reading.inCode && /^\s*[=~]>/.test(text), () => {
        const arrow = text.trim().slice(0, 2)
        return add([chip(arrow, GREEN, WASH.green)], false, { inCode: true, explicit: arrow === '~>' })
      }),
    ),
    Option.getOrElse(() => add(withAnchors(text), reading.inCode)),
  )
}

const canvasLines = (source: string): ReadonlyArray<CanvasLine> =>
  Array.reduce(
    source.replace(/\n$/, '').split('\n'),
    { lines: [], inFrontmatter: false, inCode: false, explicit: false } as Reading,
    readLine,
  ).lines

const canvasCopy = (source: string, copied: string, h: HtmlBuilder<Message>): Html => {
  const id = `loom:${source}`
  const taken = copied === id
  return h.button(
    [
      h.Class(taken ? 'canvas-copy done' : 'canvas-copy'),
      h.Type('button'),
      h.Title(taken ? 'Copied' : 'Copy the loom'),
      h.AriaLabel('Copy the loom'),
      h.OnClick(Copied({ id, text: source })),
    ],
    [taken ? checkIcon() : copyIcon()],
  )
}

export const loomCanvas = (source: string, copied: string, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('docs-canvas')],
    [
      canvasCopy(source, copied, h),
      ...Array.map(canvasLines(source), (line) =>
        h.div(
          [h.Class(line.kept ? 'pl-line kept' : 'pl-line'), h.Style({ minHeight: '1em' })],
          Array.map(line.tokens, (token) => tokenSpan(token, h)),
        ),
      ),
    ],
  )

const fullTitle = (player: Player): string =>
  player.full ? 'Leave full height' : 'Full height'

const fullButton = (player: Player, h: HtmlBuilder<Message>): Html =>
  h.button(
    [
      h.Class('pl-full'),
      h.Type('button'),
      h.Title(fullTitle(player)),
      h.AriaLabel(fullTitle(player)),
      h.OnClick(ToggledFullHeight()),
    ],
    [player.full ? collapseIcon() : expandIcon()],
  )

const transport = (player: Player, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('pl-bar')],
    [
      h.button(
        [h.Class('pl-back'), h.Type('button'), h.Title('Back to the start'), h.AriaLabel('Back to the start'), h.OnClick(ReplayedDocument())],
        [backIcon()],
      ),
      h.button(
        [h.Class('pl-play'), h.Type('button'), h.Title(playTitle(player)), h.AriaLabel(playTitle(player)), h.OnClick(ToggledPlay())],
        [playGlyph(player)],
      ),
      h.button(
        [
          h.Class(finished(player) ? 'pl-skip gone' : 'pl-skip'),
          h.Type('button'),
          h.Title('Skip to the end'),
          h.AriaLabel('Skip to the end'),
          h.OnClick(SkippedToEnd()),
        ],
        [skipIcon()],
      ),
    ],
  )

const finished = (player: Player): boolean => player.struck >= CHARACTERS

const playTitle = (player: Player): string =>
  Match.value(player).pipe(
    Match.when((state) => state.playing, () => 'Pause'),
    Match.when(finished, () => 'Play it again'),
    Match.orElse(() => 'Play'),
  )

const playGlyph = (player: Player): Html =>
  Match.value(player).pipe(
    Match.when((state) => state.playing, () => pauseIcon()),
    Match.when(finished, () => replayIcon()),
    Match.orElse(() => playTriangle()),
  )

const cardClass = (player: Player, done: boolean): string => {
  const running = player.playing ? ' running' : ''
  const open = done || player.full ? ' open' : ''
  return `pl-card${running}${open}`
}

export const example = (model: Model, h: HtmlBuilder<Message>): Html => {
  const player = model.player
  const shown =
    player.struck === 0 && !player.playing ? wholeDocument() : frameAt(player.struck, player.playing)
  const done = finished(player)
  const progress = done ? 1 : Math.min(1, player.beat / RUN)
  const offering = done || (player.full && !player.playing)
  return h.div(
    [h.Class('section'), h.Id('loom-example')],
    [
      h.div(
        [h.Class('section-head')],
        [
          carpetMark(exampleCarpet, '42px', broadSeam),
          h.div(
            [h.Class('lines')],
            [
              h.span([h.Class('eyebrow')], ['Literate programming']),
              h.h2([], ['A Loom document, written out']),
            ],
          ),
        ],
      ),
      h.div(
        [h.Class(player.full ? 'pl-hold full' : 'pl-hold'), h.Id('loom-card')],
        [
          h.div(
            [
              h.Class(cardClass(player, done)),
              h.Style({ '--pl-run': `${Math.round(progress * 1000) / 10}%` }),
            ],
            [
              fullButton(player, h),
              h.span([h.AriaHidden(true), h.Class('pl-run')], []),
              h.div(
                [h.Class('pl-stage'), h.Id('loom-stage')],
                [
                  h.div(
                    [h.Class('pl-column')],
                    [
                      ...Array.map(shown, (line) => shownLine(line, h)),
                      ...(offering
                        ? [
                            h.div(
                              [h.Class('pl-outs')],
                              [commandButton('tangle', player, h), commandButton('weave', player, h)],
                            ),
                          ]
                        : []),
                      ...Option.match(player.output, {
                        onNone: (): ReadonlyArray<Html> => [],
                        onSome: (which) => (offering ? [outputPanel(which, h)] : []),
                      }),
                    ],
                  ),
                  h.div([h.AriaHidden(true), h.Class('pl-tail')], []),
                ],
              ),
              h.div([h.AriaHidden(true), h.Class('pl-fade')], []),
              transport(player, h),
            ],
          ),
        ],
      ),
    ],
  )
}
