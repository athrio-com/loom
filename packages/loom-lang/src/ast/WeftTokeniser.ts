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
} from '@athrio/loom-core/LoomNode'
import {
  CodeTokenSchema,
  HeadingTitleTokenSchema,
  PathSpecifierLabelTokenSchema,
  PathSpecifierTokenSchema,
  ProseTokenSchema,
  SpecifierCloseTokenSchema,
  SpecifierLabelTokenSchema,
  SpecifierOpenTokenSchema,
  SpecifierTokenSchema,
  AnchorCloseTokenSchema,
  AnchorOpenTokenSchema,
  defaultAnchorDelims,
  TagCloseTokenSchema,
  TagLabelTokenSchema,
  TagOpenTokenSchema,
  TagTokenSchema,
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
  type AnchorCloseToken,
  type AnchorDelims,
  type AnchorOpenToken,
  type HeadingTitleToken,
  type TagCloseToken,
  type TagLabelToken,
  type TagOpenToken,
  type TagToken,
  type WarpAnchorNameToken,
  type WarpAnchorToken,
  type WarpAnnotationToken,
  type WarpCloseToken,
  type WarpDefaultToken,
  type WarpNameToken,
  type WarpOpenToken,
  type WarpToken,
} from './LoomTokens'
import {
  EmptyLabel,
  faulty,
  MalformedLabel,
  MissingWarpAnnotation,
  UnclosedDelimiter,
  type EmptyConstruct,
  type MalformedConstruct,
} from './LoomFault'
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
} from './Weft'

export class WeftTokeniser extends Effect.Service<WeftTokeniser>()(
  'WeftTokeniser',
  {
    succeed: {
      tokeniseWefts:
        (text: string, delims: AnchorDelims = defaultAnchorDelims) =>
        (source: Stream.Stream<LoomWeft>): Stream.Stream<LoomWeft> =>
          Stream.map(source, (weft) => tokeniseWeft(text, weft, delims)),
    },
  },
) {}

const tokeniseWeft = (
  text: string,
  weft: LoomWeft,
  delims: AnchorDelims,
): LoomWeft =>
  pipe(
    Match.value(weft),
    Match.when({ type: 'HeadingWeft' }, (w) => tokeniseHeading(text, w)),
    Match.when({ type: 'ArrowWeft' }, (w) => tokeniseArrow(text, w, delims)),
    Match.when({ type: 'TildeWeft' }, (w) => tokeniseTilde(text, w)),
    Match.when({ type: 'PreambleWeft' }, (w) => tokenisePreamble(text, w)),
    Match.when({ type: 'ProseWeft' }, (w) => tokeniseProse(w)),
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

const tokeniseTilde = (text: string, weft: TildeWeft): LoomWeft => {
  const prose = inlineAfter(ProseTokenSchema, proseProbe, text, weft.position)
  return TildeWeftSchema.make({
    position: weft.position,
    source: lineSlice(text, weft.position),
    health: okHealth,
    tilde: weft.tilde,
    prose: Option.getOrUndefined(prose),
  })
}

const tokenisePreamble = (text: string, weft: PreambleWeft): LoomWeft => {
  const { tokens: warps, unexpected } = constructWarps(
    lineSlice(text, weft.position),
    weft.position,
  )
  const status = aggregateStatus([
    ...warps.map((w) => w.health.status),
    ...unexpected.map(() => 'error' as const),
  ])
  return PreambleWeftSchema.make({
    position: weft.position,
    source: lineSlice(text, weft.position),
    health: { status, diagnostics: [] },
    unexpected: unexpected.length > 0 ? unexpected : undefined,
    warps,
  })
}

const tokeniseProse = (weft: ProseWeft): LoomWeft =>
  ProseWeftSchema.make({
    position: weft.position,
    source: weft.source,
    health: okHealth,
  })

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

const decodeTagLabel = Schema.decodeUnknownEither(TagLabelTokenSchema)
const decodeSpecifierLabel = Schema.decodeUnknownEither(
  SpecifierLabelTokenSchema,
)
const decodePathSpecifierLabel = Schema.decodeUnknownEither(
  PathSpecifierLabelTokenSchema,
)

const buildTagLabel = (value: string, position: Position): TagLabelToken =>
  pipe(
    decodeTagLabel({
      type: 'TagLabel',
      position,
      source: value,
      health: okHealth,
      value,
    }),
    Either.getOrElse(() =>
      TagLabelTokenSchema.make({
        type: 'TagLabel',
        position,
        source: value,
        health: brokenLabel('tag', value, position),
        value: '',
        unexpected: [UnexpectedTokenSchema.make({ position, value })],
      }),
    ),
  )

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

const buildPathSpecifierLabel = (
  value: string,
  position: Position,
): PathSpecifierLabelToken =>
  pipe(
    decodePathSpecifierLabel({
      type: 'PathSpecifierLabel',
      position,
      source: value,
      health: okHealth,
      value,
    }),
    Either.getOrElse(() =>
      PathSpecifierLabelTokenSchema.make({
        type: 'PathSpecifierLabel',
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

const scanTagOpen = makeScanner(TagOpenTokenSchema)
const scanTagClose = makeScanner(TagCloseTokenSchema)
const scanSpecifierOpen = makeScanner(SpecifierOpenTokenSchema)
const scanSpecifierClose = makeScanner(SpecifierCloseTokenSchema)

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
  const lineEnd = contentEnd(lineText, lineStart)

  const [open, ...extraOpens] = opens
  const { match, rest: extraCloses } = partitionFirstClose(open, closes)

  const close: TagCloseToken =
    match ??
    TagCloseTokenSchema.make({
      position: span(line, lineEnd, lineEnd),
      source: '',
      health: missingClosing(line, open.position.start.offset, lineEnd, ']'),
      value: ']',
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

  const tagPos = span(
    line,
    open.position.start.offset,
    close.position.end.offset,
  )
  return {
    token: Option.some(
      TagTokenSchema.make({
        position: tagPos,
        source: lineText.slice(
          tagPos.start.offset - lineStart,
          tagPos.end.offset - lineStart,
        ),
        health: { status, diagnostics: [] },
        open,
        label,
        close,
      }),
    ),
    unexpected: [
      ...extraOpens.map(toUnexpected),
      ...extraCloses.map(toUnexpected),
    ],
  }
}

const isPathLabel = (label: string): boolean => /[./]/.test(label)

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

const buildPathSpecifier = (
  open: SpecifierOpenToken,
  close: SpecifierCloseToken,
  labelText: string,
  labelPos: Position,
  specifierPos: Position,
  specifierSource: string,
): PathSpecifierToken => {
  const label = buildPathSpecifierLabel(labelText, labelPos)
  const status = aggregateStatus([
    open.health.status,
    label.health.status,
    close.health.status,
  ])
  return PathSpecifierTokenSchema.make({
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
): Construction<SpecifierToken | PathSpecifierToken> => {
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

  const token = isPathLabel(labelText)
    ? buildPathSpecifier(
        open,
        close,
        labelText,
        labelPos,
        specifierPos,
        specifierSource,
      )
    : buildLabelSpecifier(
        open,
        close,
        labelText,
        labelPos,
        specifierPos,
        specifierSource,
      )

  return {
    token: Option.some(token),
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

const synthMissingAnnotation = (position: Position): WarpAnnotationToken =>
  WarpAnnotationTokenSchema.make({
    type: 'WarpAnnotation',
    position,
    source: '',
    health: faulty(MissingWarpAnnotation(), position),
    value: '',
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
  const content = lineText.slice(
    contentStart - lineStart,
    contentEnd - lineStart,
  )
  const warpSource = lineText.slice(
    open.position.start.offset - lineStart,
    close.position.end.offset - lineStart,
  )

  return Option.match(findChar(content, ':'), {
    onNone: () => {
      const nameSpan = trimSpan(content, contentStart)
      const name = buildWarpName(
        nameSpan.value,
        span(line, nameSpan.start, nameSpan.end),
      )
      const annotation = synthMissingAnnotation(
        span(line, contentEnd, contentEnd),
      )
      return assembleWarp(
        open,
        close,
        name,
        annotation,
        undefined,
        [],
        line,
        warpSource,
      )
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

      return Option.match(findChar(restRaw, '='), {
        onNone: () => {
          const { token: annotation, extras } = buildWarpAnnotation(
            restRaw,
            restStart,
            line,
          )
          return assembleWarp(
            open,
            close,
            name,
            annotation,
            undefined,
            extras,
            line,
            warpSource,
          )
        },
        onSome: (eqIdx) => {
          const annotationRaw = restRaw.slice(0, eqIdx)
          const defaultRaw = restRaw.slice(eqIdx + 1)
          const defaultStart = restStart + eqIdx + 1
          const { token: annotation, extras: annoExtras } = buildWarpAnnotation(
            annotationRaw,
            restStart,
            line,
          )
          const { token: defaultToken, extras: defExtras } = buildWarpDefault(
            defaultRaw,
            defaultStart,
            line,
          )
          return assembleWarp(
            open,
            close,
            name,
            annotation,
            defaultToken,
            [...annoExtras, ...defExtras],
            line,
            warpSource,
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
  source: string,
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
    ...extras.map(() => 'error' as const),
  ])
  return WarpTokenSchema.make({
    type: 'Warp',
    position: span(line, open.position.start.offset, close.position.end.offset),
    source,
    health: { status, diagnostics: [] },
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
  const anchorSource = lineText.slice(
    open.position.start.offset - lineStart,
    close.position.end.offset - lineStart,
  )

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
        ),
        extras: unexpectedIfNonEmpty(namePos, value),
      }),
      onRight: (name) => ({
        anchor: assembleAnchor(open, close, name, line, anchorSource),
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
): WarpAnchorToken => {
  const status = aggregateStatus([
    open.health.status,
    name.health.status,
    close.health.status,
  ])
  return WarpAnchorTokenSchema.make({
    type: 'WarpAnchor',
    position: span(line, open.position.start.offset, close.position.end.offset),
    source,
    health: { status, diagnostics: [] },
    open,
    name,
    close,
  })
}

const constructWarps = (
  lineText: string,
  linePosition: Position,
): {
  tokens: ReadonlyArray<WarpToken>
  unexpected: ReadonlyArray<UnexpectedToken>
} => {
  const opens = scanWarpOpen(lineText, linePosition)
  const closes = scanWarpClose(lineText, linePosition)
  const { pairs, stray } = pairWarpDelims(opens, closes, lineText, linePosition)
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
): {
  tokens: ReadonlyArray<WarpAnchorToken>
  unexpected: ReadonlyArray<UnexpectedToken>
} => {
  const built = scanAnchorOpens(delims.open, lineText, linePosition).map((open) =>
    buildWarpAnchor(
      open,
      anchorClose(open, delims.close, lineText, linePosition),
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
  readonly tag: Option.Option<TagToken>
  readonly specifier: Option.Option<SpecifierToken | PathSpecifierToken>
  readonly title: Option.Option<HeadingTitleToken>
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
  const specResult = constructSpecifier(
    specOpens,
    specCloses,
    lineText,
    position,
  )

  const unexpected = [...tagResult.unexpected, ...specResult.unexpected]

  const consumed: ReadonlyArray<Position> = [
    ...Option.toArray(tagResult.token).map((t) => t.position),
    ...Option.toArray(specResult.token).map((s) => s.position),
    ...unexpected.map((u) => u.position),
  ]
  const title = headingTitle(text, position, headingStartEnd, consumed)

  return {
    tag: tagResult.token,
    specifier: specResult.token,
    title,
    unexpected,
  }
}

const normaliseTitle = (title: string): string => {
  const pascal = (title.match(/[A-Za-z0-9]+/g) ?? [])
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('')
  return /^[A-Za-z]/.test(pascal) ? pascal : `_${pascal}`
}

const synthNameTag = (
  position: Position,
  title: Option.Option<HeadingTitleToken>,
): TagToken => {
  const eol = span(
    position.start.line,
    position.end.offset,
    position.end.offset,
  )
  const titleText = Option.match(title, {
    onNone: () => '',
    onSome: (t) => t.source,
  })
  const value = normaliseTitle(titleText)
  return TagTokenSchema.make({
    position: eol,
    source: '',
    health: okHealth,
    open: TagOpenTokenSchema.make({
      position: eol,
      source: '',
      health: okHealth,
      value: '[',
    }),
    label: TagLabelTokenSchema.make({
      type: 'TagLabel',
      position: eol,
      source: '',
      health: okHealth,
      value,
    }),
    close: TagCloseTokenSchema.make({
      position: eol,
      source: '',
      health: okHealth,
      value: ']',
    }),
  })
}

const tokeniseHeading = (text: string, weft: HeadingWeft): LoomWeft => {
  const { tag, specifier, title, unexpected } = scanHeading(
    text,
    weft.position,
    weft.headingStart.position.end.offset,
  )

  const resolvedTag = Option.getOrElse(tag, () =>
    synthNameTag(weft.position, title),
  )

  const status = aggregateStatus([
    weft.headingStart.health.status,
    resolvedTag.health.status,
    ...Option.toArray(specifier).map((s) => s.health.status),
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
    tag: resolvedTag,
    specifier: Option.getOrUndefined(specifier),
  })
}
