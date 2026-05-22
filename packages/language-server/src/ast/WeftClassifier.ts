import { Effect, Match, Option, Stream, pipe } from "effect"
import type { LineRange } from "./LineRanges"
import { incompleteHealth, okHealth, type Position } from "./LoomNode"
import {
  ArrowTokenSchema,
  ChapterHeadingStartTokenSchema,
  SectionHeadingStartTokenSchema,
  SpecifierCloseTokenSchema,
  SpecifierLabelTokenSchema,
  SpecifierOpenTokenSchema,
  SpecifierTokenSchema,
  TagCloseTokenSchema,
  TagLabelTokenSchema,
  TagOpenTokenSchema,
  TagTokenSchema,
  TildeTokenSchema,
  getProbe,
  type TagToken,
} from "./LoomTokens"
import {
  type ArrowWeft,
  ArrowWeftSchema,
  type ChapterHeadingWeft,
  ChapterHeadingWeftSchema,
  type CodeWeft,
  CodeWeftSchema,
  type LoomWeft,
  type PreambleWeft,
  PreambleWeftSchema,
  type ProseWeft,
  ProseWeftSchema,
  type SectionHeadingWeft,
  SectionHeadingWeftSchema,
  type TildeWeft,
  TildeWeftSchema,
  type Weft,
  WeftSchema,
} from "./Weft"

// =============================================================================
// WeftClassifier — the Classifier Stage of the parse pipeline.
//
// The classifier is a Mealy machine: state (Mode) is derived from the previous
// Weft; input is a pattern probe of the current line; output is the next Weft,
// which is also the next state.
//
// Stream.mapAccum carries the previously emitted Weft as Option<LoomWeft>;
// line numbers derive from previousWeft.position.end.line + 1.
//
// Output Wefts are partially populated: the leading token is filled
// (headingStart, arrow, tilde) and the weft carries `incompleteHealth`.
// Sub-token expansion (texts[], tags, specifier, code?, prose?) and any
// promotion of SectionHeadingWeft to DependenciesHeadingWeft or
// TangleHeadingWeft happens in the Tokeniser Stage. The Classifier Stage
// never emits DependenciesHeadingWeft or TangleHeadingWeft directly.
// =============================================================================

// The subset of LoomWeft the Classifier Stage can actually emit. Deps/Tangle
// heading and body wefts are the Tokeniser Stage's responsibility (promotion
// happens at tokenisation when the singular `tag` field can be filled with
// `[D]` / `[T]`). Narrowing here makes the unreachable Match branches in
// modeOf / probeWeft disappear by construction.
type ClassifierStageWeft =
  | Weft
  | ChapterHeadingWeft
  | SectionHeadingWeft
  | PreambleWeft
  | CodeWeft
  | ProseWeft
  | ArrowWeft
  | TildeWeft

export class WeftClassifier extends Effect.Service<WeftClassifier>()(
  "WeftClassifier",
  {
    succeed: {
      classifyWefts:
        (text: string) =>
          (source: Stream.Stream<LineRange>): Stream.Stream<LoomWeft> =>
            Stream.mapAccum(
              source,
              Option.none<ClassifierStageWeft>(),
              (prev, range) => {
                const lineText = text.slice(range[0], range[1])
                const weft = probeWeft(lineText, range, prev)
                return [Option.some(weft), weft]
              },
            ),
    },
  },
) { }

// =============================================================================
// Two enumerable axes:
//   Mode  ∈ { orphan | preamble | code | prose | dependency | tangle }
//   Probe ∈ { chapter | section | arrow | tilde | plain }
//
// Decision table (priority top-to-bottom):
//                    chapter  section  arrow    tilde    plain
//   orphan           Chap     Sect     Weft     Weft     Weft
//   preamble         Chap     Sect     Arrow    Tilde    Preamble
//   code             Chap     Sect     Code     Tilde    Code
//   prose            Chap     Sect     Prose    Prose    Prose
//   dependency       Chap     Sect     Dep      Dep      Dep
//   tangle           Chap     Sect     Tng      Tng      Tng
//
// The Classifier Stage never discriminates [D]/[T] section headings — every
// `##…` line becomes a plain SectionHeadingWeft. The Tokeniser Stage tokenises
// tags/specifiers and promotes Section → Deps/Tangle when the singular `tag`
// field can be filled with `[D]` / `[T]`; schema validation drives that
// promotion and surfaces rule violations (multi-tag, etc.) as `error` health
// on the weft.
//
// The chapter and section columns are mode-independent — handled with early
// returns before the Match. Everything below dispatches on Mode (outer
// Match.exhaustive); transitional cells (Arrow/Tilde columns in preamble and
// code rows) narrow on probe.kind inside the row.
// =============================================================================

const probeWeft = (
  lineText: string,
  range: LineRange,
  prev: Option.Option<ClassifierStageWeft>,
): ClassifierStageWeft => {
  const line = Option.match(prev, {
    onNone: () => 1,
    onSome: (w) => w.position.end.line + 1,
  })
  const mode = modeOf(prev)
  const probe = probeOf(lineText)
  const position = linePos(line, range)

  // Mode-independent columns
  if (probe.kind === "chapter") return makeChapterHeadingWeft(line, range)
  if (probe.kind === "section") return makeSectionHeadingWeft(line, range, probe.sect)

  // Mode-driven dispatch — one row per Mode. The preamble and code rows
  // narrow on probe.kind for their transitional cells.
  return pipe(
    Match.value(mode),
    // Pre-chapter Weft — terminal, no Tokeniser Stage processing expected.
    Match.when("orphan", () => WeftSchema.make({ position, health: okHealth })),
    Match.when("preamble", () =>
      probe.kind === "arrow" ? makeArrowWeft(line, range, probe.m)
        : probe.kind === "tilde" ? makeTildeWeft(line, range, probe.m)
          : PreambleWeftSchema.make({ position, health: incompleteHealth }),
    ),
    // CodeWeft — opaque to Loom per spec; embedded-language tokenisation is
    // handled outside the AST pipeline, so the weft is structurally final.
    Match.when("code", () =>
      probe.kind === "tilde" ? makeTildeWeft(line, range, probe.m)
        : CodeWeftSchema.make({ position, health: okHealth }),
    ),
    Match.when("prose", () => ProseWeftSchema.make({ position, health: incompleteHealth })),
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
// Mode — the state axis. Derived from the previous Weft's type.
// =============================================================================

type Mode = "orphan" | "preamble" | "code" | "prose"

const modeOf = (prev: Option.Option<ClassifierStageWeft>): Mode =>
  Option.match(prev, {
    onNone: () => "orphan" as const,
    onSome: (w) => pipe(
      Match.value(w),
      Match.when({ type: "ChapterHeadingWeft" }, () => "preamble" as const),
      Match.when({ type: "SectionHeadingWeft" }, () => "preamble" as const),
      Match.when({ type: "PreambleWeft" }, () => "preamble" as const),
      Match.when({ type: "ArrowWeft" }, () => "code" as const),
      Match.when({ type: "CodeWeft" }, () => "code" as const),
      Match.when({ type: "TildeWeft" }, () => "prose" as const),
      Match.when({ type: "ProseWeft" }, () => "prose" as const),
      Match.when({ type: "Weft" }, () => "orphan" as const),
      Match.exhaustive,
    ),
  })

// =============================================================================
// Probe — the input axis. Pure pattern recognition over the line text. No
// awareness of mode; downstream decides whether a probe outcome is meaningful
// in the current state.
// =============================================================================

type Probe =
  | { readonly kind: "chapter" }
  | { readonly kind: "section"; readonly sect: RegExpMatchArray }
  | { readonly kind: "arrow"; readonly m: RegExpMatchArray }
  | { readonly kind: "tilde"; readonly m: RegExpMatchArray }
  | { readonly kind: "plain" }

const chapterProbe = Option.getOrThrow(getProbe(ChapterHeadingStartTokenSchema))
const sectionProbe = Option.getOrThrow(getProbe(SectionHeadingStartTokenSchema))
const arrowProbe = Option.getOrThrow(getProbe(ArrowTokenSchema))
const tildeProbe = Option.getOrThrow(getProbe(TildeTokenSchema))

const probeOf = (lineText: string): Probe => {
  const ch = chapterProbe.exec(lineText)
  if (ch) return { kind: "chapter" }
  const sect = sectionProbe.exec(lineText)
  if (sect) return { kind: "section", sect }
  const a = arrowProbe.exec(lineText)
  if (a) return { kind: "arrow", m: a }
  const t = tildeProbe.exec(lineText)
  if (t) return { kind: "tilde", m: t }
  return { kind: "plain" }
}

// =============================================================================
// Heading-weft constructors.
//
// Real subtokens parsed from source carry okHealth (headingStart, discriminator
// tags). NOK placeholder subtokens stand in for fields a downstream stage is
// expected to fill (chapter tag/specifier) — they satisfy schema filters
// structurally while their `health.status === "incomplete"` communicates that
// they are stand-ins. Placeholders take a zero-width position at the end of
// the heading line so they map to no real source span.
//
// The weft itself carries incompleteHealth while subnode tokenisation is
// pending. The Tokeniser Stage promotes the weft to okHealth (or errorHealth)
// once it has either filled the real tokens or determined that they are
// missing.
// =============================================================================

const nokTagToken = (line: number, range: LineRange): TagToken => {
  const eol = span(line, range[1], range[1])
  return TagTokenSchema.make({
    position: eol,
    health: incompleteHealth,
    open: TagOpenTokenSchema.make({ position: eol, health: incompleteHealth, value: "[" }),
    label: TagLabelTokenSchema.make({ position: eol, health: incompleteHealth, value: "" }),
    close: TagCloseTokenSchema.make({ position: eol, health: incompleteHealth, value: "]" }),
  })
}

const nokSpecifierToken = (line: number, range: LineRange) => {
  const eol = span(line, range[1], range[1])
  return SpecifierTokenSchema.make({
    position: eol,
    health: incompleteHealth,
    open: SpecifierOpenTokenSchema.make({ position: eol, health: incompleteHealth, value: "{" }),
    label: SpecifierLabelTokenSchema.make({ position: eol, health: incompleteHealth, value: "" }),
    close: SpecifierCloseTokenSchema.make({ position: eol, health: incompleteHealth, value: "}" }),
  })
}

const makeChapterHeadingWeft = (line: number, range: LineRange): ChapterHeadingWeft =>
  ChapterHeadingWeftSchema.make({
    type: "ChapterHeadingWeft",
    position: linePos(line, range),
    health: incompleteHealth,
    headingStart: ChapterHeadingStartTokenSchema.make({
      position: span(line, range[0], range[0] + 1),
      health: okHealth,
      value: "#",
    }),
    texts: [],
    tag: nokTagToken(line, range),
    specifier: nokSpecifierToken(line, range),
  })

const sectionHeadingStart = (line: number, range: LineRange, m: RegExpMatchArray) => {
  // probe /^#{2,6} / — marker is m[0] minus the trailing space
  const len = m[0].length - 1
  return SectionHeadingStartTokenSchema.make({
    position: span(line, range[0], range[0] + len),
    health: okHealth,
    value: m[0].slice(0, len),
  })
}

const makeSectionHeadingWeft = (
  line: number, range: LineRange, m: RegExpMatchArray,
): SectionHeadingWeft =>
  SectionHeadingWeftSchema.make({
    position: linePos(line, range),
    health: incompleteHealth,
    headingStart: sectionHeadingStart(line, range, m),
    texts: [],
  })

// =============================================================================
// Transition-weft constructors — fill the leading marker token.
// =============================================================================

const makeArrowWeft = (line: number, range: LineRange, m: RegExpMatchArray): ArrowWeft => {
  // probe /^\s*=>/ — `=>` is the last 2 chars of m[0]
  const start = range[0] + m[0].length - 2
  const end = range[0] + m[0].length
  return ArrowWeftSchema.make({
    position: linePos(line, range),
    health: incompleteHealth,
    arrow: ArrowTokenSchema.make({ position: span(line, start, end), health: okHealth }),
  })
}

const makeTildeWeft = (line: number, range: LineRange, m: RegExpMatchArray): TildeWeft => {
  // probe /^\s*~+/ — trailing run of tildes lies at the end of m[0]
  const run = /~+$/.exec(m[0])![0]
  const start = range[0] + m[0].length - run.length
  const end = range[0] + m[0].length
  return TildeWeftSchema.make({
    position: linePos(line, range),
    health: incompleteHealth,
    tilde: TildeTokenSchema.make({ position: span(line, start, end), health: okHealth }),
  })
}
