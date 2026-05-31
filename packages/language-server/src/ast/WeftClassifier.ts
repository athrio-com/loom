import { Effect, Match, Option, Stream, pipe } from 'effect'
import type { LineRange } from './LineRanges'
import { incompleteHealth, okHealth, type Position } from './LoomNode'
import {
  ArrowTokenSchema,
  HeadingStartTokenSchema,
  TildeTokenSchema,
  getProbe,
} from './LoomTokens'
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
} from './Weft'

// =============================================================================
// WeftClassifier — the Classifier Stage of the parse pipeline.
//
// The classifier is a Mealy machine: state is the previously emitted Weft plus
// whether a heading has been seen; input is a pattern probe of the current
// line; output is the next Weft, which also feeds the next state.
//
// Stream.mapAccum carries that state; line numbers derive from
// previousWeft.position.end.line + 1.
//
// Output Wefts are partially populated: the leading token is filled
// (headingStart, arrow, tilde) and the weft carries `incompleteHealth`.
// Sub-token expansion (texts[], tag, specifier, code?, prose?) happens in the
// Tokeniser Stage. There is one heading shape: every `#{1,6}` line is a
// HeadingWeft regardless of level or tag content. The de-dicto (frame) vs
// de-re (product) distinction rides on the Specifier token at Synth time.
// =============================================================================

// The classifier opens before the first heading (the Document Preamble) and
// tracks whether a heading has been emitted; the Document Preamble admits no
// Arrow / Tilde transitions, so its lines are all PreambleWefts.
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

// =============================================================================
// Two enumerable axes:
//   Mode  ∈ { preamble | code | prose }
//   Probe ∈ { heading | arrow | tilde | plain }
//
// Decision table (priority top-to-bottom):
//                    heading  arrow    tilde    plain
//   preamble         Heading  Arrow    Tilde    Preamble
//   code             Heading  Code     Tilde    Code
//   prose            Heading  Prose    Prose    Prose
//
// The heading column is mode-independent — one probe for `#{1,6}` — handled
// with an early return that opens the new Section's body in `preamble` mode.
// Before the first heading (the Document Preamble) every non-heading line is a
// PreambleWeft: Arrow / Tilde transitions begin only within a Section.
// Everything below dispatches on Mode (outer Match.exhaustive); transitional
// cells (Arrow / Tilde columns in the preamble and code rows) narrow on
// probe.kind inside the row.
// =============================================================================

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

  // Mode-independent: a heading opens a new Section whose body starts in
  // preamble mode.
  if (probe.kind === 'heading')
    return makeHeadingWeft(lineText, line, range, probe.m)

  // Document Preamble: before the first heading, every non-heading line is a
  // PreambleWeft. No Arrow / Tilde transition fires here.
  if (!state.seenHeading)
    return PreambleWeftSchema.make({
      position,
      source: lineText,
      health: incompleteHealth,
      warps: [],
    })

  // Mode-driven dispatch — one row per Mode. The preamble and code rows narrow
  // on probe.kind for their transitional cells.
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
    // CodeWeft — line content is opaque to Loom (embedded-language
    // tokenisation happens elsewhere), but the Tokeniser still scans for
    // `{{name}}` anchors and settles health accordingly.
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
      ProseWeftSchema.make({
        position,
        source: lineText,
        health: incompleteHealth,
      }),
    ),
    Match.exhaustive,
  )
}

// =============================================================================
// Position helpers.
// =============================================================================

const linePos = (line: number, range: LineRange): Position => ({
  start: { line, offset: range[0] },
  end: { line, offset: range[1] },
})

const span = (line: number, start: number, end: number): Position => ({
  start: { line, offset: start },
  end: { line, offset: end },
})

// =============================================================================
// Mode — the state axis. Derived from the previous Weft's type. Consulted only
// after the first heading; the Document Preamble is handled by the
// `seenHeading` guard before this runs.
// =============================================================================

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

// =============================================================================
// Probe — the input axis. Pure pattern recognition over the line text. No
// awareness of mode; downstream decides whether a probe outcome is meaningful
// in the current state.
// =============================================================================

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

// =============================================================================
// Heading-weft constructor.
//
// The Classifier fills the leading marker token (`headingStart`) with okHealth
// from source and leaves `tag` / `specifier` absent — both are optional, and
// the Tokeniser fills whatever the source supplies (synthesising a hash-
// derived tag when the heading carries none). The weft itself carries
// `incompleteHealth`; the Tokeniser settles it.
// =============================================================================

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
      // probe /^#{1,6} / — the whole match (hashes + mandatory space) is the marker.
      position: span(line, range[0], range[0] + m[0].length),
      source: m[0],
      health: okHealth,
    }),
    // `title`, `tag`, `specifier` are all optional and filled by the
    // Tokeniser; the Classifier emits the heading shell only.
  })

// =============================================================================
// Transition-weft constructors — fill the leading marker token.
// =============================================================================

const makeArrowWeft = (
  lineText: string,
  line: number,
  range: LineRange,
  m: RegExpMatchArray,
): ArrowWeft => {
  // probe /^\s*=>/ — `=>` is the last 2 chars of m[0]
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
  // probe /^\s*~+/ — trailing run of tildes lies at the end of m[0]
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
