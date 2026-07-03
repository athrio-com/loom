import { Effect, Match, Option, Stream, pipe } from 'effect'
import type { LineRange } from './LineRanges'
import { incompleteHealth, okHealth, type Position } from '@athrio/loom-ast/LoomNode'
import {
  ArrowTokenSchema,
  FrontmatterFenceTokenSchema,
  HeadingStartTokenSchema,
  TildeTokenSchema,
  getProbe,
} from '@athrio/loom-ast/LoomTokens'
import {
  type ArrowWeft,
  ArrowWeftSchema,
  type CodeWeft,
  CodeWeftSchema,
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
  type TocWeft,
  TocWeftSchema,
} from '@athrio/loom-ast/Weft'

type ClassifierState = {
  readonly prev: Option.Option<LoomWeft>
  readonly seenHeading: boolean
  readonly inFrontmatter: boolean
  readonly inToc: boolean
  readonly inFence: boolean
}

const initialState: ClassifierState = {
  prev: Option.none(),
  seenHeading: false,
  inFrontmatter: false,
  inToc: false,
  inFence: false,
}

export class WeftClassifier extends Effect.Service<WeftClassifier>()(
  'WeftClassifier',
  {
    succeed: {
      classifyWefts:
        (text: string) =>
        (source: Stream.Stream<LineRange>): Stream.Stream<LoomWeft> =>
          Stream.mapAccum(source, initialState, (state, range) => {
            const lineText = text.slice(range[0], range[1])
            const weft = probeWeft(lineText, range, state)
            const frontmatterFence =
              weft.type === 'FrontmatterWeft' && weft.fence !== undefined
            const next: ClassifierState = {
              prev: Option.some(weft),
              seenHeading: state.seenHeading || weft.type === 'HeadingWeft',
              inFrontmatter: state.inFrontmatter !== frontmatterFence,
              inToc:
                weft.type === 'HeadingWeft'
                  ? isTocHeading(lineText)
                  : state.inToc,
              inFence: nextFence(state.inFence, weft),
            }
            return [next, weft]
          }),
    },
  },
) {}

const probeWeft = (
  lineText: string,
  range: LineRange,
  state: ClassifierState,
): LoomWeft => {
  const line = Option.match(state.prev, {
    onNone: () => 1,
    onSome: (w) => w.position.end.line + 1,
  })

  if (Option.isNone(state.prev) && isFrontmatterFence(lineText))
    return makeFrontmatterFence(lineText, line, range)

  if (state.inFrontmatter) {
    if (isFrontmatterFence(lineText))
      return makeFrontmatterFence(lineText, line, range)
    return makeFrontmatterField(lineText, line, range)
  }

  if (state.inFence)
    return state.seenHeading
      ? makeProseWeft(lineText, line, range)
      : makePreambleWeft(lineText, line, range)

  const probe = probeOf(lineText)

  if (probe.kind === 'heading') {
    if (state.inToc && headingLevel(probe.m) > 1)
      return makeTocWeft(lineText, line, range)
    return makeHeadingWeft(lineText, line, range, probe.m)
  }

  if (state.inToc) return makeTocWeft(lineText, line, range)

  if (!state.seenHeading) return makePreambleWeft(lineText, line, range)

  return pipe(
    Match.value(modeOf(state.prev)),
    Match.when('preamble', () =>
      pipe(
        Match.value(probe),
        Match.when({ kind: 'arrow' }, (p) =>
          makeArrowWeft(lineText, line, range, p.m),
        ),
        Match.when({ kind: 'tilde' }, (p) =>
          makeTildeWeft(lineText, line, range, p.m),
        ),
        Match.orElse(() => makePreambleWeft(lineText, line, range)),
      ),
    ),
    Match.when('code', () =>
      pipe(
        Match.value(probe),
        Match.when({ kind: 'tilde' }, (p) =>
          makeTildeWeft(lineText, line, range, p.m),
        ),
        Match.orElse(() => makeCodeWeft(lineText, line, range)),
      ),
    ),
    Match.when('prose', () =>
      pipe(
        Match.value(probe),
        Match.when({ kind: 'arrow' }, (p) =>
          makeArrowWeft(lineText, line, range, p.m),
        ),
        Match.orElse(() => makeProseWeft(lineText, line, range)),
      ),
    ),
    Match.exhaustive,
  )
}

const linePos = (line: number, range: LineRange): Position => ({
  start: { line, offset: range[0] },
  end: { line, offset: range[1] },
})

const span = (line: number, start: number, end: number): Position => ({
  start: { line, offset: start },
  end: { line, offset: end },
})

type Mode = 'preamble' | 'code' | 'prose'

const modeOf = (prev: Option.Option<LoomWeft>): Mode =>
  Option.match(prev, {
    onNone: () => 'preamble' as const,
    onSome: (w) =>
      pipe(
        Match.value(w),
        Match.when({ type: 'HeadingWeft' }, () => 'preamble' as const),
        Match.when({ type: 'PreambleWeft' }, () => 'preamble' as const),
        Match.when({ type: 'ArrowWeft' }, () => 'code' as const),
        Match.when({ type: 'CodeWeft' }, () => 'code' as const),
        Match.when({ type: 'TildeWeft' }, () => 'prose' as const),
        Match.when({ type: 'ProseWeft' }, () => 'prose' as const),
        Match.when({ type: 'FrontmatterWeft' }, () => 'preamble' as const),
        Match.when({ type: 'TocWeft' }, () => 'preamble' as const),
        Match.exhaustive,
      ),
  })

type Probe =
  | { readonly kind: 'heading'; readonly m: RegExpMatchArray }
  | { readonly kind: 'arrow'; readonly m: RegExpMatchArray }
  | { readonly kind: 'tilde'; readonly m: RegExpMatchArray }
  | { readonly kind: 'plain' }

const headingProbe = Option.getOrThrow(getProbe(HeadingStartTokenSchema))
const arrowProbe = Option.getOrThrow(getProbe(ArrowTokenSchema))
const tildeProbe = Option.getOrThrow(getProbe(TildeTokenSchema))
const frontmatterFenceProbe = Option.getOrThrow(
  getProbe(FrontmatterFenceTokenSchema),
)

const isFrontmatterFence = (lineText: string): boolean =>
  frontmatterFenceProbe.test(lineText)

const isCodeFence = (source: string): boolean => /^\s*```/.test(source)

const isProseWeft = (weft: LoomWeft): boolean =>
  weft.type === 'PreambleWeft' ||
  weft.type === 'ProseWeft' ||
  weft.type === 'TildeWeft'

const nextFence = (inFence: boolean, weft: LoomWeft): boolean =>
  inFence
    ? !isCodeFence(weft.source)
    : isProseWeft(weft) && isCodeFence(weft.source)

const headingLevel = (m: RegExpMatchArray): number =>
  m[0].replace(/[^#]/g, '').length

const tocSpecifier = /\{TOC\}/i

const isTocHeading = (lineText: string): boolean => tocSpecifier.test(lineText)

const probeOf = (lineText: string): Probe => {
  const h = headingProbe.exec(lineText)
  if (h) return { kind: 'heading', m: h }
  const a = arrowProbe.exec(lineText)
  if (a) return { kind: 'arrow', m: a }
  const t = tildeProbe.exec(lineText)
  if (t) return { kind: 'tilde', m: t }
  return { kind: 'plain' }
}

const makeHeadingWeft = (
  lineText: string,
  line: number,
  range: LineRange,
  m: RegExpMatchArray,
): HeadingWeft =>
  HeadingWeftSchema.make({
    position: linePos(line, range),
    source: lineText,
    health: incompleteHealth,
    headingStart: HeadingStartTokenSchema.make({
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
  return ArrowWeftSchema.make({
    position: linePos(line, range),
    source: lineText,
    health: incompleteHealth,
    arrow: ArrowTokenSchema.make({
      position: span(line, start, end),
      source: '=>',
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
  return TildeWeftSchema.make({
    position: linePos(line, range),
    source: lineText,
    health: incompleteHealth,
    tilde: TildeTokenSchema.make({
      position: span(line, start, end),
      source: run,
      health: okHealth,
    }),
    anchors: [],
  })
}

const makePreambleWeft = (
  lineText: string,
  line: number,
  range: LineRange,
): PreambleWeft =>
  PreambleWeftSchema.make({
    position: linePos(line, range),
    source: lineText,
    health: incompleteHealth,
    warps: [],
    anchors: [],
  })

const makeCodeWeft = (
  lineText: string,
  line: number,
  range: LineRange,
): CodeWeft =>
  CodeWeftSchema.make({
    position: linePos(line, range),
    source: lineText,
    health: incompleteHealth,
    anchors: [],
  })

const makeProseWeft = (
  lineText: string,
  line: number,
  range: LineRange,
): ProseWeft =>
  ProseWeftSchema.make({
    position: linePos(line, range),
    source: lineText,
    health: incompleteHealth,
    anchors: [],
  })

const makeFrontmatterFence = (
  lineText: string,
  line: number,
  range: LineRange,
): FrontmatterWeft =>
  FrontmatterWeftSchema.make({
    position: linePos(line, range),
    source: lineText,
    health: okHealth,
    fence: FrontmatterFenceTokenSchema.make({
      position: span(line, range[0], range[0] + 3),
      source: '---',
      health: okHealth,
    }),
  })

const makeFrontmatterField = (
  lineText: string,
  line: number,
  range: LineRange,
): FrontmatterWeft =>
  FrontmatterWeftSchema.make({
    position: linePos(line, range),
    source: lineText,
    health: incompleteHealth,
  })

const makeTocWeft = (
  lineText: string,
  line: number,
  range: LineRange,
): TocWeft =>
  TocWeftSchema.make({
    position: linePos(line, range),
    source: lineText,
    health: incompleteHealth,
  })
