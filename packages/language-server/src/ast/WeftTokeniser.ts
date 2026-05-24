import { Effect, Either, Match, Option, ParseResult, Schema, Stream, pipe } from "effect"
import {
  okHealth,
  type Health,
  type Position,
  type UnexpectedToken,
  UnexpectedTokenSchema,
} from "./LoomNode"
import {
  CodeTokenSchema,
  ProseTokenSchema,
  SpecifierCloseTokenSchema,
  SpecifierLabelTokenSchema,
  SpecifierOpenTokenSchema,
  SpecifierTokenSchema,
  TagCloseTokenSchema,
  TagLabelTokenSchema,
  TagOpenTokenSchema,
  TagTokenSchema,
  TextTokenSchema,
  getProbe,
  type SpecifierCloseToken,
  type SpecifierLabelToken,
  type SpecifierOpenToken,
  type SpecifierToken,
  type TagCloseToken,
  type TagLabelToken,
  type TagOpenToken,
  type TagToken,
  type TextToken,
} from "./LoomTokens"
import {
  type ArrowWeft,
  ArrowWeftSchema,
  ChapterHeadingWeftSchema,
  type LoomWeft,
  type PreambleWeft,
  PreambleWeftSchema,
  type ProseWeft,
  ProseWeftSchema,
  SectionHeadingWeftSchema,
  type ChapterHeadingWeft,
  type SectionHeadingWeft,
  type TildeWeft,
  TildeWeftSchema,
} from "./Weft"

// =============================================================================
// WeftTokeniser — the Tokeniser Stage of the parse pipeline.
//
// Pure Stream.map: per-weft transformation. The Tokeniser fills subtokens
// per weft kind:
//
//   ChapterHeading   — full tokenisation (tag/specifier/texts), synthesising
//                      error-health placeholders for missing required fields.
//   SectionHeading   — full tokenisation (tag/specifier/texts); absences are
//                      not errors.
//   Arrow / Tilde    — fill the optional inline `code` / `prose` subtoken.
//   Preamble / Prose — settle health to `ok`; inner-token expansion belongs
//                      to the Synth phase.
//   Weft / CodeWeft  — passthrough; already `okHealth` from the Classifier.
//
// Post-Tokeniser invariant: no weft remains `incomplete`.
// =============================================================================

export class WeftTokeniser extends Effect.Service<WeftTokeniser>()(
  "WeftTokeniser",
  {
    succeed: {
      tokeniseWefts:
        (text: string) =>
          (source: Stream.Stream<LoomWeft>): Stream.Stream<LoomWeft> =>
            Stream.map(source, (weft) => tokeniseWeft(text, weft)),
    },
  },
) { }

const tokeniseWeft = (text: string, weft: LoomWeft): LoomWeft =>
  pipe(
    Match.value(weft),
    Match.when({ type: "ChapterHeadingWeft" }, (w) => tokeniseChapterHeading(text, w)),
    Match.when({ type: "SectionHeadingWeft" }, (w) => tokeniseSectionHeading(text, w)),
    Match.when({ type: "ArrowWeft" }, (w) => tokeniseArrow(text, w)),
    Match.when({ type: "TildeWeft" }, (w) => tokeniseTilde(text, w)),
    Match.when({ type: "PreambleWeft" }, (w) => tokenisePreamble(w)),
    Match.when({ type: "ProseWeft" }, (w) => tokeniseProse(w)),
    // Terminal kinds — already okHealth from the Classifier.
    Match.when({ type: "Weft" }, (w) => w),
    Match.when({ type: "CodeWeft" }, (w) => w),
    Match.exhaustive,
  )

// =============================================================================
// Body wefts — Arrow/Tilde get their optional inline subtokens; Preamble /
// Prose are structural-final at this stage so we just flip health to ok.
//
// The Code/Prose Probes (defined on CodeTokenSchema / ProseTokenSchema) use
// lookbehind to anchor at the position after the leading marker, so the
// match offset is where the inline content actually begins.
// =============================================================================

const codeProbe = Option.getOrThrow(getProbe(CodeTokenSchema))
const proseProbe = Option.getOrThrow(getProbe(ProseTokenSchema))

const inlineAfter = <T>(
  schema: Schema.Schema<T, any, never>,
  probe: RegExp,
  text: string,
  linePosition: Position,
): Option.Option<T> => {
  const lineStart = linePosition.start.offset
  const lineText = text.slice(lineStart, linePosition.end.offset)
  const m = probe.exec(lineText)
  if (!m || m.index === undefined) return Option.none()
  const start = lineStart + m.index
  return Option.some(
    (schema as any).make({
      position: span(linePosition.start.line, start, start + m[0].length),
      health: okHealth,
    }),
  )
}

const tokeniseArrow = (text: string, weft: ArrowWeft): LoomWeft => {
  const code = inlineAfter(CodeTokenSchema, codeProbe, text, weft.position)
  return ArrowWeftSchema.make({
    position: weft.position,
    health: okHealth,
    arrow: weft.arrow,
    code: Option.getOrUndefined(code),
  })
}

const tokeniseTilde = (text: string, weft: TildeWeft): LoomWeft => {
  const prose = inlineAfter(ProseTokenSchema, proseProbe, text, weft.position)
  return TildeWeftSchema.make({
    position: weft.position,
    health: okHealth,
    tilde: weft.tilde,
    prose: Option.getOrUndefined(prose),
  })
}

const tokenisePreamble = (weft: PreambleWeft): LoomWeft =>
  PreambleWeftSchema.make({ position: weft.position, health: okHealth })

const tokeniseProse = (weft: ProseWeft): LoomWeft =>
  ProseWeftSchema.make({ position: weft.position, health: okHealth })

// =============================================================================
// Health — status lattice + monoid fold over a flat list of statuses.
// Caller decides which subnodes to include.
//   ok < incomplete < warning < error
// =============================================================================

const statusRank: Record<Health["status"], number> = {
  ok: 0,
  incomplete: 1,
  warning: 2,
  error: 3,
}

const joinStatus = (a: Health["status"], b: Health["status"]): Health["status"] =>
  statusRank[a] >= statusRank[b] ? a : b

const aggregateStatus = (statuses: ReadonlyArray<Health["status"]>): Health["status"] =>
  statuses.reduce(joinStatus, "ok" as Health["status"])

// =============================================================================
// Position helpers + synthetic-error close health.
// =============================================================================

const span = (line: number, start: number, end: number): Position => ({
  start: { line, offset: start },
  end: { line, offset: end },
})

const missingClosing = (line: number, lineEnd: number, expected: "]" | "}"): Health => ({
  status: "error",
  diagnostics: [{
    message: `expected closing \`${expected}\``,
    position: span(line, lineEnd, lineEnd),
    severity: "error",
  }],
})

// =============================================================================
// errorToHealth — adapt a `Schema` ParseError into a `Health` with
// `status: "error"` and one Diagnostic per issue the formatter produces.
// Used on the rejection path when source content fails a schema filter but
// the Tokeniser still wants to keep the offending text in the AST.
// =============================================================================

const errorToHealth = (err: ParseResult.ParseError, position: Position): Health => ({
  status: "error",
  diagnostics: ParseResult.ArrayFormatter.formatErrorSync(err).map((issue) => ({
    message: issue.message,
    position,
    severity: "error" as const,
  })),
})

// =============================================================================
// buildTagLabel / buildSpecifierLabel — try the strict schema first. If the
// pattern rejects, build a schema-valid label with the synthetic empty value
// (so the strict schema accepts it) and stash the rejected source text as an
// UnexpectedToken on the label's `unexpected[]` field. Health flips to error
// with the ParseError-derived diagnostics. Strict validation stays on; no
// `disableValidation` bypass needed.
// =============================================================================

const decodeTagLabel = Schema.decodeUnknownEither(TagLabelTokenSchema)
const decodeSpecifierLabel = Schema.decodeUnknownEither(SpecifierLabelTokenSchema)

const buildTagLabel = (value: string, position: Position): TagLabelToken =>
  pipe(
    decodeTagLabel({ type: "TagLabel", position, health: okHealth, value }),
    Either.getOrElse((e) =>
      TagLabelTokenSchema.make({
        type: "TagLabel",
        position,
        health: errorToHealth(e, position),
        value: "",
        unexpected: [UnexpectedTokenSchema.make({ position, value })],
      }),
    ),
  )

const buildSpecifierLabel = (value: string, position: Position): SpecifierLabelToken =>
  pipe(
    decodeSpecifierLabel({ type: "SpecifierLabel", position, health: okHealth, value }),
    Either.getOrElse((e) =>
      SpecifierLabelTokenSchema.make({
        type: "SpecifierLabel",
        position,
        health: errorToHealth(e, position),
        value: "",
        unexpected: [UnexpectedTokenSchema.make({ position, value })],
      }),
    ),
  )

// =============================================================================
// makeScanner — schema-driven primitive factory. Reads the schema's `Probe`
// annotation once at module load and returns a per-line scanner: walks the
// line, emits a fully-typed token at every match with real source position
// and okHealth. The schema's `value: Schema.Literal(...)` field guards
// against future Probe drift — if the Probe ever matches text the Literal
// rejects, `Schema.make` throws as a defect. No pairing here.
// =============================================================================

type Scannable<T> = Schema.Schema<T, any, never>

// linePosition.start.offset must be the absolute offset of `lineText`'s first
// character in the source; lineText is the caller's `text.slice(lineStart,
// lineEnd)`. Passing the Position object makes the absolute-offset contract
// visible in the type signature.
type Scanner<T> = (lineText: string, linePosition: Position) => ReadonlyArray<T>

const makeScanner = <T>(schema: Scannable<T>): Scanner<T> => {
  const probe = Option.getOrThrowWith(
    getProbe(schema),
    () => new Error("makeScanner: schema has no Probe annotation"),
  )
  return (lineText, linePosition) => {
    const line = linePosition.start.line
    const lineStart = linePosition.start.offset
    return [...lineText.matchAll(probe)]
      .filter(match => match.index !== undefined)
      .map(match => {
        const i = match.index!
        return (schema as any).make({
          position: span(line, lineStart + i, lineStart + i + match[0].length),
          health: okHealth,
          value: match[0],
        })
      })
  }
}

const scanTagOpen = makeScanner(TagOpenTokenSchema)
const scanTagClose = makeScanner(TagCloseTokenSchema)
const scanSpecifierOpen = makeScanner(SpecifierOpenTokenSchema)
const scanSpecifierClose = makeScanner(SpecifierCloseTokenSchema)

// =============================================================================
// Construction — pair the first open with the first close that follows it.
// Everything left over (extra opens, extra closes, orphan-before closes)
// becomes UnexpectedToken entries.
// =============================================================================

type Construction<T> = {
  readonly token: Option.Option<T>
  readonly unexpected: ReadonlyArray<UnexpectedToken>
}

type Positioned = { readonly position: Position; readonly value: string }

const toUnexpected = (t: Positioned): UnexpectedToken =>
  UnexpectedTokenSchema.make({ position: t.position, value: t.value })

// Splits closes into (matchingClose | null, remaining).
const partitionFirstClose = <C extends { position: Position }>(
  open: { position: Position },
  closes: ReadonlyArray<C>,
): { match: C | null; rest: ReadonlyArray<C> } => {
  const matchIdx = closes.findIndex(
    (c) => c.position.start.offset > open.position.start.offset,
  )
  return matchIdx < 0
    ? { match: null, rest: closes }
    : { match: closes[matchIdx], rest: closes.filter((_, i) => i !== matchIdx) }
}

const constructTag = (
  opens: ReadonlyArray<TagOpenToken>,
  closes: ReadonlyArray<TagCloseToken>,
  lineText: string,
  linePosition: Position,
): Construction<TagToken> => {
  if (opens.length === 0) {
    return {
      token: Option.none(),
      unexpected: closes.map(toUnexpected),
    }
  }

  const line = linePosition.start.line
  const lineStart = linePosition.start.offset
  const lineEnd = linePosition.end.offset

  const [open, ...extraOpens] = opens
  const { match, rest: extraCloses } = partitionFirstClose(open, closes)

  const close: TagCloseToken = match ?? TagCloseTokenSchema.make({
    position: span(line, lineEnd, lineEnd),
    health: missingClosing(line, lineEnd, "]"),
    value: "]",
  })

  const labelStart = open.position.end.offset
  const labelEnd = match ? match.position.start.offset : lineEnd
  const label = buildTagLabel(
    lineText.slice(labelStart - lineStart, labelEnd - lineStart),
    span(line, labelStart, labelEnd),
  )

  const status = aggregateStatus([
    open.health.status,
    label.health.status,
    close.health.status,
  ])

  return {
    token: Option.some(TagTokenSchema.make({
      position: span(line, open.position.start.offset, close.position.end.offset),
      health: { status, diagnostics: [] },
      open,
      label,
      close,
    })),
    unexpected: [
      ...extraOpens.map(toUnexpected),
      ...extraCloses.map(toUnexpected),
    ],
  }
}

const constructSpecifier = (
  opens: ReadonlyArray<SpecifierOpenToken>,
  closes: ReadonlyArray<SpecifierCloseToken>,
  lineText: string,
  linePosition: Position,
): Construction<SpecifierToken> => {
  if (opens.length === 0) {
    return {
      token: Option.none(),
      unexpected: closes.map(toUnexpected),
    }
  }

  const line = linePosition.start.line
  const lineStart = linePosition.start.offset
  const lineEnd = linePosition.end.offset

  const [open, ...extraOpens] = opens
  const { match, rest: extraCloses } = partitionFirstClose(open, closes)

  const close: SpecifierCloseToken = match ?? SpecifierCloseTokenSchema.make({
    position: span(line, lineEnd, lineEnd),
    health: missingClosing(line, lineEnd, "}"),
    value: "}",
  })

  const labelStart = open.position.end.offset
  const labelEnd = match ? match.position.start.offset : lineEnd
  const label = buildSpecifierLabel(
    lineText.slice(labelStart - lineStart, labelEnd - lineStart),
    span(line, labelStart, labelEnd),
  )

  const status = aggregateStatus([
    open.health.status,
    label.health.status,
    close.health.status,
  ])

  return {
    token: Option.some(SpecifierTokenSchema.make({
      position: span(line, open.position.start.offset, close.position.end.offset),
      health: { status, diagnostics: [] },
      open,
      label,
      close,
    })),
    unexpected: [
      ...extraOpens.map(toUnexpected),
      ...extraCloses.map(toUnexpected),
    ],
  }
}

// =============================================================================
// textGaps — emit a TextToken for every non-empty hole between `cursor` and
// `lineEnd` not covered by a consumed span. Pure fold over sorted spans.
// =============================================================================

// Assumes `consumed` ranges are pairwise disjoint (Loom's tag/specifier/
// unexpected positions satisfy this by construction — they don't nest).
// Overlapping inputs would produce spurious gaps between nested ranges; if
// that ever becomes possible, replace `gapStarts` with a running-max scan.
const textGaps = (
  linePosition: Position,
  startCursor: number,
  consumed: ReadonlyArray<Position>,
): ReadonlyArray<TextToken> => {
  const line = linePosition.start.line
  const lineEnd = linePosition.end.offset
  const sorted = [...consumed].sort((a, b) => a.start.offset - b.start.offset)

  // Each consumed range contributes a (gap-start, gap-end) pair: the gap
  // starts where the previous range ended (or at startCursor before any
  // range), and ends where the next range begins (or at lineEnd after the
  // last range). Zip the two boundary lists, drop empty gaps, emit tokens.
  const gapStarts = [startCursor, ...sorted.map((s) => s.end.offset)]
  const gapEnds = [...sorted.map((s) => s.start.offset), lineEnd]

  return gapStarts
    .map((from, i) => [from, gapEnds[i]] as const)
    .filter(([from, to]) => from < to)
    .map(([from, to]) =>
      TextTokenSchema.make({
        position: span(line, from, to),
        health: okHealth,
      }),
    )
}

// =============================================================================
// Heading tokenisation — common to Chapter and Section. Returns the
// constructed subnodes; per-kind handlers decide how to assemble the weft.
// =============================================================================

type HeadingTokens = {
  readonly tag: Option.Option<TagToken>
  readonly specifier: Option.Option<SpecifierToken>
  readonly texts: ReadonlyArray<TextToken>
  readonly unexpected: ReadonlyArray<UnexpectedToken>
}

const tokeniseHeading = (
  text: string,
  position: Position,
  headingStartEnd: number,
): HeadingTokens => {
  const lineText = text.slice(position.start.offset, position.end.offset)

  const tagOpens = scanTagOpen(lineText, position)
  const tagCloses = scanTagClose(lineText, position)
  const specOpens = scanSpecifierOpen(lineText, position)
  const specCloses = scanSpecifierClose(lineText, position)

  const tagResult = constructTag(tagOpens, tagCloses, lineText, position)
  const specResult = constructSpecifier(specOpens, specCloses, lineText, position)

  const unexpected = [...tagResult.unexpected, ...specResult.unexpected]

  // Text region starts after the heading marker's mandatory trailing space.
  const textCursor = headingStartEnd + 1
  const consumed: ReadonlyArray<Position> = [
    ...Option.toArray(tagResult.token).map((t) => t.position),
    ...Option.toArray(specResult.token).map((s) => s.position),
    ...unexpected.map((u) => u.position),
  ]
  const texts = textGaps(position, textCursor, consumed)

  return {
    tag: tagResult.token,
    specifier: specResult.token,
    texts,
    unexpected,
  }
}

// =============================================================================
// ChapterHeading — schema requires tag + specifier. The Tokeniser is the
// authority after Classifier Stage: when source supplies the tokens, it
// replaces the Classifier's NOK placeholders with real tokens; when source
// supplies nothing for a required slot, it synthesises an error-health
// placeholder (with a positioned diagnostic) instead of passing through the
// Classifier's `incomplete` placeholder. Principle: a post-Tokeniser weft is
// never `incomplete` — it's `ok`, `error`, or `warning`.
// =============================================================================

const missingFieldHealth = (line: number, lineEnd: number, message: string): Health => ({
  status: "error",
  diagnostics: [{
    message,
    position: span(line, lineEnd, lineEnd),
    severity: "error",
  }],
})

const synthMissingTag = (line: number, lineEnd: number, message: string): TagToken => {
  const eol = span(line, lineEnd, lineEnd)
  const health = missingFieldHealth(line, lineEnd, message)
  return TagTokenSchema.make({
    position: eol,
    health,
    open: TagOpenTokenSchema.make({ position: eol, health, value: "[" }),
    label: TagLabelTokenSchema.make({ type: "TagLabel", position: eol, health, value: "" }),
    close: TagCloseTokenSchema.make({ position: eol, health, value: "]" }),
  })
}

const synthMissingSpecifier = (line: number, lineEnd: number, message: string): SpecifierToken => {
  const eol = span(line, lineEnd, lineEnd)
  const health = missingFieldHealth(line, lineEnd, message)
  return SpecifierTokenSchema.make({
    position: eol,
    health,
    open: SpecifierOpenTokenSchema.make({ position: eol, health, value: "{" }),
    label: SpecifierLabelTokenSchema.make({ type: "SpecifierLabel", position: eol, health, value: "" }),
    close: SpecifierCloseTokenSchema.make({ position: eol, health, value: "}" }),
  })
}

const tokeniseChapterHeading = (text: string, weft: ChapterHeadingWeft): LoomWeft => {
  const { tag, specifier, texts, unexpected } = tokeniseHeading(
    text, weft.position, weft.headingStart.position.end.offset,
  )

  const line = weft.position.start.line
  const lineEnd = weft.position.end.offset

  const resolvedTag = Option.getOrElse(tag, () =>
    synthMissingTag(line, lineEnd, "ChapterHeadingWeft requires a tag `[…]`"))
  const resolvedSpecifier = Option.getOrElse(specifier, () =>
    synthMissingSpecifier(line, lineEnd, "ChapterHeadingWeft requires a specifier `{…}`"))

  const status = aggregateStatus([
    weft.headingStart.health.status,
    resolvedTag.health.status,
    resolvedSpecifier.health.status,
    ...texts.map((t) => t.health.status),
    ...unexpected.map(() => "error" as const),
  ])

  return ChapterHeadingWeftSchema.make({
    type: "ChapterHeadingWeft",
    position: weft.position,
    health: { status, diagnostics: [] },
    unexpected: unexpected.length > 0 ? unexpected : undefined,
    headingStart: weft.headingStart,
    texts,
    tag: resolvedTag,
    specifier: resolvedSpecifier,
  })
}

// =============================================================================
// SectionHeading — schema makes tag and specifier optional. The Tokeniser
// fills whatever the source provides; absence of either is not an error
// (the de-dicto cut on `{Loom}` happens at Synth time, not here).
// =============================================================================

const tokeniseSectionHeading = (text: string, weft: SectionHeadingWeft): LoomWeft => {
  const { tag, specifier, texts, unexpected } = tokeniseHeading(
    text, weft.position, weft.headingStart.position.end.offset,
  )

  const status = aggregateStatus([
    weft.headingStart.health.status,
    ...Option.toArray(tag).map((t) => t.health.status),
    ...Option.toArray(specifier).map((s) => s.health.status),
    ...texts.map((t) => t.health.status),
    ...unexpected.map(() => "error" as const),
  ])

  return SectionHeadingWeftSchema.make({
    position: weft.position,
    health: { status, diagnostics: [] },
    unexpected: unexpected.length > 0 ? unexpected : undefined,
    headingStart: weft.headingStart,
    texts,
    tag: Option.getOrUndefined(tag),
    specifier: Option.getOrUndefined(specifier),
  })
}
