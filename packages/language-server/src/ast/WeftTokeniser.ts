import { Effect, Either, Hash, Match, Option, ParseResult, Schema, Stream, pipe } from "effect"
import {
  okHealth,
  type Health,
  type Position,
  type UnexpectedToken,
  UnexpectedTokenSchema,
} from "./LoomNode"
import {
  CodeTokenSchema,
  PathSpecifierLabelTokenSchema,
  PathSpecifierTokenSchema,
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
  WarpAnchorNameTokenSchema,
  WarpAnchorTokenSchema,
  WarpAnnotationTokenSchema,
  WarpCloseTokenSchema,
  WarpDefaultTokenSchema,
  WarpNameTokenSchema,
  WarpOpenTokenSchema,
  WarpTokenSchema,
  getProbe,
  type PathSpecifierLabelToken,
  type PathSpecifierToken,
  type SpecifierCloseToken,
  type SpecifierLabelToken,
  type SpecifierOpenToken,
  type SpecifierToken,
  type TagCloseToken,
  type TagLabelToken,
  type TagOpenToken,
  type TagToken,
  type TextToken,
  type WarpAnchorNameToken,
  type WarpAnchorToken,
  type WarpAnnotationToken,
  type WarpCloseToken,
  type WarpDefaultToken,
  type WarpNameToken,
  type WarpOpenToken,
  type WarpToken,
} from "./LoomTokens"
import {
  type ArrowWeft,
  ArrowWeftSchema,
  type CodeWeft,
  CodeWeftSchema,
  type HeadingWeft,
  HeadingWeftSchema,
  type LoomWeft,
  type PreambleWeft,
  PreambleWeftSchema,
  type ProseWeft,
  ProseWeftSchema,
  type TildeWeft,
  TildeWeftSchema,
} from "./Weft"

// =============================================================================
// WeftTokeniser — the Tokeniser Stage of the parse pipeline.
//
// Pure Stream.map: per-weft transformation. The Tokeniser fills subtokens
// per weft kind:
//
//   Heading          — full tokenisation (tag/specifier/texts). A label vs
//                      path specifier is chosen by path-separator presence;
//                      a tagless heading gets a hash-derived tag (ok health).
//   Arrow / Tilde    — fill the optional inline `code` / `prose` subtoken.
//   Preamble / Prose — settle health to `ok`; inner-token expansion belongs
//                      to the Synth phase.
//   CodeWeft         — scan `{{name}}` anchors and settle health.
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
    Match.when({ type: "HeadingWeft" }, (w) => tokeniseHeading(text, w)),
    Match.when({ type: "ArrowWeft" }, (w) => tokeniseArrow(text, w)),
    Match.when({ type: "TildeWeft" }, (w) => tokeniseTilde(text, w)),
    Match.when({ type: "PreambleWeft" }, (w) => tokenisePreamble(text, w)),
    Match.when({ type: "ProseWeft" }, (w) => tokeniseProse(w)),
    Match.when({ type: "CodeWeft" }, (w) => tokeniseCode(text, w)),
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
  return pipe(
    Option.fromNullable(probe.exec(lineText)),
    Option.filter((m): m is RegExpExecArray & { index: number } => m.index !== undefined),
    Option.map((m) =>
      (schema as any).make({
        position: span(
          linePosition.start.line,
          lineStart + m.index,
          lineStart + m.index + m[0].length,
        ),
        health: okHealth,
      }),
    ),
  )
}

const lineSlice = (text: string, position: Position): string =>
  text.slice(position.start.offset, position.end.offset)

const tokeniseArrow = (text: string, weft: ArrowWeft): LoomWeft => {
  const code = inlineAfter(CodeTokenSchema, codeProbe, text, weft.position)
  const { tokens: anchors, unexpected } =
    constructAnchors(lineSlice(text, weft.position), weft.position)
  const status = aggregateStatus([
    weft.arrow.health.status,
    ...Option.toArray(code).map((c) => c.health.status),
    ...anchors.map((a) => a.health.status),
    ...unexpected.map(() => "error" as const),
  ])
  return ArrowWeftSchema.make({
    position: weft.position,
    health: { status, diagnostics: [] },
    unexpected: unexpected.length > 0 ? unexpected : undefined,
    arrow: weft.arrow,
    code: Option.getOrUndefined(code),
    anchors,
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

const tokenisePreamble = (text: string, weft: PreambleWeft): LoomWeft => {
  const { tokens: warps, unexpected } =
    constructWarps(lineSlice(text, weft.position), weft.position)
  const status = aggregateStatus([
    ...warps.map((w) => w.health.status),
    ...unexpected.map(() => "error" as const),
  ])
  return PreambleWeftSchema.make({
    position: weft.position,
    health: { status, diagnostics: [] },
    unexpected: unexpected.length > 0 ? unexpected : undefined,
    warps,
  })
}

const tokeniseProse = (weft: ProseWeft): LoomWeft =>
  ProseWeftSchema.make({ position: weft.position, health: okHealth })

const tokeniseCode = (text: string, weft: CodeWeft): LoomWeft => {
  const { tokens: anchors, unexpected } =
    constructAnchors(lineSlice(text, weft.position), weft.position)
  const status = aggregateStatus([
    ...anchors.map((a) => a.health.status),
    ...unexpected.map(() => "error" as const),
  ])
  return CodeWeftSchema.make({
    position: weft.position,
    health: { status, diagnostics: [] },
    unexpected: unexpected.length > 0 ? unexpected : undefined,
    anchors,
  })
}

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

const missingClosing = (line: number, lineEnd: number, expected: "]" | "}" | "}}"): Health => ({
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
const decodePathSpecifierLabel = Schema.decodeUnknownEither(PathSpecifierLabelTokenSchema)

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

const buildPathSpecifierLabel = (value: string, position: Position): PathSpecifierLabelToken =>
  pipe(
    decodePathSpecifierLabel({ type: "PathSpecifierLabel", position, health: okHealth, value }),
    Either.getOrElse((e) =>
      PathSpecifierLabelTokenSchema.make({
        type: "PathSpecifierLabel",
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

// A specifier label carrying a path separator (`.` or `/`) marks a tangle
// (file-emission) sink and builds a PathSpecifier; a bare identifier is a
// language label and builds a Specifier. Open / close subnodes are shared;
// only the label pattern and the composite schema differ.
const isPathLabel = (label: string): boolean => /[./]/.test(label)

const buildLabelSpecifier = (
  open: SpecifierOpenToken,
  close: SpecifierCloseToken,
  labelText: string,
  labelPos: Position,
  specifierPos: Position,
): SpecifierToken => {
  const label = buildSpecifierLabel(labelText, labelPos)
  const status = aggregateStatus([open.health.status, label.health.status, close.health.status])
  return SpecifierTokenSchema.make({
    position: specifierPos,
    health: { status, diagnostics: [] },
    open,
    label,
    close,
  })
}

const buildPathSpecifier = (
  open: SpecifierOpenToken,
  close: SpecifierCloseToken,
  labelText: string,
  labelPos: Position,
  specifierPos: Position,
): PathSpecifierToken => {
  const label = buildPathSpecifierLabel(labelText, labelPos)
  const status = aggregateStatus([open.health.status, label.health.status, close.health.status])
  return PathSpecifierTokenSchema.make({
    position: specifierPos,
    health: { status, diagnostics: [] },
    open,
    label,
    close,
  })
}

const constructSpecifier = (
  opens: ReadonlyArray<SpecifierOpenToken>,
  closes: ReadonlyArray<SpecifierCloseToken>,
  lineText: string,
  linePosition: Position,
): Construction<SpecifierToken | PathSpecifierToken> => {
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
  const labelText = lineText.slice(labelStart - lineStart, labelEnd - lineStart)
  const labelPos = span(line, labelStart, labelEnd)
  const specifierPos = span(line, open.position.start.offset, close.position.end.offset)

  const token = isPathLabel(labelText)
    ? buildPathSpecifier(open, close, labelText, labelPos, specifierPos)
    : buildLabelSpecifier(open, close, labelText, labelPos, specifierPos)

  return {
    token: Option.some(token),
    unexpected: [
      ...extraOpens.map(toUnexpected),
      ...extraCloses.map(toUnexpected),
    ],
  }
}

// =============================================================================
// Warp scanners + delimiter pairing.
//
// Warps and WarpAnchors share the same source delimiters (`{{` and `}}`).
// The host Weft determines which schema each pair builds into: PreambleWeft
// pairs become Warp declarations; ArrowWeft / CodeWeft pairs become
// WarpAnchor references.
// =============================================================================

const scanWarpOpen = makeScanner(WarpOpenTokenSchema)
const scanWarpClose = makeScanner(WarpCloseTokenSchema)

// pairWarpDelims — greedy left-to-right pairing as a left fold over opens.
// Each open consumes the first remaining close positioned after it;
// unmatched opens pair with a synthetic `}}` at EOL (error health); closes
// that no open consumed surface as UnexpectedTokens for the parent weft.
type WarpPair = { readonly open: WarpOpenToken; readonly close: WarpCloseToken }

type PairAcc = {
  readonly pairs: ReadonlyArray<WarpPair>
  readonly remaining: ReadonlyArray<WarpCloseToken>
}

const pairWarpDelims = (
  opens: ReadonlyArray<WarpOpenToken>,
  closes: ReadonlyArray<WarpCloseToken>,
  linePosition: Position,
): { readonly pairs: ReadonlyArray<WarpPair>; readonly stray: ReadonlyArray<UnexpectedToken> } => {
  const line = linePosition.start.line
  const lineEnd = linePosition.end.offset
  const synthClose = (): WarpCloseToken => WarpCloseTokenSchema.make({
    position: span(line, lineEnd, lineEnd),
    health: missingClosing(line, lineEnd, "}}"),
    value: "}}",
  })

  const { pairs, remaining } = opens.reduce<PairAcc>((acc, open) => {
    const idx = acc.remaining.findIndex(
      (c) => c.position.start.offset > open.position.start.offset,
    )
    return idx < 0
      ? {
          pairs: [...acc.pairs, { open, close: synthClose() }],
          remaining: acc.remaining,
        }
      : {
          pairs: [...acc.pairs, { open, close: acc.remaining[idx] }],
          remaining: acc.remaining.filter((_, i) => i !== idx),
        }
  }, { pairs: [], remaining: closes })

  return { pairs, stray: remaining.map(toUnexpected) }
}

// =============================================================================
// Opaque segments — annotation and default values inside a Warp.
//
// Each segment is a substring with optional whitespace around it. `sliceTop`
// stops at the first top-level `,` or `;` (depth-tracked across `<()[]>`),
// since a Warp declares a single parameter; multi-param attempts surface as
// `unexpected` on the Warp.
// =============================================================================

// sliceTop — left fold over characters tracking bracket depth. The first
// top-level `,` or `;` settles `cut`; subsequent characters pass through
// unchanged once `cut` is `Some`.
type SliceAcc = { readonly depth: number; readonly cut: Option.Option<number> }

const stepSlice = (s: SliceAcc, c: string, i: number): SliceAcc => {
  if (Option.isSome(s.cut)) return s
  if (c === "<" || c === "(" || c === "[") return { depth: s.depth + 1, cut: s.cut }
  if (c === ">" || c === ")" || c === "]") return { depth: Math.max(0, s.depth - 1), cut: s.cut }
  if ((c === "," || c === ";") && s.depth === 0) return { depth: s.depth, cut: Option.some(i) }
  return s
}

const sliceTop = (raw: string): { kept: string; extraStart: number } => {
  const final = [...raw].reduce<SliceAcc>(stepSlice, { depth: 0, cut: Option.none() })
  return Option.match(final.cut, {
    onNone: () => ({ kept: raw, extraStart: raw.length }),
    onSome: (idx) => ({ kept: raw.slice(0, idx), extraStart: idx }),
  })
}

const trimSpan = (raw: string, rawStart: number): { value: string; start: number; end: number } => {
  const left = raw.match(/^\s*/)?.[0].length ?? 0
  const right = raw.match(/\s*$/)?.[0].length ?? 0
  return {
    value: raw.slice(left, raw.length - right),
    start: rawStart + left,
    end: rawStart + raw.length - right,
  }
}

// =============================================================================
// WarpName builder — mirrors buildTagLabel. Strict schema first; on
// rejection, build a schema-valid name with synthetic empty `value` and
// stash the rejected source in `name.unexpected[]`.
// =============================================================================

const decodeWarpName = Schema.decodeUnknownEither(WarpNameTokenSchema)

const buildWarpName = (value: string, position: Position): WarpNameToken =>
  pipe(
    decodeWarpName({ type: "WarpName", position, health: okHealth, value }),
    Either.getOrElse((e) =>
      WarpNameTokenSchema.make({
        type: "WarpName",
        position,
        health: errorToHealth(e, position),
        value: "",
        unexpected: [UnexpectedTokenSchema.make({ position, value })],
      }),
    ),
  )

// =============================================================================
// buildOpaqueSegment — produce a WarpAnnotation or WarpDefault token from
// the raw substring between separators. Whitespace around the value is
// trimmed; the position reflects the trimmed span. An empty kept value
// flips health to error with the supplied diagnostic. Content past a
// top-level `,`/`;` is returned as an UnexpectedToken for the caller to
// attach to the Warp's `unexpected[]`.
// =============================================================================

type OpaqueMake<T> = (args: {
  type: string
  position: Position
  health: Health
  value: string
}) => T

const buildOpaqueSegment = <T>(
  make: OpaqueMake<T>,
  typeName: string,
  emptyMessage: string,
  raw: string,
  rawStart: number,
  line: number,
): { token: T; extras: ReadonlyArray<UnexpectedToken> } => {
  const { kept, extraStart } = sliceTop(raw)
  const { value, start, end } = trimSpan(kept, rawStart)

  const tokenPos = span(line, start, end)
  const health: Health = value === ""
    ? {
        status: "error",
        diagnostics: [{
          message: emptyMessage,
          position: tokenPos,
          severity: "error",
        }],
      }
    : okHealth

  const token = make({ type: typeName, position: tokenPos, health, value })

  const extras: UnexpectedToken[] = extraStart < raw.length
    ? [UnexpectedTokenSchema.make({
        position: span(line, rawStart + extraStart, rawStart + raw.length),
        value: raw.slice(extraStart),
      })]
    : []

  return { token, extras }
}

const buildWarpAnnotation = (raw: string, rawStart: number, line: number) =>
  buildOpaqueSegment<WarpAnnotationToken>(
    (args) => WarpAnnotationTokenSchema.make(args as any),
    "WarpAnnotation",
    "Warp annotation cannot be empty",
    raw, rawStart, line,
  )

const buildWarpDefault = (raw: string, rawStart: number, line: number) =>
  buildOpaqueSegment<WarpDefaultToken>(
    (args) => WarpDefaultTokenSchema.make(args as any),
    "WarpDefault",
    "Warp default value cannot be empty",
    raw, rawStart, line,
  )

// =============================================================================
// buildWarp — assemble a single Warp from its delimiters and content.
//
// Content is `name [: annotation [= default]]`. Missing `:` is an error
// (annotation is required); the entire content is used as the name and a
// zero-width error-health annotation is synthesised. Trailing `,`/`;` and
// anything past it on annotation or default becomes UnexpectedToken
// entries on the Warp's `unexpected[]`.
// =============================================================================

const synthMissingAnnotation = (position: Position): WarpAnnotationToken =>
  WarpAnnotationTokenSchema.make({
    type: "WarpAnnotation",
    position,
    health: {
      status: "error",
      diagnostics: [{
        message: "Warp declaration requires `:` annotation",
        position,
        severity: "error",
      }],
    },
    value: "",
  })

const findChar = (s: string, c: string): Option.Option<number> => {
  const idx = s.indexOf(c)
  return idx < 0 ? Option.none() : Option.some(idx)
}

const buildWarp = (
  open: WarpOpenToken,
  close: WarpCloseToken,
  lineText: string,
  linePosition: Position,
): WarpToken => {
  const line = linePosition.start.line
  const lineStart = linePosition.start.offset
  const contentStart = open.position.end.offset
  const contentEnd = close.position.start.offset
  const content = lineText.slice(contentStart - lineStart, contentEnd - lineStart)

  return Option.match(findChar(content, ":"), {
    // No `:` — entire content is the name; synthesise an empty error-health
    // annotation so the schema's required field stays filled.
    onNone: () => {
      const nameSpan = trimSpan(content, contentStart)
      const name = buildWarpName(nameSpan.value, span(line, nameSpan.start, nameSpan.end))
      const annotation = synthMissingAnnotation(span(line, contentEnd, contentEnd))
      return assembleWarp(open, close, name, annotation, undefined, [], line)
    },
    onSome: (colonIdx) => {
      const nameRaw = content.slice(0, colonIdx)
      const restRaw = content.slice(colonIdx + 1)
      const restStart = contentStart + colonIdx + 1
      const nameSpanned = trimSpan(nameRaw, contentStart)
      const name = buildWarpName(
        nameSpanned.value,
        span(line, nameSpanned.start, nameSpanned.end),
      )

      return Option.match(findChar(restRaw, "="), {
        // No `=` — annotation only, no default.
        onNone: () => {
          const { token: annotation, extras } =
            buildWarpAnnotation(restRaw, restStart, line)
          return assembleWarp(open, close, name, annotation, undefined, extras, line)
        },
        onSome: (eqIdx) => {
          const annotationRaw = restRaw.slice(0, eqIdx)
          const defaultRaw = restRaw.slice(eqIdx + 1)
          const defaultStart = restStart + eqIdx + 1
          const { token: annotation, extras: annoExtras } =
            buildWarpAnnotation(annotationRaw, restStart, line)
          const { token: defaultToken, extras: defExtras } =
            buildWarpDefault(defaultRaw, defaultStart, line)
          return assembleWarp(
            open, close, name, annotation, defaultToken,
            [...annoExtras, ...defExtras], line,
          )
        },
      })
    },
  })
}

const assembleWarp = (
  open: WarpOpenToken,
  close: WarpCloseToken,
  name: WarpNameToken,
  annotation: WarpAnnotationToken,
  defaultToken: WarpDefaultToken | undefined,
  extras: ReadonlyArray<UnexpectedToken>,
  line: number,
): WarpToken => {
  const subStatuses = [
    open.health.status,
    name.health.status,
    annotation.health.status,
    ...(defaultToken ? [defaultToken.health.status] : []),
    close.health.status,
  ]
  const status = aggregateStatus([
    ...subStatuses,
    ...extras.map(() => "error" as const),
  ])
  return WarpTokenSchema.make({
    type: "Warp",
    position: span(line, open.position.start.offset, close.position.end.offset),
    health: { status, diagnostics: [] },
    unexpected: extras.length > 0 ? extras : undefined,
    open,
    name,
    annotation,
    default: defaultToken,
    close,
  })
}

// =============================================================================
// buildWarpAnchor — assemble a single WarpAnchor. The trimmed content is the
// anchor's name: a single identifier (`{{mul}}`) or a multi-word heading name
// (`{{Multiplier Function}}`). Content that is neither — empty, or carrying a
// `:` (a declaration written in Code mode) — fails the WarpAnchorName pattern:
// the name token carries error health and the offending text surfaces on the
// host weft's `unexpected[]`.
// =============================================================================

const unexpectedIfNonEmpty = (
  position: Position,
  value: string,
): ReadonlyArray<UnexpectedToken> =>
  value.length > 0
    ? [UnexpectedTokenSchema.make({ position, value })]
    : []

const decodeWarpAnchorName = Schema.decodeUnknownEither(WarpAnchorNameTokenSchema)

const buildWarpAnchor = (
  open: WarpOpenToken,
  close: WarpCloseToken,
  lineText: string,
  linePosition: Position,
): { anchor: WarpAnchorToken; extras: ReadonlyArray<UnexpectedToken> } => {
  const line = linePosition.start.line
  const lineStart = linePosition.start.offset
  const contentStart = open.position.end.offset
  const contentEnd = close.position.start.offset
  const content = lineText.slice(contentStart - lineStart, contentEnd - lineStart)
  const { value, start, end } = trimSpan(content, contentStart)
  const namePos = span(line, start, end)

  return pipe(
    decodeWarpAnchorName({ type: "WarpAnchorName", position: namePos, health: okHealth, value }),
    Either.match({
      // Content that fails the anchor-name pattern: empty value + error health
      // on the name token, offending text on the host weft's `unexpected[]`.
      onLeft: (e) => ({
        anchor: assembleAnchor(
          open, close,
          WarpAnchorNameTokenSchema.make({
            type: "WarpAnchorName",
            position: namePos,
            health: errorToHealth(e, namePos),
            value: "",
          }),
          line,
        ),
        extras: unexpectedIfNonEmpty(namePos, value),
      }),
      onRight: (name) => ({
        anchor: assembleAnchor(open, close, name, line),
        extras: [],
      }),
    }),
  )
}

const assembleAnchor = (
  open: WarpOpenToken,
  close: WarpCloseToken,
  name: WarpAnchorNameToken,
  line: number,
): WarpAnchorToken => {
  const status = aggregateStatus([
    open.health.status,
    name.health.status,
    close.health.status,
  ])
  return WarpAnchorTokenSchema.make({
    type: "WarpAnchor",
    position: span(line, open.position.start.offset, close.position.end.offset),
    health: { status, diagnostics: [] },
    open,
    name,
    close,
  })
}

// =============================================================================
// constructWarps / constructAnchors — per-weft entry points. Scan the line
// for `{{` and `}}`, pair them, and build the appropriate composite per
// pair. Stray closes (with no preceding open) and Anchor-content remainders
// accumulate as `unexpected` on the parent weft.
// =============================================================================

const constructWarps = (
  lineText: string,
  linePosition: Position,
): { tokens: ReadonlyArray<WarpToken>; unexpected: ReadonlyArray<UnexpectedToken> } => {
  const opens = scanWarpOpen(lineText, linePosition)
  const closes = scanWarpClose(lineText, linePosition)
  const { pairs, stray } = pairWarpDelims(opens, closes, linePosition)
  const tokens = pairs.map(({ open, close }) =>
    buildWarp(open, close, lineText, linePosition))
  return { tokens, unexpected: stray }
}

const constructAnchors = (
  lineText: string,
  linePosition: Position,
): { tokens: ReadonlyArray<WarpAnchorToken>; unexpected: ReadonlyArray<UnexpectedToken> } => {
  const opens = scanWarpOpen(lineText, linePosition)
  const closes = scanWarpClose(lineText, linePosition)
  const { pairs, stray } = pairWarpDelims(opens, closes, linePosition)
  const built = pairs.map(({ open, close }) =>
    buildWarpAnchor(open, close, lineText, linePosition))
  return {
    tokens: built.map((b) => b.anchor),
    unexpected: [...stray, ...built.flatMap((b) => b.extras)],
  }
}

// =============================================================================
// textTokens — emit a TextToken for every non-empty slice of `region` not
// covered by a `consumed` span. Pure fold over sorted spans.
//
// `consumed` is assumed to be pairwise disjoint (Loom's tag/specifier/
// unexpected positions satisfy this by construction — they don't nest).
// Overlapping inputs would produce spurious gaps between nested ranges; if
// that ever becomes possible, replace `gapStarts` with a running-max scan.
// =============================================================================

const textTokens = (
  region: Position,
  consumed: ReadonlyArray<Position>,
): ReadonlyArray<TextToken> => {
  const line = region.start.line
  const sorted = [...consumed].sort((a, b) => a.start.offset - b.start.offset)

  // Each consumed range contributes a (gap-start, gap-end) pair: the gap
  // starts where the previous range ended (or at the region's start before
  // any range), and ends where the next range begins (or at the region's
  // end after the last range). Zip the two boundary lists, drop empty
  // gaps, emit tokens.
  const gapStarts = [region.start.offset, ...sorted.map((s) => s.end.offset)]
  const gapEnds = [...sorted.map((s) => s.start.offset), region.end.offset]

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
// Heading tokenisation. `scanHeading` constructs the subnodes — tag, specifier
// (label or path), texts — that the weft handler then assembles.
// =============================================================================

type HeadingTokens = {
  readonly tag: Option.Option<TagToken>
  readonly specifier: Option.Option<SpecifierToken | PathSpecifierToken>
  readonly texts: ReadonlyArray<TextToken>
  readonly unexpected: ReadonlyArray<UnexpectedToken>
}

const scanHeading = (
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

  // The heading's text region begins past the marker (whose position
  // covers hash + mandatory space) and ends before any trailing whitespace
  // (which includes the line terminator carried in the LineRange).
  const trailingWs = lineText.match(/\s*$/)?.[0].length ?? 0
  const textRegion = span(
    position.start.line,
    headingStartEnd,
    position.end.offset - trailingWs,
  )
  const consumed: ReadonlyArray<Position> = [
    ...Option.toArray(tagResult.token).map((t) => t.position),
    ...Option.toArray(specResult.token).map((s) => s.position),
    ...unexpected.map((u) => u.position),
  ]
  const texts = textTokens(textRegion, consumed)

  return {
    tag: tagResult.token,
    specifier: specResult.token,
    texts,
    unexpected,
  }
}

// =============================================================================
// Heading — one handler for every `#{1,6}` line. The Tokeniser fills whatever
// the source supplies for tag and specifier; both are optional. A tagless
// heading receives a hash-derived `TagToken` (ok health) so every Section has
// a stable identifier — a private section, not an error. The hash is taken
// from the heading text. The label vs path specifier choice is made in
// `constructSpecifier` by path-separator presence. Post-Tokeniser invariant:
// the weft is never `incomplete`.
// =============================================================================

// A synthetic tag id is a valid TS identifier (`S_` prefix + unsigned base-36
// hash), so it can name a Service member in the Frame downstream.
const syntheticTagId = (title: string): string =>
  `S_${(Hash.string(title) >>> 0).toString(36)}`

const synthHashTag = (
  text: string,
  position: Position,
  texts: ReadonlyArray<TextToken>,
): TagToken => {
  const eol = span(position.start.line, position.end.offset, position.end.offset)
  const title = texts
    .map((t) => text.slice(t.position.start.offset, t.position.end.offset))
    .join("")
    .trim()
  const value = syntheticTagId(title)
  return TagTokenSchema.make({
    position: eol,
    health: okHealth,
    open: TagOpenTokenSchema.make({ position: eol, health: okHealth, value: "[" }),
    label: TagLabelTokenSchema.make({ type: "TagLabel", position: eol, health: okHealth, value }),
    close: TagCloseTokenSchema.make({ position: eol, health: okHealth, value: "]" }),
  })
}

const tokeniseHeading = (text: string, weft: HeadingWeft): LoomWeft => {
  const { tag, specifier, texts, unexpected } = scanHeading(
    text, weft.position, weft.headingStart.position.end.offset,
  )

  // A real tag wins; a tagless heading gets a hash-derived tag so every
  // Section carries a stable identifier.
  const resolvedTag = Option.getOrElse(tag, () => synthHashTag(text, weft.position, texts))

  const status = aggregateStatus([
    weft.headingStart.health.status,
    resolvedTag.health.status,
    ...Option.toArray(specifier).map((s) => s.health.status),
    ...texts.map((t) => t.health.status),
    ...unexpected.map(() => "error" as const),
  ])

  return HeadingWeftSchema.make({
    position: weft.position,
    health: { status, diagnostics: [] },
    unexpected: unexpected.length > 0 ? unexpected : undefined,
    headingStart: weft.headingStart,
    texts,
    tag: resolvedTag,
    specifier: Option.getOrUndefined(specifier),
  })
}
