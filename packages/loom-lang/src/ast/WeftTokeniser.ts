import {
  Effect,
  Either,
  Match,
  Option,
  Schema,
  Stream,
  pipe,
} from 'effect'
import {
  okHealth,
  type Health,
  type Position,
  type UnexpectedToken,
  UnexpectedTokenSchema,
} from '@athrio/loom-ast/LoomNode'
import {
  CodeTokenSchema,
  HeadingTitleTokenSchema,
  ProseTokenSchema,
  SinkCloseTokenSchema,
  SinkDirLabelTokenSchema,
  SinkFileLabelTokenSchema,
  SinkOpenTokenSchema,
  SinkTokenSchema,
  SpecifierCloseTokenSchema,
  SpecifierLabelTokenSchema,
  SpecifierOpenTokenSchema,
  SpecifierTokenSchema,
  AnchorCloseTokenSchema,
  AnchorOpenTokenSchema,
  defaultAnchorDelims,
  WarpAnchorNameTokenSchema,
  WarpAnchorTokenSchema,
  WarpAnnotationTokenSchema,
  WarpCloseTokenSchema,
  WarpDefaultTokenSchema,
  WarpNameTokenSchema,
  WarpOpenTokenSchema,
  WarpTokenSchema,
  getProbe,
  type SinkCloseToken,
  type SinkDirLabelToken,
  type SinkFileLabelToken,
  type SinkOpenToken,
  type SinkToken,
  type SpecifierCloseToken,
  type SpecifierLabelToken,
  type SpecifierOpenToken,
  type SpecifierToken,
  type AnchorCloseToken,
  type AnchorDelims,
  type AnchorOpenToken,
  type HeadingTitleToken,
  type WarpAnchorNameToken,
  type WarpAnchorToken,
  type WarpAnnotationToken,
  type WarpCloseToken,
  type WarpDefaultToken,
  type WarpNameToken,
  type WarpOpenToken,
  type WarpToken,
} from '@athrio/loom-ast/LoomTokens'
import {
  EmptyLabel,
  faulty,
  MalformedLabel,
  MissingWarpValue,
  UnclosedDelimiter,
  type EmptyConstruct,
  type MalformedConstruct,
} from '#ast/LoomFault'
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
} from '@athrio/loom-ast/Weft'

export class WeftTokeniser extends Effect.Service<WeftTokeniser>()(
  'WeftTokeniser',
  {
    succeed: {
      tokeniseWefts:
        (text: string, delims: AnchorDelims = defaultAnchorDelims) =>
        (source: Stream.Stream<LoomWeft>): Stream.Stream<LoomWeft> =>
          Stream.mapAccum(source, false, (inFence, weft) => {
            const [nextFence, skipAnchors] = fenceStep(inFence, weft)
            return [nextFence, tokeniseWeft(text, weft, delims, skipAnchors)]
          }),
    },
  },
) {}

const isProseWeft = (weft: LoomWeft): boolean =>
  weft.type === 'PreambleWeft' ||
  weft.type === 'TildeWeft' ||
  weft.type === 'ProseWeft'

const fenceStep = (
  inFence: boolean,
  weft: LoomWeft,
): readonly [boolean, boolean] => {
  if (!isProseWeft(weft)) return [false, false]
  const delimiter = /^\s*```/.test(weft.source)
  return [delimiter ? !inFence : inFence, inFence || delimiter]
}

const tokeniseWeft = (
  text: string,
  weft: LoomWeft,
  delims: AnchorDelims,
  skipAnchors: boolean,
): LoomWeft =>
  pipe(
    Match.value(weft),
    Match.when({ type: 'HeadingWeft' }, (w) => tokeniseHeading(text, w)),
    Match.when({ type: 'ArrowWeft' }, (w) => tokeniseArrow(text, w, delims)),
    Match.when({ type: 'TildeWeft' }, (w) =>
      tokeniseTilde(text, w, delims, skipAnchors),
    ),
    Match.when({ type: 'PreambleWeft' }, (w) =>
      tokenisePreamble(text, w, delims, skipAnchors),
    ),
    Match.when({ type: 'ProseWeft' }, (w) =>
      tokeniseProse(text, w, delims, skipAnchors),
    ),
    Match.when({ type: 'CodeWeft' }, (w) => tokeniseCode(text, w, delims)),
    Match.exhaustive,
  )

const codeProbe = Option.getOrThrow(getProbe(CodeTokenSchema))
const proseProbe = Option.getOrThrow(getProbe(ProseTokenSchema))

const inlineAfter = <T>(
  schema: Schema.Schema<T, any, never>,
  probe: RegExp,
  text: string,
  linePosition: Position,
): Option.Option<T> => {
  const lineStart = linePosition.start.offset
  const lineText = text
    .slice(lineStart, linePosition.end.offset)
    .replace(/\r?\n$/, '')
  return pipe(
    Option.fromNullable(probe.exec(lineText)),
    Option.filter(
      (m): m is RegExpExecArray & { index: number } => m.index !== undefined,
    ),
    Option.map((m) =>
      (schema as any).make({
        position: span(
          linePosition.start.line,
          lineStart + m.index,
          lineStart + m.index + m[0].length,
        ),
        source: m[0],
        health: okHealth,
      }),
    ),
  )
}

const lineSlice = (text: string, position: Position): string =>
  text.slice(position.start.offset, position.end.offset)

const maskInlineCode = (line: string): string =>
  line.replace(/`[^`]*`/g, (m) => ' '.repeat(m.length))

const blankIfSkipped = (line: string, skip: boolean): string =>
  skip ? ' '.repeat(line.length) : maskInlineCode(line)

const tokeniseArrow = (
  text: string,
  weft: ArrowWeft,
  delims: AnchorDelims,
): LoomWeft => {
  const code = inlineAfter(CodeTokenSchema, codeProbe, text, weft.position)
  const { tokens: anchors, unexpected } = constructAnchors(
    lineSlice(text, weft.position),
    weft.position,
    delims,
  )
  const status = aggregateStatus([
    weft.arrow.health.status,
    ...Option.toArray(code).map((c) => c.health.status),
    ...anchors.map((a) => a.health.status),
    ...unexpected.map(() => 'error' as const),
  ])
  return ArrowWeftSchema.make({
    position: weft.position,
    source: lineSlice(text, weft.position),
    health: { status, diagnostics: [] },
    unexpected: unexpected.length > 0 ? unexpected : undefined,
    arrow: weft.arrow,
    code: Option.getOrUndefined(code),
    anchors,
  })
}

const tokeniseTilde = (
  text: string,
  weft: TildeWeft,
  delims: AnchorDelims,
  skipAnchors: boolean,
): LoomWeft => {
  const lineText = lineSlice(text, weft.position)
  const prose = inlineAfter(ProseTokenSchema, proseProbe, text, weft.position)
  const { tokens: anchors, unexpected } = constructAnchors(
    lineText,
    weft.position,
    delims,
    blankIfSkipped(lineText, skipAnchors),
  )
  const status = aggregateStatus([
    weft.tilde.health.status,
    ...Option.toArray(prose).map((p) => p.health.status),
    ...anchors.map((a) => a.health.status),
    ...unexpected.map(() => 'error' as const),
  ])
  return TildeWeftSchema.make({
    position: weft.position,
    source: lineText,
    health: { status, diagnostics: [] },
    unexpected: unexpected.length > 0 ? unexpected : undefined,
    tilde: weft.tilde,
    prose: Option.getOrUndefined(prose),
    anchors,
  })
}

const tokenisePreamble = (
  text: string,
  weft: PreambleWeft,
  delims: AnchorDelims,
  skipAnchors: boolean,
): LoomWeft => {
  const lineText = lineSlice(text, weft.position)
  const scanText = blankIfSkipped(lineText, skipAnchors)
  const { tokens: warps, unexpected: warpStray } = constructWarps(
    lineText,
    weft.position,
    scanText,
  )
  const { tokens: anchors, unexpected: anchorStray } = constructAnchors(
    lineText,
    weft.position,
    delims,
    scanText,
  )
  const unexpected = [...warpStray, ...anchorStray]
  const status = aggregateStatus([
    ...warps.map((w) => w.health.status),
    ...anchors.map((a) => a.health.status),
    ...unexpected.map(() => 'error' as const),
  ])
  return PreambleWeftSchema.make({
    position: weft.position,
    source: lineText,
    health: { status, diagnostics: [] },
    unexpected: unexpected.length > 0 ? unexpected : undefined,
    warps,
    anchors,
  })
}

const tokeniseProse = (
  text: string,
  weft: ProseWeft,
  delims: AnchorDelims,
  skipAnchors: boolean,
): LoomWeft => {
  const lineText = lineSlice(text, weft.position)
  const { tokens: anchors, unexpected } = constructAnchors(
    lineText,
    weft.position,
    delims,
    blankIfSkipped(lineText, skipAnchors),
  )
  const status = aggregateStatus([
    ...anchors.map((a) => a.health.status),
    ...unexpected.map(() => 'error' as const),
  ])
  return ProseWeftSchema.make({
    position: weft.position,
    source: lineText,
    health: { status, diagnostics: [] },
    unexpected: unexpected.length > 0 ? unexpected : undefined,
    anchors,
  })
}

const tokeniseCode = (
  text: string,
  weft: CodeWeft,
  delims: AnchorDelims,
): LoomWeft => {
  const { tokens: anchors, unexpected } = constructAnchors(
    lineSlice(text, weft.position),
    weft.position,
    delims,
  )
  const status = aggregateStatus([
    ...anchors.map((a) => a.health.status),
    ...unexpected.map(() => 'error' as const),
  ])
  return CodeWeftSchema.make({
    position: weft.position,
    source: lineSlice(text, weft.position),
    health: { status, diagnostics: [] },
    unexpected: unexpected.length > 0 ? unexpected : undefined,
    anchors,
  })
}

const statusRank: Record<Health['status'], number> = {
  ok: 0,
  incomplete: 1,
  warning: 2,
  error: 3,
}

const joinStatus = (
  a: Health['status'],
  b: Health['status'],
): Health['status'] => (statusRank[a] >= statusRank[b] ? a : b)

const aggregateStatus = (
  statuses: ReadonlyArray<Health['status']>,
): Health['status'] => statuses.reduce(joinStatus, 'ok' as Health['status'])

const span = (line: number, start: number, end: number): Position => ({
  start: { line, offset: start },
  end: { line, offset: end },
})

const contentEnd = (lineText: string, lineStart: number): number =>
  lineStart + lineText.replace(/\r?\n$/, '').length

const missingClosing = (
  line: number,
  from: number,
  lineEnd: number,
  expected: string,
): Health => faulty(UnclosedDelimiter({ expected }), span(line, from, lineEnd))

const brokenLabel = (
  construct: MalformedConstruct,
  value: string,
  position: Position,
): Health =>
  faulty(
    value === ''
      ? EmptyLabel({ construct })
      : MalformedLabel({ construct, value }),
    position,
  )

const decodeSpecifierLabel = Schema.decodeUnknownEither(
  SpecifierLabelTokenSchema,
)
const decodeSinkDirLabel = Schema.decodeUnknownEither(SinkDirLabelTokenSchema)
const decodeSinkFileLabel = Schema.decodeUnknownEither(SinkFileLabelTokenSchema)

const buildSpecifierLabel = (
  value: string,
  position: Position,
): SpecifierLabelToken =>
  pipe(
    decodeSpecifierLabel({
      type: 'SpecifierLabel',
      position,
      source: value,
      health: okHealth,
      value,
    }),
    Either.getOrElse(() =>
      SpecifierLabelTokenSchema.make({
        type: 'SpecifierLabel',
        position,
        source: value,
        health: brokenLabel('specifier', value, position),
        value: '',
        unexpected: [UnexpectedTokenSchema.make({ position, value })],
      }),
    ),
  )

const buildSinkDirLabel = (
  value: string,
  position: Position,
): SinkDirLabelToken =>
  pipe(
    decodeSinkDirLabel({
      type: 'SinkDirLabel',
      position,
      source: value,
      health: okHealth,
      value,
    }),
    Either.getOrElse(() =>
      SinkDirLabelTokenSchema.make({
        type: 'SinkDirLabel',
        position,
        source: value,
        health: brokenLabel('path', value, position),
        value: '',
        unexpected: [UnexpectedTokenSchema.make({ position, value })],
      }),
    ),
  )

const buildSinkFileLabel = (
  value: string,
  position: Position,
): SinkFileLabelToken =>
  pipe(
    decodeSinkFileLabel({
      type: 'SinkFileLabel',
      position,
      source: value,
      health: okHealth,
      value,
    }),
    Either.getOrElse(() =>
      SinkFileLabelTokenSchema.make({
        type: 'SinkFileLabel',
        position,
        source: value,
        health: brokenLabel('path', value, position),
        value: '',
        unexpected: [UnexpectedTokenSchema.make({ position, value })],
      }),
    ),
  )

type Scannable<T> = Schema.Schema<T, any, never>

type Scanner<T> = (lineText: string, linePosition: Position) => ReadonlyArray<T>

const makeScanner = <T>(schema: Scannable<T>): Scanner<T> => {
  const probe = Option.getOrThrowWith(
    getProbe(schema),
    () => new Error('makeScanner: schema has no Probe annotation'),
  )
  return (lineText, linePosition) => {
    const line = linePosition.start.line
    const lineStart = linePosition.start.offset
    return [...lineText.matchAll(probe)]
      .filter((match) => match.index !== undefined)
      .map((match) => {
        const i = match.index!
        return (schema as any).make({
          position: span(line, lineStart + i, lineStart + i + match[0].length),
          source: match[0],
          health: okHealth,
          value: match[0],
        })
      })
  }
}

const scanSpecifierOpen = makeScanner(SpecifierOpenTokenSchema)
const scanSpecifierClose = makeScanner(SpecifierCloseTokenSchema)
const scanSinkOpen = makeScanner(SinkOpenTokenSchema)
const scanSinkClose = makeScanner(SinkCloseTokenSchema)

type Construction<T> = {
  readonly token: Option.Option<T>
  readonly unexpected: ReadonlyArray<UnexpectedToken>
}

type Positioned = { readonly position: Position; readonly value: string }

const toUnexpected = (t: Positioned): UnexpectedToken =>
  UnexpectedTokenSchema.make({ position: t.position, value: t.value })

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

const buildLabelSpecifier = (
  open: SpecifierOpenToken,
  close: SpecifierCloseToken,
  labelText: string,
  labelPos: Position,
  specifierPos: Position,
  specifierSource: string,
): SpecifierToken => {
  const label = buildSpecifierLabel(labelText, labelPos)
  const status = aggregateStatus([
    open.health.status,
    label.health.status,
    close.health.status,
  ])
  return SpecifierTokenSchema.make({
    position: specifierPos,
    source: specifierSource,
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
): Construction<SpecifierToken> => {
  if (opens.length === 0) {
    return {
      token: Option.none(),
      unexpected: closes.map(toUnexpected),
    }
  }

  const line = linePosition.start.line
  const lineStart = linePosition.start.offset
  const lineEnd = contentEnd(lineText, lineStart)

  const [open, ...extraOpens] = opens
  const { match, rest: extraCloses } = partitionFirstClose(open, closes)

  const close: SpecifierCloseToken =
    match ??
    SpecifierCloseTokenSchema.make({
      position: span(line, lineEnd, lineEnd),
      source: '',
      health: missingClosing(line, open.position.start.offset, lineEnd, '}'),
      value: '}',
    })

  const labelStart = open.position.end.offset
  const labelEnd = match ? match.position.start.offset : lineEnd
  const labelText = lineText.slice(labelStart - lineStart, labelEnd - lineStart)
  const labelPos = span(line, labelStart, labelEnd)
  const specifierPos = span(
    line,
    open.position.start.offset,
    close.position.end.offset,
  )
  const specifierSource = lineText.slice(
    specifierPos.start.offset - lineStart,
    specifierPos.end.offset - lineStart,
  )

  return {
    token: Option.some(
      buildLabelSpecifier(
        open,
        close,
        labelText,
        labelPos,
        specifierPos,
        specifierSource,
      ),
    ),
    unexpected: [
      ...extraOpens.map(toUnexpected),
      ...extraCloses.map(toUnexpected),
    ],
  }
}

const constructSink = (
  opens: ReadonlyArray<SinkOpenToken>,
  closes: ReadonlyArray<SinkCloseToken>,
  lineText: string,
  linePosition: Position,
): Construction<SinkToken> => {
  if (opens.length === 0) {
    return {
      token: Option.none(),
      unexpected: closes.map(toUnexpected),
    }
  }

  const line = linePosition.start.line
  const lineStart = linePosition.start.offset
  const lineEnd = contentEnd(lineText, lineStart)

  const [open, ...extraOpens] = opens
  const { match, rest: extraCloses } = partitionFirstClose(open, closes)

  const close: SinkCloseToken =
    match ??
    SinkCloseTokenSchema.make({
      position: span(line, lineEnd, lineEnd),
      source: '',
      health: missingClosing(line, open.position.start.offset, lineEnd, ']'),
      value: ']',
    })

  const innerStart = open.position.end.offset
  const innerEnd = match ? match.position.start.offset : lineEnd
  const inner = lineText.slice(innerStart - lineStart, innerEnd - lineStart)
  const sinkPos = span(
    line,
    open.position.start.offset,
    close.position.end.offset,
  )
  const sinkSource = lineText.slice(
    sinkPos.start.offset - lineStart,
    sinkPos.end.offset - lineStart,
  )

  const commaRel = inner.indexOf(',')
  const dirTrim = trimSpan(
    commaRel < 0 ? inner : inner.slice(0, commaRel),
    innerStart,
  )
  const dir = buildSinkDirLabel(
    dirTrim.value,
    span(line, dirTrim.start, dirTrim.end),
  )
  const file =
    commaRel < 0
      ? undefined
      : ((fileTrim) =>
          buildSinkFileLabel(
            fileTrim.value,
            span(line, fileTrim.start, fileTrim.end),
          ))(trimSpan(inner.slice(commaRel + 1), innerStart + commaRel + 1))

  const status = aggregateStatus([
    open.health.status,
    dir.health.status,
    ...(file ? [file.health.status] : []),
    close.health.status,
  ])

  return {
    token: Option.some(
      SinkTokenSchema.make({
        position: sinkPos,
        source: sinkSource,
        health: { status, diagnostics: [] },
        open,
        dir,
        file,
        close,
      }),
    ),
    unexpected: [
      ...extraOpens.map(toUnexpected),
      ...extraCloses.map(toUnexpected),
    ],
  }
}

const scanWarpOpen = makeScanner(WarpOpenTokenSchema)
const scanWarpClose = makeScanner(WarpCloseTokenSchema)

type WarpPair = { readonly open: WarpOpenToken; readonly close: WarpCloseToken }

type PairAcc = {
  readonly pairs: ReadonlyArray<WarpPair>
  readonly remaining: ReadonlyArray<WarpCloseToken>
}

const pairWarpDelims = (
  opens: ReadonlyArray<WarpOpenToken>,
  closes: ReadonlyArray<WarpCloseToken>,
  lineText: string,
  linePosition: Position,
): {
  readonly pairs: ReadonlyArray<WarpPair>
  readonly stray: ReadonlyArray<UnexpectedToken>
} => {
  const line = linePosition.start.line
  const lineEnd = contentEnd(lineText, linePosition.start.offset)
  const synthClose = (open: WarpOpenToken): WarpCloseToken =>
    WarpCloseTokenSchema.make({
      position: span(line, lineEnd, lineEnd),
      source: '',
      health: missingClosing(line, open.position.start.offset, lineEnd, '}}'),
      value: '}}',
    })

  const { pairs, remaining } = opens.reduce<PairAcc>(
    (acc, open) => {
      const idx = acc.remaining.findIndex(
        (c) => c.position.start.offset > open.position.start.offset,
      )
      return idx < 0
        ? {
            pairs: [...acc.pairs, { open, close: synthClose(open) }],
            remaining: acc.remaining,
          }
        : {
            pairs: [...acc.pairs, { open, close: acc.remaining[idx] }],
            remaining: acc.remaining.filter((_, i) => i !== idx),
          }
    },
    { pairs: [], remaining: closes },
  )

  return { pairs, stray: remaining.map(toUnexpected) }
}

type SliceAcc = { readonly depth: number; readonly cut: Option.Option<number> }

const stepSlice = (s: SliceAcc, c: string, i: number): SliceAcc => {
  if (Option.isSome(s.cut)) return s
  if (c === '<' || c === '(' || c === '[')
    return { depth: s.depth + 1, cut: s.cut }
  if (c === '>' || c === ')' || c === ']')
    return { depth: Math.max(0, s.depth - 1), cut: s.cut }
  if ((c === ',' || c === ';') && s.depth === 0)
    return { depth: s.depth, cut: Option.some(i) }
  return s
}

const sliceTop = (raw: string): { kept: string; extraStart: number } => {
  const final = [...raw].reduce<SliceAcc>(stepSlice, {
    depth: 0,
    cut: Option.none(),
  })
  return Option.match(final.cut, {
    onNone: () => ({ kept: raw, extraStart: raw.length }),
    onSome: (idx) => ({ kept: raw.slice(0, idx), extraStart: idx }),
  })
}

const trimSpan = (
  raw: string,
  rawStart: number,
): { value: string; start: number; end: number } => {
  const left = raw.match(/^\s*/)?.[0].length ?? 0
  const right = raw.match(/\s*$/)?.[0].length ?? 0
  return {
    value: raw.slice(left, raw.length - right),
    start: rawStart + left,
    end: rawStart + raw.length - right,
  }
}

const decodeWarpName = Schema.decodeUnknownEither(WarpNameTokenSchema)

const buildWarpName = (value: string, position: Position): WarpNameToken =>
  pipe(
    decodeWarpName({
      type: 'WarpName',
      position,
      source: value,
      health: okHealth,
      value,
    }),
    Either.getOrElse(() =>
      WarpNameTokenSchema.make({
        type: 'WarpName',
        position,
        source: value,
        health: brokenLabel('warpName', value, position),
        value: '',
        unexpected: [UnexpectedTokenSchema.make({ position, value })],
      }),
    ),
  )

type OpaqueMake<T> = (args: {
  type: string
  position: Position
  source: string
  health: Health
  value: string
}) => T

const buildOpaqueSegment = <T>(
  make: OpaqueMake<T>,
  typeName: string,
  construct: EmptyConstruct,
  raw: string,
  rawStart: number,
  line: number,
): { token: T; extras: ReadonlyArray<UnexpectedToken> } => {
  const { kept, extraStart } = sliceTop(raw)
  const { value, start, end } = trimSpan(kept, rawStart)

  const tokenPos = span(line, start, end)
  const health: Health =
    value === '' ? faulty(EmptyLabel({ construct }), tokenPos) : okHealth

  const token = make({
    type: typeName,
    position: tokenPos,
    source: value,
    health,
    value,
  })

  const extras: UnexpectedToken[] =
    extraStart < raw.length
      ? [
          UnexpectedTokenSchema.make({
            position: span(line, rawStart + extraStart, rawStart + raw.length),
            value: raw.slice(extraStart),
          }),
        ]
      : []

  return { token, extras }
}

const buildWarpAnnotation = (raw: string, rawStart: number, line: number) =>
  buildOpaqueSegment<WarpAnnotationToken>(
    (args) => WarpAnnotationTokenSchema.make(args as any),
    'WarpAnnotation',
    'warpAnnotation',
    raw,
    rawStart,
    line,
  )

const buildWarpDefault = (raw: string, rawStart: number, line: number) =>
  buildOpaqueSegment<WarpDefaultToken>(
    (args) => WarpDefaultTokenSchema.make(args as any),
    'WarpDefault',
    'warpDefault',
    raw,
    rawStart,
    line,
  )

const findAssign = (s: string): Option.Option<number> => {
  const isCompound = (i: number): boolean => {
    const prev = s[i - 1]
    const next = s[i + 1]
    return (
      prev === '=' ||
      prev === '!' ||
      prev === '<' ||
      prev === '>' ||
      next === '=' ||
      next === '>'
    )
  }
  const idx = [...s].findIndex((c, i) => c === '=' && !isCompound(i))
  return idx < 0 ? Option.none() : Option.some(idx)
}

const findChar = (s: string, c: string): Option.Option<number> => {
  const idx = s.indexOf(c)
  return idx < 0 ? Option.none() : Option.some(idx)
}

interface WarpDecl {
  readonly name: WarpNameToken
  readonly annotation: WarpAnnotationToken | undefined
  readonly extras: ReadonlyArray<UnexpectedToken>
}

const splitDecl = (decl: string, declStart: number, line: number): WarpDecl =>
  Option.match(findChar(decl, ':'), {
    onNone: () => {
      const n = trimSpan(decl, declStart)
      return {
        name: buildWarpName(n.value, span(line, n.start, n.end)),
        annotation: undefined,
        extras: [],
      }
    },
    onSome: (colonIdx) => {
      const n = trimSpan(decl.slice(0, colonIdx), declStart)
      const { token: annotation, extras } = buildWarpAnnotation(
        decl.slice(colonIdx + 1),
        declStart + colonIdx + 1,
        line,
      )
      return {
        name: buildWarpName(n.value, span(line, n.start, n.end)),
        annotation,
        extras,
      }
    },
  })

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
  const content = lineText.slice(
    contentStart - lineStart,
    contentEnd - lineStart,
  )
  const warpSource = lineText.slice(
    open.position.start.offset - lineStart,
    close.position.end.offset - lineStart,
  )
  const warpPos = span(
    line,
    open.position.start.offset,
    close.position.end.offset,
  )

  return Option.match(findAssign(content), {
    onSome: (eqIdx) => {
      const { name, annotation, extras } = splitDecl(
        content.slice(0, eqIdx),
        contentStart,
        line,
      )
      const { token: defaultToken, extras: defExtras } = buildWarpDefault(
        content.slice(eqIdx + 1),
        contentStart + eqIdx + 1,
        line,
      )
      return assembleWarp(
        open,
        close,
        name,
        annotation,
        defaultToken,
        [...extras, ...defExtras],
        line,
        warpSource,
      )
    },
    onNone: () => {
      const { name, annotation, extras } = splitDecl(content, contentStart, line)
      const own =
        name.health.status === 'ok' && name.value !== 'lang'
          ? faulty(MissingWarpValue({ name: name.value }), warpPos)
          : okHealth
      return assembleWarp(
        open,
        close,
        name,
        annotation,
        undefined,
        extras,
        line,
        warpSource,
        own,
      )
    },
  })
}

const assembleWarp = (
  open: WarpOpenToken,
  close: WarpCloseToken,
  name: WarpNameToken,
  annotation: WarpAnnotationToken | undefined,
  defaultToken: WarpDefaultToken | undefined,
  extras: ReadonlyArray<UnexpectedToken>,
  line: number,
  source: string,
  own: Health = okHealth,
): WarpToken => {
  const subStatuses = [
    open.health.status,
    name.health.status,
    ...(annotation ? [annotation.health.status] : []),
    ...(defaultToken ? [defaultToken.health.status] : []),
    close.health.status,
  ]
  const status = aggregateStatus([
    ...subStatuses,
    ...extras.map(() => 'error' as const),
    own.status,
  ])
  return WarpTokenSchema.make({
    type: 'Warp',
    position: span(line, open.position.start.offset, close.position.end.offset),
    source,
    health: { status, diagnostics: own.diagnostics },
    unexpected: extras.length > 0 ? extras : undefined,
    open,
    name,
    annotation,
    default: defaultToken,
    close,
  })
}

const unexpectedIfNonEmpty = (
  position: Position,
  value: string,
): ReadonlyArray<UnexpectedToken> =>
  value.length > 0 ? [UnexpectedTokenSchema.make({ position, value })] : []

const decodeWarpAnchorName = Schema.decodeUnknownEither(
  WarpAnchorNameTokenSchema,
)

type AnchorSpecifier = SpecifierToken | SinkToken

const anchorSpecifierAt = (
  close: AnchorCloseToken,
  lineText: string,
  linePosition: Position,
): Option.Option<{ specifier: AnchorSpecifier; end: number }> => {
  const line = linePosition.start.line
  const lineStart = linePosition.start.offset
  const openAt = close.position.end.offset
  const ch = lineText[openAt - lineStart]
  if (ch === '{') {
    const closeRel = lineText.indexOf('}', openAt - lineStart)
    if (closeRel < 0) return Option.none()
    const closeAt = lineStart + closeRel
    const open = SpecifierOpenTokenSchema.make({
      position: span(line, openAt, openAt + 1),
      source: '{',
      health: okHealth,
      value: '{',
    })
    const closeTok = SpecifierCloseTokenSchema.make({
      position: span(line, closeAt, closeAt + 1),
      source: '}',
      health: okHealth,
      value: '}',
    })
    return Option.map(
      constructSpecifier([open], [closeTok], lineText, linePosition).token,
      (specifier) => ({ specifier, end: closeAt + 1 }),
    )
  }
  if (ch === '[') {
    const closeRel = lineText.indexOf(']', openAt - lineStart)
    if (closeRel < 0) return Option.none()
    const closeAt = lineStart + closeRel
    const open = SinkOpenTokenSchema.make({
      position: span(line, openAt, openAt + 1),
      source: '[',
      health: okHealth,
      value: '[',
    })
    const closeTok = SinkCloseTokenSchema.make({
      position: span(line, closeAt, closeAt + 1),
      source: ']',
      health: okHealth,
      value: ']',
    })
    return Option.map(
      constructSink([open], [closeTok], lineText, linePosition).token,
      (specifier) => ({ specifier, end: closeAt + 1 }),
    )
  }
  return Option.none()
}

const buildWarpAnchor = (
  open: AnchorOpenToken,
  close: AnchorCloseToken,
  lineText: string,
  linePosition: Position,
): { anchor: WarpAnchorToken; extras: ReadonlyArray<UnexpectedToken> } => {
  const line = linePosition.start.line
  const lineStart = linePosition.start.offset
  const contentStart = open.position.end.offset
  const contentEnd = close.position.start.offset
  const content = lineText.slice(
    contentStart - lineStart,
    contentEnd - lineStart,
  )
  const { value, start, end } = trimSpan(content, contentStart)
  const namePos = span(line, start, end)
  const spec = anchorSpecifierAt(close, lineText, linePosition)
  const anchorEnd = Option.match(spec, {
    onNone: () => close.position.end.offset,
    onSome: (s) => s.end,
  })
  const anchorSource = lineText.slice(
    open.position.start.offset - lineStart,
    anchorEnd - lineStart,
  )
  const specifier = Option.getOrUndefined(Option.map(spec, (s) => s.specifier))

  return pipe(
    decodeWarpAnchorName({
      type: 'WarpAnchorName',
      position: namePos,
      source: value,
      health: okHealth,
      value,
    }),
    Either.match({
      onLeft: () => ({
        anchor: assembleAnchor(
          open,
          close,
          WarpAnchorNameTokenSchema.make({
            type: 'WarpAnchorName',
            position: namePos,
            source: value,
            health: brokenLabel('anchorName', value, namePos),
            value: '',
          }),
          line,
          anchorSource,
          specifier,
        ),
        extras: unexpectedIfNonEmpty(namePos, value),
      }),
      onRight: (name) => ({
        anchor: assembleAnchor(open, close, name, line, anchorSource, specifier),
        extras: [],
      }),
    }),
  )
}

const assembleAnchor = (
  open: AnchorOpenToken,
  close: AnchorCloseToken,
  name: WarpAnchorNameToken,
  line: number,
  source: string,
  specifier: AnchorSpecifier | undefined,
): WarpAnchorToken => {
  const end = specifier
    ? specifier.position.end.offset
    : close.position.end.offset
  const status = aggregateStatus([
    open.health.status,
    name.health.status,
    close.health.status,
    ...(specifier ? [specifier.health.status] : []),
  ])
  return WarpAnchorTokenSchema.make({
    type: 'WarpAnchor',
    position: span(line, open.position.start.offset, end),
    source,
    health: { status, diagnostics: [] },
    open,
    name,
    close,
    specifier,
  })
}

const constructWarps = (
  lineText: string,
  linePosition: Position,
  scanText: string = lineText,
): {
  tokens: ReadonlyArray<WarpToken>
  unexpected: ReadonlyArray<UnexpectedToken>
} => {
  const opens = scanWarpOpen(scanText, linePosition)
  const closes = scanWarpClose(scanText, linePosition)
  const { pairs, stray } = pairWarpDelims(opens, closes, scanText, linePosition)
  const tokens = pairs.map(({ open, close }) =>
    buildWarp(open, close, lineText, linePosition),
  )
  return { tokens, unexpected: stray }
}

const indicesOf = (text: string, needle: string): ReadonlyArray<number> => {
  const step = (
    found: ReadonlyArray<number>,
    from: number,
  ): ReadonlyArray<number> => {
    const at = text.indexOf(needle, from)
    return at < 0 ? found : step([...found, at], at + needle.length)
  }
  return step([], 0)
}

const scanAnchorOpens = (
  open: string,
  lineText: string,
  linePosition: Position,
): ReadonlyArray<AnchorOpenToken> => {
  const line = linePosition.start.line
  const lineStart = linePosition.start.offset
  return indicesOf(lineText, open).map((i) =>
    AnchorOpenTokenSchema.make({
      position: span(line, lineStart + i, lineStart + i + open.length),
      source: open,
      health: okHealth,
      value: open,
    }),
  )
}

const anchorClose = (
  open: AnchorOpenToken,
  close: string,
  lineText: string,
  linePosition: Position,
): AnchorCloseToken => {
  const line = linePosition.start.line
  const lineStart = linePosition.start.offset
  const lineEnd = contentEnd(lineText, lineStart)
  const rel = lineText.indexOf(close, open.position.end.offset - lineStart)
  return rel < 0
    ? AnchorCloseTokenSchema.make({
        position: span(line, lineEnd, lineEnd),
        source: '',
        health: missingClosing(line, open.position.start.offset, lineEnd, close),
        value: close,
      })
    : AnchorCloseTokenSchema.make({
        position: span(line, lineStart + rel, lineStart + rel + close.length),
        source: close,
        health: okHealth,
        value: close,
      })
}

const constructAnchors = (
  lineText: string,
  linePosition: Position,
  delims: AnchorDelims,
  scanText: string = lineText,
): {
  tokens: ReadonlyArray<WarpAnchorToken>
  unexpected: ReadonlyArray<UnexpectedToken>
} => {
  const built = scanAnchorOpens(delims.open, scanText, linePosition).map((open) =>
    buildWarpAnchor(
      open,
      anchorClose(open, delims.close, scanText, linePosition),
      lineText,
      linePosition,
    ),
  )
  return {
    tokens: built.map((b) => b.anchor),
    unexpected: built.flatMap((b) => b.extras),
  }
}

const headingTitle = (
  text: string,
  position: Position,
  headingStartEnd: number,
  consumed: ReadonlyArray<Position>,
): Option.Option<HeadingTitleToken> => {
  const line = position.start.line
  const lineText = text.slice(position.start.offset, position.end.offset)
  const trailingWs = lineText.match(/\s*$/)?.[0].length ?? 0

  const titleEnd = consumed
    .map((p) => p.start.offset)
    .filter((offset) => offset >= headingStartEnd)
    .reduce(
      (min, offset) => Math.min(min, offset),
      position.end.offset - trailingWs,
    )

  const raw = text.slice(headingStartEnd, titleEnd)
  const leading = raw.match(/^\s*/)?.[0].length ?? 0
  const trailing = raw.match(/\s*$/)?.[0].length ?? 0
  const start = headingStartEnd + leading
  const end = titleEnd - trailing
  if (start >= end) return Option.none()

  return Option.some(
    HeadingTitleTokenSchema.make({
      position: span(line, start, end),
      source: text.slice(start, end),
      health: okHealth,
    }),
  )
}

type HeadingTokens = {
  readonly specifier: Option.Option<SpecifierToken>
  readonly sink: Option.Option<SinkToken>
  readonly title: Option.Option<HeadingTitleToken>
  readonly unexpected: ReadonlyArray<UnexpectedToken>
}

const scanHeading = (
  text: string,
  position: Position,
  headingStartEnd: number,
): HeadingTokens => {
  const lineText = text.slice(position.start.offset, position.end.offset)

  const specResult = constructSpecifier(
    scanSpecifierOpen(lineText, position),
    scanSpecifierClose(lineText, position),
    lineText,
    position,
  )
  const sinkResult = constructSink(
    scanSinkOpen(lineText, position),
    scanSinkClose(lineText, position),
    lineText,
    position,
  )

  const unexpected = [...specResult.unexpected, ...sinkResult.unexpected]

  const consumed: ReadonlyArray<Position> = [
    ...Option.toArray(specResult.token).map((s) => s.position),
    ...Option.toArray(sinkResult.token).map((s) => s.position),
    ...unexpected.map((u) => u.position),
  ]
  const title = headingTitle(text, position, headingStartEnd, consumed)

  return {
    specifier: specResult.token,
    sink: sinkResult.token,
    title,
    unexpected,
  }
}

export const normaliseTitle = (title: string): string => {
  const pascal = (title.match(/[A-Za-z0-9]+/g) ?? [])
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('')
  return /^[A-Za-z]/.test(pascal) ? pascal : `_${pascal}`
}

const tokeniseHeading = (text: string, weft: HeadingWeft): LoomWeft => {
  const { specifier, sink, title, unexpected } = scanHeading(
    text,
    weft.position,
    weft.headingStart.position.end.offset,
  )

  const status = aggregateStatus([
    weft.headingStart.health.status,
    ...Option.toArray(specifier).map((s) => s.health.status),
    ...Option.toArray(sink).map((s) => s.health.status),
    ...Option.toArray(title).map((t) => t.health.status),
    ...unexpected.map(() => 'error' as const),
  ])

  return HeadingWeftSchema.make({
    position: weft.position,
    source: lineSlice(text, weft.position),
    health: { status, diagnostics: [] },
    unexpected: unexpected.length > 0 ? unexpected : undefined,
    headingStart: weft.headingStart,
    title: Option.getOrUndefined(title),
    specifier: Option.getOrUndefined(specifier),
    sink: Option.getOrUndefined(sink),
  })
}
