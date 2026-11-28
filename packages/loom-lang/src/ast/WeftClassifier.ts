import { Array, Context, Effect, Layer, Match, Option } from 'effect'
import type { LineRange } from './LineRanges'
import {
  incompleteHealth,
  nodeOf,
  okHealth,
  type Position,
  byType,
  byTypeOr,
} from '@athrio/loom-ast/LoomNode'
import {
  ArrowTokenSchema,
  BoxFenceTokenSchema,
  type BoxToken,
  BoxTokenSchema,
  CodeFenceTokenSchema,
  DividerTokenSchema,
  closesFence,
  type Fence,
  FrontmatterFenceTokenSchema,
  HeadingStartTokenSchema,
  openingFence,
  TildeTokenSchema,
  getProbe,
} from '@athrio/loom-ast/LoomTokens'
import {
  type ArrowWeft,
  ArrowWeftSchema,
  type CodeWeft,
  CodeWeftSchema,
  type DividerWeft,
  DividerWeftSchema,
  type FenceWeft,
  FenceWeftSchema,
  type FrontmatterWeft,
  FrontmatterWeftSchema,
  type HeadingWeft,
  HeadingWeftSchema,
  type LoomWeft,
  type PreambleWeft,
  PreambleWeftSchema,
  type ProseWeft,
  ProseWeftSchema,
  type TildeWeft,
  TildeWeftSchema,
  nextBox,
} from '@athrio/loom-ast/Weft'

type ClassifierState = {
  readonly prev: Option.Option<LoomWeft>
  readonly seenHeading: boolean
  readonly inFrontmatter: boolean
  readonly quote: Option.Option<Fence>
  readonly inBox: boolean
  readonly discussion: boolean
  readonly fenced: Option.Option<Fence>
  readonly awaitingFence: boolean
}

const initialState: ClassifierState = {
  prev: Option.none(),
  seenHeading: false,
  inFrontmatter: false,
  quote: Option.none(),
  inBox: false,
  discussion: false,
  fenced: Option.none(),
  awaitingFence: false,
}

const lineStep =
  (text: string) =>
  (state: ClassifierState, range: LineRange): readonly [ClassifierState, LoomWeft] => {
    const lineText = text.slice(range[0], range[1])
    const weft = boxed(probeWeft(lineText, range, state), state)
    const frontmatterFence = weft.type === 'FrontmatterWeft' && weft.fence !== undefined
    return [
      {
        prev: Option.some(weft),
        seenHeading: state.seenHeading || weft.type === 'HeadingWeft',
        inFrontmatter: state.inFrontmatter !== frontmatterFence,
        quote: nextQuote(state.quote, state.inBox, weft),
        inBox: nextBox(state.inBox, weft),
        discussion: state.discussion || (state.inFrontmatter && namesDiscussion(lineText)),
        fenced: nextFenced(state.fenced, weft),
        awaitingFence: nextAwaiting(weft, state.awaitingFence),
      },
      weft,
    ]
  }

export class WeftClassifier extends Context.Service<WeftClassifier>()('WeftClassifier', {
  make: Effect.succeed({
    classifyWefts:
      (text: string) =>
      (ranges: ReadonlyArray<LineRange>): ReadonlyArray<LoomWeft> =>
        Array.mapAccum(ranges, initialState, lineStep(text))[1],
  }),
}) {
  static readonly layer = Layer.effect(this, this.make)
}

const probeWeft = (lineText: string, range: LineRange, state: ClassifierState): LoomWeft => {
  const line = Option.match(state.prev, {
    onNone: () => 1,
    onSome: (w) => w.position.end.line + 1,
  })

  if (Option.isNone(state.prev) && isFrontmatterFence(lineText))
    return makeFrontmatterFence(lineText, line, range)

  if (state.inFrontmatter) {
    if (isFrontmatterFence(lineText)) return makeFrontmatterFence(lineText, line, range)
    return makeFrontmatterField(lineText, line, range)
  }

  if (Option.isSome(state.quote) || state.inBox)
    return state.seenHeading && !keepsPreamble(state.prev)
      ? makeProseWeft(lineText, line, range)
      : makePreambleWeft(lineText, line, range)

  if (Option.isSome(state.fenced))
    return closesFence(state.fenced.value)(lineText)
      ? makeFenceWeft(lineText, line, range, 'close')
      : makeCodeWeft(lineText, line, range)

  if (state.awaitingFence && Option.isSome(openingFence(lineText)))
    return makeFenceWeft(lineText, line, range, 'open')

  const probe = probeOf(lineText)

  if (probe.type === 'heading') return makeHeadingWeft(lineText, line, range, probe.m)

  if (!state.seenHeading) return makePreambleWeft(lineText, line, range)

  if (isDivider(lineText)) return makeDividerWeft(lineText, line, range)

  if (state.discussion) return discussionWeftOf(probe, lineText, line, range, state.prev)

  return readerIn(modeOf(state.prev))(probe, lineText, line, range)
}

type Line = [lineText: string, line: number, range: LineRange]

type LineReader = (probe: Probe, ...line: Line) => LoomWeft

const preambleLine: LineReader = byTypeOr<Probe, Line>()<LoomWeft>(
  {
    arrow: (arrow, lineText, line, range) => makeArrowWeft(lineText, line, range, arrow.m),
    tilde: (tilde, lineText, line, range) => makeTildeWeft(lineText, line, range, tilde.m),
  },
  (_probe, lineText, line, range) => makePreambleWeft(lineText, line, range),
)

const codeLine: LineReader = byTypeOr<Probe, Line>()<LoomWeft>(
  { tilde: (tilde, lineText, line, range) => makeTildeWeft(lineText, line, range, tilde.m) },
  (_probe, lineText, line, range) => makeCodeWeft(lineText, line, range),
)

const proseLine: LineReader = byTypeOr<Probe, Line>()<LoomWeft>(
  { arrow: (arrow, lineText, line, range) => makeArrowWeft(lineText, line, range, arrow.m) },
  (_probe, lineText, line, range) => makeProseWeft(lineText, line, range),
)

const readers: Readonly<Record<Mode, LineReader>> = {
  preamble: preambleLine,
  code: codeLine,
  prose: proseLine,
}

const readerIn = (mode: Mode): LineReader => readers[mode]

const linePos = (line: number, range: LineRange): Position => ({
  start: { line, offset: range[0] },
  end: { line, offset: range[1] },
})

const span = (line: number, start: number, end: number): Position => ({
  start: { line, offset: start },
  end: { line, offset: end },
})

type Mode = 'preamble' | 'code' | 'prose'

const modeAfter: (weft: LoomWeft) => Mode = byType<LoomWeft>()({
  HeadingWeft: () => 'preamble' as const,
  PreambleWeft: () => 'preamble' as const,
  ArrowWeft: () => 'code' as const,
  CodeWeft: () => 'code' as const,
  FenceWeft: () => 'prose' as const,
  TildeWeft: () => 'prose' as const,
  ProseWeft: () => 'prose' as const,
  FrontmatterWeft: () => 'preamble' as const,
  DividerWeft: () => 'preamble' as const,
})

const modeOf = (prev: Option.Option<LoomWeft>): Mode =>
  Option.match(prev, { onNone: () => 'preamble' as const, onSome: modeAfter })

type Probe =
  | { readonly type: 'heading'; readonly m: RegExpMatchArray }
  | { readonly type: 'arrow'; readonly m: RegExpMatchArray }
  | { readonly type: 'tilde'; readonly m: RegExpMatchArray }
  | { readonly type: 'plain' }

const headingProbe = Option.getOrThrow(getProbe(HeadingStartTokenSchema))
const arrowProbe = Option.getOrThrow(getProbe(ArrowTokenSchema))
const tildeProbe = Option.getOrThrow(getProbe(TildeTokenSchema))
const frontmatterFenceProbe = Option.getOrThrow(getProbe(FrontmatterFenceTokenSchema))

const isFrontmatterFence = (lineText: string): boolean => frontmatterFenceProbe.test(lineText)

const dividerProbe = Option.getOrThrow(getProbe(DividerTokenSchema))

const isDivider = (lineText: string): boolean => dividerProbe.test(lineText)

const keepsPreamble = (prev: Option.Option<LoomWeft>): boolean =>
  Option.exists(prev, (weft) => weft.type === 'PreambleWeft')

const isProseWeft = (weft: LoomWeft): boolean =>
  weft.type === 'PreambleWeft' || weft.type === 'ProseWeft' || weft.type === 'TildeWeft'

const nextQuote = (
  quote: Option.Option<Fence>,
  inBox: boolean,
  weft: LoomWeft,
): Option.Option<Fence> =>
  Option.match(quote, {
    onSome: (fence) => (closesFence(fence)(weft.source) ? Option.none() : quote),
    onNone: () => (!inBox && isProseWeft(weft) ? openingFence(weft.source) : Option.none<Fence>()),
  })

const nextFenced = Match.fn((_fenced: Option.Option<Fence>, weft: LoomWeft) => weft).pipe(
  Match.when({ type: 'FenceWeft', side: 'open' }, (open) => openingFence(open.source)),
  Match.when({ type: 'FenceWeft', side: 'close' }, () => Option.none<Fence>()),
  Match.orElse((_weft, fenced) => fenced),
)

const nextAwaiting = byTypeOr<LoomWeft, [awaiting: boolean]>()(
  {
    ArrowWeft: (arrow) => arrow.source.trim() === arrow.arrow.source,
    CodeWeft: (code, awaiting) => awaiting && code.source.trim() === '',
  },
  () => false,
)

const probeOf = (lineText: string): Probe => {
  const h = headingProbe.exec(lineText)
  if (h) return { type: 'heading', m: h }
  const a = arrowProbe.exec(lineText)
  if (a) return { type: 'arrow', m: a }
  const t = tildeProbe.exec(lineText)
  if (t) return { type: 'tilde', m: t }
  return { type: 'plain' }
}

const boxFenceProbe = Option.getOrThrow(getProbe(BoxFenceTokenSchema))

const boxedLine = byTypeOr<LoomWeft, [inBox: boolean]>()(
  {
    PreambleWeft: (line, inBox) => withBox(line, inBox),
    ProseWeft: (line, inBox) => withBox(line, inBox),
  },
  (weft): LoomWeft => weft,
)

const boxed = (weft: LoomWeft, state: ClassifierState): LoomWeft =>
  Option.isSome(state.quote) ? weft : boxedLine(weft, state.inBox)

const withBox = <Line extends PreambleWeft | ProseWeft>(line: Line, inBox: boolean): Line =>
  Option.match(boxLineOf(line, inBox), {
    onNone: () => line,
    onSome: (box) => ({ ...line, box }),
  })

const boxLineOf = (line: PreambleWeft | ProseWeft, inBox: boolean): Option.Option<BoxToken> =>
  Option.map(Option.fromNullishOr(boxFenceProbe.exec(line.source)), (match) => {
    const content = line.source.replace(/\r?\n$/, '')
    const colons = match[0].trimStart()
    const column = match[0].length - colons.length
    const at = (from: number, to: number): Position =>
      span(
        line.position.start.line,
        line.position.start.offset + from,
        line.position.start.offset + to,
      )
    return nodeOf(BoxTokenSchema, {
      position: at(column, content.length),
      source: content.slice(column),
      health: incompleteHealth,
      side: sideOf(colons.length, inBox, content.slice(match[0].length).trim() === ''),
      fence: nodeOf(BoxFenceTokenSchema, {
        position: at(column, match[0].length),
        source: colons,
        health: okHealth,
      }),
    })
  })

const sideOf = Match.fn((colons: number, inBox: boolean, bare: boolean) => ({
  three: colons === 3,
  inBox,
  bare,
})).pipe(
  Match.when({ three: false }, () => 'stray' as const),
  Match.when({ inBox: false }, () => 'open' as const),
  Match.when({ bare: true }, () => 'close' as const),
  Match.orElse(() => 'stray' as const),
)

const discussionLine = /^\s*(Part\s+[^,:]+,\s*)?Discussion(\s+[^:]*)?:/

const namesDiscussion = (lineText: string): boolean => discussionLine.test(lineText)

const discussionWeftOf = byTypeOr<
  Probe,
  [...line: Line, prev: Option.Option<LoomWeft>]
>()<LoomWeft>(
  { tilde: (tilde, lineText, line, range) => makeTildeWeft(lineText, line, range, tilde.m) },
  (_probe, lineText, line, range, prev) =>
    modeOf(prev) === 'preamble'
      ? makePreambleWeft(lineText, line, range)
      : makeProseWeft(lineText, line, range),
)

const makeHeadingWeft = (
  lineText: string,
  line: number,
  range: LineRange,
  m: RegExpMatchArray,
): HeadingWeft =>
  nodeOf(HeadingWeftSchema, {
    position: linePos(line, range),
    source: lineText,
    health: incompleteHealth,
    headingStart: nodeOf(HeadingStartTokenSchema, {
      position: span(line, range[0], range[0] + m[0].length),
      source: m[0],
      health: okHealth,
    }),
  })

const makeArrowWeft = (
  lineText: string,
  line: number,
  range: LineRange,
  m: RegExpMatchArray,
): ArrowWeft => {
  const start = range[0] + m[0].length - 2
  const end = range[0] + m[0].length
  return nodeOf(ArrowWeftSchema, {
    position: linePos(line, range),
    source: lineText,
    health: incompleteHealth,
    arrow: nodeOf(ArrowTokenSchema, {
      position: span(line, start, end),
      source: m[0].slice(-2),
      health: okHealth,
    }),
    anchors: [],
  })
}

const makeTildeWeft = (
  lineText: string,
  line: number,
  range: LineRange,
  m: RegExpMatchArray,
): TildeWeft => {
  const run = /~+$/.exec(m[0])![0]
  const start = range[0] + m[0].length - run.length
  const end = range[0] + m[0].length
  return nodeOf(TildeWeftSchema, {
    position: linePos(line, range),
    source: lineText,
    health: incompleteHealth,
    tilde: nodeOf(TildeTokenSchema, {
      position: span(line, start, end),
      source: run,
      health: okHealth,
    }),
    anchors: [],
  })
}

const makeFenceWeft = (
  lineText: string,
  line: number,
  range: LineRange,
  side: FenceWeft['side'],
): FenceWeft => {
  const fence = Option.getOrElse(openingFence(lineText), () => ({ length: 0, column: 0 }))
  const start = range[0] + fence.column
  return nodeOf(FenceWeftSchema, {
    position: linePos(line, range),
    source: lineText,
    health: incompleteHealth,
    side,
    fence: nodeOf(CodeFenceTokenSchema, {
      position: span(line, start, start + fence.length),
      source: lineText.slice(fence.column, fence.column + fence.length),
      health: okHealth,
    }),
    anchors: [],
  })
}

const makePreambleWeft = (lineText: string, line: number, range: LineRange): PreambleWeft =>
  nodeOf(PreambleWeftSchema, {
    position: linePos(line, range),
    source: lineText,
    health: incompleteHealth,
    warps: [],
    anchors: [],
  })

const makeCodeWeft = (lineText: string, line: number, range: LineRange): CodeWeft =>
  nodeOf(CodeWeftSchema, {
    position: linePos(line, range),
    source: lineText,
    health: incompleteHealth,
    anchors: [],
  })

const makeProseWeft = (lineText: string, line: number, range: LineRange): ProseWeft =>
  nodeOf(ProseWeftSchema, {
    position: linePos(line, range),
    source: lineText,
    health: incompleteHealth,
    anchors: [],
  })

const makeFrontmatterFence = (lineText: string, line: number, range: LineRange): FrontmatterWeft =>
  nodeOf(FrontmatterWeftSchema, {
    position: linePos(line, range),
    source: lineText,
    health: okHealth,
    fence: nodeOf(FrontmatterFenceTokenSchema, {
      position: span(line, range[0], range[0] + 3),
      source: '---',
      health: okHealth,
    }),
  })

const makeFrontmatterField = (lineText: string, line: number, range: LineRange): FrontmatterWeft =>
  nodeOf(FrontmatterWeftSchema, {
    position: linePos(line, range),
    source: lineText,
    health: incompleteHealth,
  })

const makeDividerWeft = (lineText: string, line: number, range: LineRange): DividerWeft =>
  nodeOf(DividerWeftSchema, {
    position: linePos(line, range),
    source: lineText,
    health: okHealth,
    dashes: nodeOf(DividerTokenSchema, {
      position: span(line, range[0], range[0] + lineText.trimEnd().length),
      source: lineText.trimEnd(),
      health: okHealth,
    }),
  })
