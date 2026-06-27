import { Effect, Match, Option, Stream, pipe } from 'effect'
import type { LineRange } from './LineRanges'
import { incompleteHealth, okHealth, type Position } from '@athrio/loom-ast/LoomNode'
import {
  ArrowTokenSchema,
  HeadingStartTokenSchema,
  TildeTokenSchema,
  getProbe,
} from '@athrio/loom-ast/LoomTokens'
import {
  type ArrowWeft,
  ArrowWeftSchema,
  CodeWeftSchema,
  type HeadingWeft,
  HeadingWeftSchema,
  type LoomWeft,
  PreambleWeftSchema,
  ProseWeftSchema,
  type TildeWeft,
  TildeWeftSchema,
} from '@athrio/loom-ast/Weft'

type ClassifierState = {
  readonly prev: Option.Option<LoomWeft>
  readonly seenHeading: boolean
}

const initialState: ClassifierState = {
  prev: Option.none(),
  seenHeading: false,
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
            const next: ClassifierState = {
              prev: Option.some(weft),
              seenHeading: state.seenHeading || weft.type === 'HeadingWeft',
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
  const probe = probeOf(lineText)
  const position = linePos(line, range)

  if (probe.kind === 'heading')
    return makeHeadingWeft(lineText, line, range, probe.m)

  if (!state.seenHeading)
    return PreambleWeftSchema.make({
      position,
      source: lineText,
      health: incompleteHealth,
      warps: [],
    })

  return pipe(
    Match.value(modeOf(state.prev)),
    Match.when('preamble', () =>
      probe.kind === 'arrow'
        ? makeArrowWeft(lineText, line, range, probe.m)
        : probe.kind === 'tilde'
          ? makeTildeWeft(lineText, line, range, probe.m)
          : PreambleWeftSchema.make({
              position,
              source: lineText,
              health: incompleteHealth,
              warps: [],
            }),
    ),
    Match.when('code', () =>
      probe.kind === 'tilde'
        ? makeTildeWeft(lineText, line, range, probe.m)
        : CodeWeftSchema.make({
            position,
            source: lineText,
            health: incompleteHealth,
            anchors: [],
          }),
    ),
    Match.when('prose', () =>
      probe.kind === 'arrow'
        ? makeArrowWeft(lineText, line, range, probe.m)
        : ProseWeftSchema.make({
            position,
            source: lineText,
            health: incompleteHealth,
          }),
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
  })
}
