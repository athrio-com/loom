import { Array, Context, Effect, Layer, Match, Option, Result, Schema, Stream, pipe } from 'effect'
import {
  okHealth,
  type Health,
  type Position,
  type UnexpectedToken,
  UnexpectedTokenSchema,
} from '@athrio/loom-ast/LoomNode'
import {
  CodeTokenSchema,
  FrontmatterChapterTokenSchema,
  FrontmatterDiscussionTokenSchema,
  FrontmatterKeyTokenSchema,
  FrontmatterTropeTokenSchema,
  FrontmatterPartTokenSchema,
  FrontmatterPartNameTokenSchema,
  FrontmatterTitleTokenSchema,
  FrontmatterValueTokenSchema,
  HeadingTitleTokenSchema,
  ProseTokenSchema,
  SinkCloseTokenSchema,
  SinkFileLabelTokenSchema,
  SinkOpenTokenSchema,
  SinkTokenSchema,
  SpecifierCloseTokenSchema,
  SpecifierLabelTokenSchema,
  SpecifierOpenTokenSchema,
  SpecifierTokenSchema,
  ParameterKeyTokenSchema,
  ParameterTokenSchema,
  ParameterValueTokenSchema,
  ParametersTokenSchema,
  anchorKeys,
  anchorKinds,
  BoxFenceTokenSchema,
  BoxNameTokenSchema,
  BoxTokenSchema,
  boxKeys,
  type BoxNameToken,
  type BoxToken,
  TocChapterTokenSchema,
  TocDiscussionTokenSchema,
  TocPartTokenSchema,
  TocTitleTokenSchema,
  AnchorCloseTokenSchema,
  AnchorOpenTokenSchema,
  defaultAnchorDelims,
  WarpAnchorNameTokenSchema,
  WarpAnchorTargetTokenSchema,
  WarpAnchorTokenSchema,
  WarpAnnotationTokenSchema,
  WarpCloseTokenSchema,
  WarpDefaultTokenSchema,
  WarpNameTokenSchema,
  WarpOpenTokenSchema,
  WarpTokenSchema,
  closesFence,
  type Fence,
  FenceLabelTokenSchema,
  getProbe,
  openingFence,
  type SinkCloseToken,
  type SinkFileLabelToken,
  type SinkOpenToken,
  type SinkToken,
  type SpecifierCloseToken,
  type SpecifierLabelToken,
  type SpecifierOpenToken,
  type SpecifierToken,
  type ParameterToken,
  type ParametersToken,
  type AnchorCloseToken,
  type AnchorDelims,
  type AnchorOpenToken,
  type HeadingTitleToken,
  type WarpAnchorNameToken,
  type WarpAnchorTargetToken,
  type WarpAnchorToken,
  type WarpAnnotationToken,
  type WarpCloseToken,
  type WarpDefaultToken,
  type WarpNameToken,
  type WarpOpenToken,
  type WarpToken,
} from '@athrio/loom-ast/LoomTokens'
import {
  type BracesOn,
  ColonRun,
  EmptyLabel,
  faulty,
  LabelBesideParameter,
  NestedBox,
  MalformedLabel,
  MissingWarpValue,
  RepeatedKey,
  StrayFragment,
  UnclosedDelimiter,
  UnknownKey,
  UnknownKind,
  type EmptyConstruct,
  type MalformedConstruct,
} from '#ast/LoomFault'
import {
  type ArrowWeft,
  ArrowWeftSchema,
  type CodeWeft,
  CodeWeftSchema,
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
  type TocWeft,
  TocWeftSchema,
  nextBox,
} from '@athrio/loom-ast/Weft'

export class WeftTokeniser extends Context.Service<WeftTokeniser>()('WeftTokeniser', {
  make: Effect.succeed({
    tokeniseWefts:
      (text: string, delims: AnchorDelims = defaultAnchorDelims) =>
      (source: Stream.Stream<LoomWeft>): Stream.Stream<LoomWeft> =>
        Stream.mapAccum(
          source,
          () => noQuote,
          (state, weft) => {
            const [next, skipAnchors] = quoteStep(state, weft)
            return [next, [tokeniseWeft(text, weft, delims, skipAnchors)]]
          },
        ),
  }),
}) {
  static readonly layer = Layer.effect(this, this.make)
}

type QuoteState = {
  readonly quote: Option.Option<Fence>
  readonly inBox: boolean
}

const noQuote: QuoteState = { quote: Option.none(), inBox: false }

const isProseWeft = (weft: LoomWeft): boolean =>
  weft.type === 'PreambleWeft' || weft.type === 'TildeWeft' || weft.type === 'ProseWeft'

const quoteStep = (state: QuoteState, weft: LoomWeft): readonly [QuoteState, boolean] => {
  const inBox = nextBox(state.inBox, weft)
  return isProseWeft(weft)
    ? Option.match(state.quote, {
        onSome: (fence) => [
          { quote: closesFence(fence)(weft.source) ? Option.none() : state.quote, inBox },
          true,
        ],
        onNone: () => {
          const opened = state.inBox ? Option.none<Fence>() : openingFence(weft.source)
          return [{ quote: opened, inBox }, Option.isSome(opened)]
        },
      })
    : [{ quote: Option.none(), inBox }, false]
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
    Match.when({ type: 'TildeWeft' }, (w) => tokeniseTilde(text, w, delims, skipAnchors)),
    Match.when({ type: 'PreambleWeft' }, (w) => tokenisePreamble(text, w, delims, skipAnchors)),
    Match.when({ type: 'ProseWeft' }, (w) => tokeniseProse(text, w, delims, skipAnchors)),
    Match.when({ type: 'CodeWeft' }, (w) => tokeniseCode(text, w, delims)),
    Match.when({ type: 'FenceWeft' }, (w) => tokeniseFence(w)),
    Match.when({ type: 'FrontmatterWeft' }, (w) => tokeniseFrontmatter(w)),
    Match.when({ type: 'TocWeft' }, (w) => tokeniseToc(w)),
    Match.when({ type: 'DividerWeft' }, (w) => w),
    Match.exhaustive,
  )

const tokeniseFrontmatter = (weft: FrontmatterWeft): LoomWeft => {
  if (weft.fence !== undefined) return weft
  const lineText = weft.source
  const line = weft.position.start.line
  const base = weft.position.start.offset
  const colon = lineText.indexOf(':')
  if (colon < 0) return bareFrontmatter(weft)
  const key = trimSpan(lineText.slice(0, colon), base)
  const value = trimSpan(lineText.slice(colon + 1), base + colon + 1)
  return buildFrontmatterField(weft, line, key, value)
}

const frontmatterFields = new Set(['Target', 'Package', 'Language', 'Status', 'Priority'])

const buildFrontmatterField = (
  weft: FrontmatterWeft,
  line: number,
  key: TrimmedSpan,
  value: TrimmedSpan,
): FrontmatterWeft => {
  if (key.value.startsWith('Part ') && key.value.includes(', Chapter '))
    return belongingField(weft, line, key, value)
  if (key.value.startsWith('Part ') && key.value.includes(', Discussion '))
    return belongingDiscussion(weft, line, key, value)
  if (key.value.startsWith('Part '))
    return FrontmatterWeftSchema.make({
      position: weft.position,
      source: weft.source,
      health: okHealth,
      part: ordinalToken(FrontmatterPartTokenSchema, line, key, 'Part '),
      partName: fieldToken(FrontmatterPartNameTokenSchema, line, value),
    })
  if (key.value === 'Part')
    return FrontmatterWeftSchema.make({
      position: weft.position,
      source: weft.source,
      health: okHealth,
      partName: fieldToken(FrontmatterPartNameTokenSchema, line, value),
    })
  if (key.value.startsWith('Chapter '))
    return FrontmatterWeftSchema.make({
      position: weft.position,
      source: weft.source,
      health: okHealth,
      chapter: ordinalToken(FrontmatterChapterTokenSchema, line, key, 'Chapter '),
      title: fieldToken(FrontmatterTitleTokenSchema, line, value),
    })
  if (key.value === 'Chapter')
    return FrontmatterWeftSchema.make({
      position: weft.position,
      source: weft.source,
      health: okHealth,
      title: fieldToken(FrontmatterTitleTokenSchema, line, value),
    })
  if (key.value === 'Discussion' || key.value.startsWith('Discussion '))
    return FrontmatterWeftSchema.make({
      position: weft.position,
      source: weft.source,
      health: okHealth,
      discussion: ordinalToken(FrontmatterDiscussionTokenSchema, line, key, 'Discussion'),
      title: fieldToken(FrontmatterTitleTokenSchema, line, value),
    })
  if (key.value === 'Trope')
    return FrontmatterWeftSchema.make({
      position: weft.position,
      source: weft.source,
      health: okHealth,
      trope: fieldToken(FrontmatterTropeTokenSchema, line, value),
    })
  if (frontmatterFields.has(key.value))
    return FrontmatterWeftSchema.make({
      position: weft.position,
      source: weft.source,
      health: okHealth,
      key: fieldToken(FrontmatterKeyTokenSchema, line, key),
      value: fieldToken(FrontmatterValueTokenSchema, line, value),
    })
  return bareFrontmatter(weft)
}

const belongingDiscussion = (
  weft: FrontmatterWeft,
  line: number,
  key: TrimmedSpan,
  value: TrimmedSpan,
): FrontmatterWeft => {
  const comma = key.value.indexOf(',')
  const partSpan = trimSpan(key.value.slice(0, comma), key.start)
  const discussionSpan = trimSpan(key.value.slice(comma + 1), key.start + comma + 1)
  return FrontmatterWeftSchema.make({
    position: weft.position,
    source: weft.source,
    health: okHealth,
    part: ordinalToken(FrontmatterPartTokenSchema, line, partSpan, 'Part '),
    discussion: ordinalToken(FrontmatterDiscussionTokenSchema, line, discussionSpan, 'Discussion'),
    title: fieldToken(FrontmatterTitleTokenSchema, line, value),
  })
}

const belongingField = (
  weft: FrontmatterWeft,
  line: number,
  key: TrimmedSpan,
  value: TrimmedSpan,
): FrontmatterWeft => {
  const comma = key.value.indexOf(',')
  const partSpan = trimSpan(key.value.slice(0, comma), key.start)
  const chapterSpan = trimSpan(key.value.slice(comma + 1), key.start + comma + 1)
  return FrontmatterWeftSchema.make({
    position: weft.position,
    source: weft.source,
    health: okHealth,
    part: ordinalToken(FrontmatterPartTokenSchema, line, partSpan, 'Part '),
    chapter: ordinalToken(FrontmatterChapterTokenSchema, line, chapterSpan, 'Chapter '),
    title: fieldToken(FrontmatterTitleTokenSchema, line, value),
  })
}

type TrimmedSpan = {
  readonly value: string
  readonly start: number
  readonly end: number
}

const ordinalToken = <T>(
  schema: Scannable<T>,
  line: number,
  key: TrimmedSpan,
  keyword: string,
): T =>
  (schema as any).make({
    position: span(line, key.start, key.end),
    source: key.value,
    health: okHealth,
    value: key.value.slice(keyword.length).trim(),
  })

const fieldToken = <T>(schema: Scannable<T>, line: number, seg: TrimmedSpan): T =>
  (schema as any).make({
    position: span(line, seg.start, seg.end),
    source: seg.value,
    health: okHealth,
    value: seg.value,
  })

const bareFrontmatter = (weft: FrontmatterWeft): FrontmatterWeft =>
  FrontmatterWeftSchema.make({
    position: weft.position,
    source: weft.source,
    health: okHealth,
  })

const tocPartMarker = /^(#{1,6}\s+)(\S.*)$/
const tocChapterMarker = /^(\s*)(\d+)(\.\s+)(\S.*)$/
const tocDiscussionMarker = /^(\s*[-*]\s+)(.+?,\s*Discussion(?:\s+\S+)?)(:\s*)(\S.*)$/

const tokeniseToc = (weft: TocWeft): LoomWeft => {
  const line = weft.position.start.line
  const base = weft.position.start.offset
  const content = weft.source.replace(/\r?\n$/, '')

  const part = tocPartMarker.exec(content)
  if (part) {
    const partSpan = trimSpan(part[2], base + part[1].length)
    return TocWeftSchema.make({
      position: weft.position,
      source: weft.source,
      health: okHealth,
      part: fieldToken(TocPartTokenSchema, line, partSpan),
    })
  }

  const chapter = tocChapterMarker.exec(content)
  if (chapter) {
    const numStart = base + chapter[1].length
    const numSpan = trimSpan(chapter[2], numStart)
    const titleStart = numStart + chapter[2].length + chapter[3].length
    const titleSpan = trimSpan(chapter[4], titleStart)
    return TocWeftSchema.make({
      position: weft.position,
      source: weft.source,
      health: okHealth,
      chapter: fieldToken(TocChapterTokenSchema, line, numSpan),
      title: fieldToken(TocTitleTokenSchema, line, titleSpan),
    })
  }

  const discussion = tocDiscussionMarker.exec(content)
  if (discussion) {
    const placeStart = base + discussion[1].length
    const placeSpan = trimSpan(discussion[2], placeStart)
    const titleStart = placeStart + discussion[2].length + discussion[3].length
    return TocWeftSchema.make({
      position: weft.position,
      source: weft.source,
      health: okHealth,
      discussion: fieldToken(TocDiscussionTokenSchema, line, placeSpan),
      title: fieldToken(TocTitleTokenSchema, line, trimSpan(discussion[4], titleStart)),
    })
  }

  return TocWeftSchema.make({
    position: weft.position,
    source: weft.source,
    health: okHealth,
  })
}

const codeProbe = Option.getOrThrow(getProbe(CodeTokenSchema))
const proseProbe = Option.getOrThrow(getProbe(ProseTokenSchema))

const inlineAfter = <T>(
  schema: Schema.Schema<T>,
  probe: RegExp,
  text: string,
  linePosition: Position,
): Option.Option<T> => {
  const lineStart = linePosition.start.offset
  const lineText = text.slice(lineStart, linePosition.end.offset).replace(/\r?\n$/, '')
  return pipe(
    Option.fromNullishOr(probe.exec(lineText)),
    Option.filter((m): m is RegExpExecArray & { index: number } => m.index !== undefined),
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

const tokeniseArrow = (text: string, weft: ArrowWeft, delims: AnchorDelims): LoomWeft => {
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
    health: strayHealth(text, status, unexpected),
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
    health: strayHealth(text, status, unexpected),
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
): LoomWeft =>
  Option.match(Option.fromNullishOr(weft.box), {
    onSome: (box) => tokeniseBoxLine(text, weft, box),
    onNone: () => tokenisePreambleLine(text, weft, delims, skipAnchors),
  })

const tokenisePreambleLine = (
  text: string,
  weft: PreambleWeft,
  delims: AnchorDelims,
  skipAnchors: boolean,
): LoomWeft => {
  const lineText = lineSlice(text, weft.position)
  const scanText = blankIfSkipped(lineText, skipAnchors)
  const { tokens: warps, unexpected: warpStray } = constructWarps(lineText, weft.position, scanText)
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
    health: strayHealth(text, status, unexpected),
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
): LoomWeft =>
  Option.match(Option.fromNullishOr(weft.box), {
    onSome: (box) => tokeniseBoxLine(text, weft, box),
    onNone: () => tokeniseProseLine(text, weft, delims, skipAnchors),
  })

const tokeniseProseLine = (
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
    health: strayHealth(text, status, unexpected),
    unexpected: unexpected.length > 0 ? unexpected : undefined,
    anchors,
  })
}

const tokeniseCode = (text: string, weft: CodeWeft, delims: AnchorDelims): LoomWeft => {
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
    health: strayHealth(text, status, unexpected),
    unexpected: unexpected.length > 0 ? unexpected : undefined,
    anchors,
  })
}

const tokeniseFence = (weft: FenceWeft): LoomWeft => {
  const lineStart = weft.position.start.offset
  const after = weft.fence.position.end.offset
  const rest = weft.source.replace(/\r?\n$/, '').slice(after - lineStart)
  const name = rest.trim()
  const start = after + rest.length - rest.trimStart().length
  const label =
    weft.side === 'open' && name !== ''
      ? FenceLabelTokenSchema.make({
          position: span(weft.position.start.line, start, start + name.length),
          source: name,
          health: okHealth,
        })
      : undefined
  return FenceWeftSchema.make({ ...weft, health: okHealth, label })
}

const statusRank: Record<Health['status'], number> = {
  ok: 0,
  incomplete: 1,
  warning: 2,
  error: 3,
}

const joinStatus = (a: Health['status'], b: Health['status']): Health['status'] =>
  statusRank[a] >= statusRank[b] ? a : b

const aggregateStatus = (statuses: ReadonlyArray<Health['status']>): Health['status'] =>
  statuses.reduce(joinStatus, 'ok' as Health['status'])

const span = (line: number, start: number, end: number): Position => ({
  start: { line, offset: start },
  end: { line, offset: end },
})

const contentEnd = (lineText: string, lineStart: number): number =>
  lineStart + lineText.replace(/\r?\n$/, '').length

const missingClosing = (line: number, from: number, lineEnd: number, expected: string): Health =>
  faulty(UnclosedDelimiter({ expected }), span(line, from, lineEnd))

type Fragment = { readonly value: string; readonly position: Position }

const closerOf: Readonly<Record<string, string>> = { '{': '}', '[': ']' }

const closes = (opener: Fragment, stray: UnexpectedToken): boolean =>
  closerOf[opener.value] === stray.value && opener.position.start.line === stray.position.start.line

const strayFragments = (
  text: string,
  unexpected: ReadonlyArray<UnexpectedToken>,
): ReadonlyArray<Fragment> =>
  Array.reduce(unexpected, [] as ReadonlyArray<Fragment>, (fragments, stray) =>
    Option.match(
      Option.filter(Array.last(fragments), (last) => closes(last, stray)),
      {
        onNone: () => [...fragments, { value: stray.value, position: stray.position }],
        onSome: (opener) => [
          ...Array.dropRight(fragments, 1),
          {
            value: text.slice(opener.position.start.offset, stray.position.end.offset),
            position: { start: opener.position.start, end: stray.position.end },
          },
        ],
      },
    ),
  )

const strayHealth = (
  text: string,
  status: Health['status'],
  unexpected: ReadonlyArray<UnexpectedToken>,
): Health => ({
  status,
  diagnostics: Array.flatMap(
    strayFragments(text, unexpected),
    (fragment) => faulty(StrayFragment({ value: fragment.value }), fragment.position).diagnostics,
  ),
})

const brokenLabel = (construct: MalformedConstruct, value: string, position: Position): Health =>
  faulty(value === '' ? EmptyLabel({ construct }) : MalformedLabel({ construct, value }), position)

const decodeSpecifierLabel = Schema.decodeUnknownResult(SpecifierLabelTokenSchema)
const decodeSinkFileLabel = Schema.decodeUnknownResult(SinkFileLabelTokenSchema)

const buildSpecifierLabel = (value: string, position: Position): SpecifierLabelToken =>
  pipe(
    decodeSpecifierLabel({
      type: 'SpecifierLabel',
      position,
      source: value,
      health: okHealth,
      value,
    }),
    Result.getOrElse(() =>
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

const buildSinkFileLabel = (value: string, position: Position): SinkFileLabelToken =>
  pipe(
    decodeSinkFileLabel({
      type: 'SinkFileLabel',
      position,
      source: value,
      health: okHealth,
      value,
    }),
    Result.getOrElse(() =>
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

type Scannable<T> = Schema.Schema<T>

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
  const matchIdx = closes.findIndex((c) => c.position.start.offset > open.position.start.offset)
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
  const status = aggregateStatus([open.health.status, label.health.status, close.health.status])
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
  const specifierPos = span(line, open.position.start.offset, close.position.end.offset)
  const specifierSource = lineText.slice(
    specifierPos.start.offset - lineStart,
    specifierPos.end.offset - lineStart,
  )

  return {
    token: Option.some(
      buildLabelSpecifier(open, close, labelText, labelPos, specifierPos, specifierSource),
    ),
    unexpected: [...extraOpens.map(toUnexpected), ...extraCloses.map(toUnexpected)],
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
  const sinkPos = span(line, open.position.start.offset, close.position.end.offset)
  const sinkSource = lineText.slice(
    sinkPos.start.offset - lineStart,
    sinkPos.end.offset - lineStart,
  )

  const fileTrim = trimSpan(inner, innerStart)
  const file = buildSinkFileLabel(fileTrim.value, span(line, fileTrim.start, fileTrim.end))

  const status = aggregateStatus([open.health.status, file.health.status, close.health.status])

  return {
    token: Option.some(
      SinkTokenSchema.make({
        position: sinkPos,
        source: sinkSource,
        health: { status, diagnostics: [] },
        open,
        file,
        close,
      }),
    ),
    unexpected: [...extraOpens.map(toUnexpected), ...extraCloses.map(toUnexpected)],
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
  if (c === '<' || c === '(' || c === '[') return { depth: s.depth + 1, cut: s.cut }
  if (c === '>' || c === ')' || c === ']') return { depth: Math.max(0, s.depth - 1), cut: s.cut }
  if ((c === ',' || c === ';') && s.depth === 0) return { depth: s.depth, cut: Option.some(i) }
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

const trimSpan = (raw: string, rawStart: number): { value: string; start: number; end: number } => {
  const left = raw.match(/^\s*/)?.[0].length ?? 0
  const right = raw.match(/\s*$/)?.[0].length ?? 0
  return {
    value: raw.slice(left, raw.length - right),
    start: rawStart + left,
    end: rawStart + raw.length - right,
  }
}

const decodeWarpName = Schema.decodeUnknownResult(WarpNameTokenSchema)

const buildWarpName = (value: string, position: Position): WarpNameToken =>
  pipe(
    decodeWarpName({
      type: 'WarpName',
      position,
      source: value,
      health: okHealth,
      value,
    }),
    Result.getOrElse(() =>
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
  const health: Health = value === '' ? faulty(EmptyLabel({ construct }), tokenPos) : okHealth

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
      prev === '=' || prev === '!' || prev === '<' || prev === '>' || next === '=' || next === '>'
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
  const content = lineText.slice(contentStart - lineStart, contentEnd - lineStart)
  const warpSource = lineText.slice(
    open.position.start.offset - lineStart,
    close.position.end.offset - lineStart,
  )
  const warpPos = span(line, open.position.start.offset, close.position.end.offset)

  return Option.match(findAssign(content), {
    onSome: (eqIdx) => {
      const { name, annotation, extras } = splitDecl(content.slice(0, eqIdx), contentStart, line)
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
        name.health.status === 'ok'
          ? faulty(MissingWarpValue({ name: name.value }), warpPos)
          : okHealth
      return assembleWarp(open, close, name, annotation, undefined, extras, line, warpSource, own)
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

const unexpectedIfNonEmpty = (position: Position, value: string): ReadonlyArray<UnexpectedToken> =>
  value.length > 0 ? [UnexpectedTokenSchema.make({ position, value })] : []

const decodeWarpAnchorName = Schema.decodeUnknownResult(WarpAnchorNameTokenSchema)

type Braces = SpecifierToken | ParametersToken

const anchorSpecifierAt = (
  openAt: number,
  lineText: string,
  linePosition: Position,
): Option.Option<{ specifier: Braces; end: number }> =>
  lineText[openAt - linePosition.start.offset] === '{'
    ? bracesAt(openAt, lineText, linePosition, anchorBraces)
    : Option.none()

const anchorTargetAt = (
  close: AnchorCloseToken,
  lineText: string,
  linePosition: Position,
): Option.Option<{ target: WarpAnchorTargetToken; end: number }> => {
  const line = linePosition.start.line
  const lineStart = linePosition.start.offset
  const openAt = close.position.end.offset
  if (lineText[openAt - lineStart] !== '(') return Option.none()
  const closeRel = lineText.indexOf(')', openAt - lineStart)
  if (closeRel < 0) return Option.none()
  const closeAt = lineStart + closeRel
  const inner = lineText.slice(openAt + 1 - lineStart, closeAt - lineStart)
  return Option.some({
    target: WarpAnchorTargetTokenSchema.make({
      position: span(line, openAt, closeAt + 1),
      source: lineText.slice(openAt - lineStart, closeAt + 1 - lineStart),
      health: okHealth,
      value: inner.trim(),
    }),
    end: closeAt + 1,
  })
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
  const content = lineText.slice(contentStart - lineStart, contentEnd - lineStart)
  const { value, start, end } = trimSpan(content, contentStart)
  const namePos = span(line, start, end)
  const target = anchorTargetAt(close, lineText, linePosition)
  const afterTarget = Option.match(target, {
    onNone: () => close.position.end.offset,
    onSome: (t) => t.end,
  })
  const spec = anchorSpecifierAt(afterTarget, lineText, linePosition)
  const anchorEnd = Option.match(spec, { onNone: () => afterTarget, onSome: (s) => s.end })
  const anchorSource = lineText.slice(open.position.start.offset - lineStart, anchorEnd - lineStart)
  const targetTok = Option.getOrUndefined(Option.map(target, (t) => t.target))
  const specifier = Option.getOrUndefined(Option.map(spec, (s) => s.specifier))

  return pipe(
    decodeWarpAnchorName({
      type: 'WarpAnchorName',
      position: namePos,
      source: value,
      health: okHealth,
      value,
    }),
    Result.match({
      onFailure: () => ({
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
          anchorEnd,
          targetTok,
          specifier,
        ),
        extras: unexpectedIfNonEmpty(namePos, value),
      }),
      onSuccess: (name) => ({
        anchor: assembleAnchor(
          open,
          close,
          name,
          line,
          anchorSource,
          anchorEnd,
          targetTok,
          specifier,
        ),
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
  end: number,
  target: WarpAnchorTargetToken | undefined,
  specifier: Braces | undefined,
): WarpAnchorToken => {
  const status = aggregateStatus([
    open.health.status,
    name.health.status,
    close.health.status,
    ...(target ? [target.health.status] : []),
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
    target,
    specifier,
  })
}

type Span = { readonly start: number; readonly end: number; readonly value: string }

type BraceRules = {
  readonly on: BracesOn
  readonly keys: ReadonlyArray<string>
  readonly kinds: Option.Option<ReadonlyArray<string>>
}

const anchorBraces: BraceRules = {
  on: 'anchor',
  keys: anchorKeys,
  kinds: Option.some(anchorKinds),
}

const boxBraces: BraceRules = { on: 'box', keys: boxKeys, kinds: Option.none() }

type BraceItem =
  | { readonly type: 'word'; readonly word: Span }
  | {
      readonly type: 'parameter'
      readonly whole: Span
      readonly key: Span
      readonly values: ReadonlyArray<Span>
    }

const bracesAt = (
  openAt: number,
  lineText: string,
  linePosition: Position,
  rules: BraceRules,
): Option.Option<{ specifier: Braces; end: number }> => {
  const lineStart = linePosition.start.offset
  return pipe(
    itemsFrom(lineText, openAt - lineStart + 1, []),
    Option.flatMap(({ items, closeAt }) =>
      Option.map(
        specifierOf(openAt, lineStart + closeAt, items, lineText, linePosition, rules),
        (specifier) => ({ specifier, end: lineStart + closeAt + 1 }),
      ),
    ),
    Option.orElse(() => labelBracesAt(openAt, lineText, linePosition)),
  )
}

const isWord = (item: BraceItem): boolean => item.type === 'word'

const wordOf = (item: BraceItem): Option.Option<Span> =>
  item.type === 'word' ? Option.some(item.word) : Option.none()

const isKindIn =
  (kinds: ReadonlyArray<string>) =>
  (label: string): boolean =>
    Array.some(kinds, (kind) => kind.toLowerCase() === label.toLowerCase())

const braceTokens = (
  openAt: number,
  closeAt: number,
  line: number,
): { open: SpecifierOpenToken; close: SpecifierCloseToken } => ({
  open: SpecifierOpenTokenSchema.make({
    position: span(line, openAt, openAt + 1),
    source: '{',
    health: okHealth,
    value: '{',
  }),
  close: SpecifierCloseTokenSchema.make({
    position: span(line, closeAt, closeAt + 1),
    source: '}',
    health: okHealth,
    value: '}',
  }),
})

const labelBracesAt = (
  openAt: number,
  lineText: string,
  linePosition: Position,
): Option.Option<{ specifier: Braces; end: number }> => {
  const lineStart = linePosition.start.offset
  const closeRel = lineText.indexOf('}', openAt - lineStart)
  if (closeRel < 0) return Option.none()
  const closeAt = lineStart + closeRel
  const { open, close } = braceTokens(openAt, closeAt, linePosition.start.line)
  return Option.map(
    constructSpecifier([open], [close], lineText, linePosition).token,
    (specifier) => ({ specifier, end: closeAt + 1 }),
  )
}

const matchAt = (pattern: RegExp, text: string, at: number): Option.Option<RegExpMatchArray> =>
  Option.fromNullishOr(text.slice(at).match(pattern))

const skipSpaces = (text: string, at: number): number => at + text.slice(at).search(/[^ ]|$/)

const spanOf = (text: string, start: number, end: number): Span => ({
  start,
  end,
  value: text.slice(start, end),
})

const endOf = (item: BraceItem): number =>
  Match.value(item).pipe(
    Match.when({ type: 'word' }, ({ word }) => word.end),
    Match.when({ type: 'parameter' }, ({ whole }) => whole.end),
    Match.exhaustive,
  )

const itemsFrom = (
  text: string,
  at: number,
  found: ReadonlyArray<BraceItem>,
): Option.Option<{ items: ReadonlyArray<BraceItem>; closeAt: number }> => {
  const next = skipSpaces(text, at)
  return text[next] === '}'
    ? Option.filter(Option.some({ items: found, closeAt: next }), () => found.length > 0)
    : pipe(
        Option.orElse(parameterAt(text, next), () => wordAt(text, next)),
        Option.filter((item) => text[endOf(item)] === ' ' || text[endOf(item)] === '}'),
        Option.flatMap((item) => itemsFrom(text, endOf(item), [...found, item])),
      )
}

const wordAt = (text: string, at: number): Option.Option<BraceItem> =>
  Option.map(matchAt(/^[A-Za-z0-9_-]+/, text, at), (match): BraceItem => ({
    type: 'word',
    word: spanOf(text, at, at + match[0].length),
  }))

const valueAt = (text: string, at: number): Option.Option<Span> =>
  Option.orElse(
    Option.map(matchAt(/^"((?:[^"\\]|\\.)*)"/, text, at), (match) => ({
      start: at,
      end: at + match[0].length,
      value: (match[1] ?? '').replace(/\\(.)/g, '$1'),
    })),
    () =>
      Option.map(matchAt(/^[A-Za-z0-9_.-]+/, text, at), (match) =>
        spanOf(text, at, at + match[0].length),
      ),
  )

const listAt = (
  text: string,
  at: number,
): Option.Option<{ values: ReadonlyArray<Span>; end: number }> =>
  text[at] === '[' ? listFrom(text, skipSpaces(text, at + 1), []) : Option.none()

const listFrom = (
  text: string,
  at: number,
  found: ReadonlyArray<Span>,
): Option.Option<{ values: ReadonlyArray<Span>; end: number }> =>
  Option.flatMap(valueAt(text, at), (value) => {
    const next = skipSpaces(text, value.end)
    return Match.value(text[next]).pipe(
      Match.when(',', () => listFrom(text, skipSpaces(text, next + 1), [...found, value])),
      Match.when(']', () => Option.some({ values: [...found, value], end: next + 1 })),
      Match.orElse(() => Option.none()),
    )
  })

const parameterAt = (text: string, at: number): Option.Option<BraceItem> =>
  Option.flatMap(matchAt(/^([A-Za-z_][A-Za-z0-9_-]*)=/, text, at), (match) => {
    const from = at + match[0].length
    return Option.map(
      Option.orElse(listAt(text, from), () =>
        Option.map(valueAt(text, from), (value) => ({ values: [value], end: value.end })),
      ),
      ({ values, end }): BraceItem => ({
        type: 'parameter',
        whole: spanOf(text, at, end),
        key: spanOf(text, at, from - 1),
        values,
      }),
    )
  })

const specifierOf = (
  openAt: number,
  closeAt: number,
  items: ReadonlyArray<BraceItem>,
  lineText: string,
  linePosition: Position,
  rules: BraceRules,
): Option.Option<Braces> => {
  const { open, close } = braceTokens(openAt, closeAt, linePosition.start.line)
  return Array.every(items, isWord)
    ? Option.map(
        constructSpecifier([open], [close], lineText, linePosition).token,
        kindChecked(rules),
      )
    : Option.some(parametersOf(open, close, items, lineText, linePosition, rules))
}

const unknownTo = (rules: BraceRules, kind: string): Option.Option<ReadonlyArray<string>> =>
  Option.filter(rules.kinds, (kinds) => !isKindIn(kinds)(kind))

const kindChecked =
  (rules: BraceRules) =>
  (specifier: SpecifierToken): SpecifierToken =>
    Option.match(
      Option.filter(
        unknownTo(rules, specifier.label.value),
        () => specifier.label.health.status === 'ok',
      ),
      {
        onNone: () => specifier,
        onSome: (kinds) =>
          SpecifierTokenSchema.make({
            ...specifier,
            health: { status: 'error', diagnostics: [] },
            label: SpecifierLabelTokenSchema.make({
              ...specifier.label,
              health: faulty(
                UnknownKind({ kind: specifier.label.value, kinds, on: rules.on }),
                specifier.label.position,
              ),
            }),
          }),
      },
    )

const parametersOf = (
  open: SpecifierOpenToken,
  close: SpecifierCloseToken,
  items: ReadonlyArray<BraceItem>,
  lineText: string,
  linePosition: Position,
  rules: BraceRules,
): ParametersToken => {
  const lineStart = linePosition.start.offset
  const at = (piece: Span): Position =>
    span(linePosition.start.line, lineStart + piece.start, lineStart + piece.end)
  const written = Array.getSomes(Array.map(items, parameterOf))
  const parameters = Array.map(written, (parameter, index) =>
    parameterToken(parameter, Array.take(written, index), lineText, at, rules),
  )
  const labels = labelFaults(items, at)
  const position = span(
    linePosition.start.line,
    open.position.start.offset,
    close.position.end.offset,
  )
  return ParametersTokenSchema.make({
    position,
    source: lineText.slice(position.start.offset - lineStart, position.end.offset - lineStart),
    health: {
      status: aggregateStatus([
        ...parameters.map((parameter) => parameter.health.status),
        ...labels.map((label) => label.status),
      ]),
      diagnostics: Array.flatMap(labels, (label) => label.diagnostics),
    },
    open,
    parameters,
    close,
  })
}

type WrittenParameter = Extract<BraceItem, { type: 'parameter' }>

const parameterOf = (item: BraceItem): Option.Option<WrittenParameter> =>
  item.type === 'parameter' ? Option.some(item) : Option.none()

const parameterToken = (
  parameter: WrittenParameter,
  earlier: ReadonlyArray<WrittenParameter>,
  lineText: string,
  at: (piece: Span) => Position,
  rules: BraceRules,
): ParameterToken => {
  const key = parameter.key.value
  const strange = Array.head(
    Array.getSomes(
      Array.map(parameter.values, (value) =>
        Option.map(unknownTo(rules, value.value), (kinds) => ({ value, kinds })),
      ),
    ),
  )
  const health = Match.value({
    repeated: Array.some(earlier, (before) => before.key.value === key),
    known: Array.contains(rules.keys, key),
    kind: key === 'kind',
  }).pipe(
    Match.when({ repeated: true }, () => faulty(RepeatedKey({ key }), at(parameter.key))),
    Match.when({ known: false }, () =>
      faulty(UnknownKey({ key, keys: rules.keys, on: rules.on }), at(parameter.key)),
    ),
    Match.when({ kind: true }, () =>
      Option.match(strange, {
        onNone: () => okHealth,
        onSome: ({ value, kinds }) =>
          faulty(UnknownKind({ kind: value.value, kinds, on: rules.on }), at(value)),
      }),
    ),
    Match.orElse(() => okHealth),
  )
  return ParameterTokenSchema.make({
    position: at(parameter.whole),
    source: parameter.whole.value,
    health,
    key: ParameterKeyTokenSchema.make({
      position: at(parameter.key),
      source: key,
      health: okHealth,
      value: key,
    }),
    values: Array.map(parameter.values, (value) =>
      ParameterValueTokenSchema.make({
        position: at(value),
        source: lineText.slice(value.start, value.end),
        health: okHealth,
        value: value.value,
      }),
    ),
  })
}

const labelFaults = (
  items: ReadonlyArray<BraceItem>,
  at: (piece: Span) => Position,
): ReadonlyArray<Health> =>
  Array.match(items, {
    onEmpty: (): ReadonlyArray<Health> => [],
    onNonEmpty: (all) =>
      pipe(
        Array.groupWith(all, (one, other) => one.type === other.type),
        Array.map((run) => Array.getSomes(Array.map(run, wordOf))),
        Array.flatMap((run) =>
          Array.match(run, {
            onEmpty: (): ReadonlyArray<Health> => [],
            onNonEmpty: (words) => [
              faulty(
                LabelBesideParameter({
                  label: Array.join(
                    words.map((word) => word.value),
                    ' ',
                  ),
                }),
                {
                  start: at(Array.headNonEmpty(words)).start,
                  end: at(Array.lastNonEmpty(words)).end,
                },
              ),
            ],
          }),
        ),
      ),
  })

const tokeniseBoxLine = <Line extends PreambleWeft | ProseWeft>(
  text: string,
  weft: Line,
  box: BoxToken,
): Line => {
  const settled = settledBox(text, weft.position, box)
  return {
    ...weft,
    source: lineSlice(text, weft.position),
    health: { status: settled.health.status, diagnostics: [] },
    box: settled,
  }
}

const settledBox = (text: string, linePosition: Position, box: BoxToken): BoxToken =>
  Match.value(box.side).pipe(
    Match.when('open', () => openedBox(text, linePosition, box)),
    Match.when('close', () => BoxTokenSchema.make({ ...box, health: okHealth })),
    Match.when('stray', () => strayBox(box)),
    Match.exhaustive,
  )

const trailingBraces = /\{[^{}]*\}[ \t]*$/

const trailingBracesAt = (content: string, from: number): Option.Option<number> =>
  Option.map(
    Option.fromNullishOr(trailingBraces.exec(content.slice(from))),
    (match) => from + match.index,
  )

const boxNameAt = (raw: string, rawStart: number, line: number): Option.Option<BoxNameToken> => {
  const { value, start, end } = trimSpan(raw, rawStart)
  return value === ''
    ? Option.none()
    : Option.some(
        BoxNameTokenSchema.make({
          position: span(line, start, end),
          source: value,
          health: okHealth,
          value,
        }),
      )
}

const openedBox = (text: string, linePosition: Position, box: BoxToken): BoxToken => {
  const lineText = lineSlice(text, linePosition)
  const lineStart = linePosition.start.offset
  const content = lineText.replace(/\r?\n$/, '')
  const from = box.fence.position.end.offset - lineStart
  const braces = Option.flatMap(trailingBracesAt(content, from), (openAt) =>
    bracesAt(lineStart + openAt, lineText, linePosition, boxBraces),
  )
  const specifier = Option.map(braces, (held) => held.specifier)
  const nameEnd = Option.match(specifier, {
    onNone: () => content.length,
    onSome: (held) => held.position.start.offset - lineStart,
  })
  const name = boxNameAt(content.slice(from, nameEnd), lineStart + from, linePosition.start.line)
  return BoxTokenSchema.make({
    ...box,
    health: {
      status: aggregateStatus([
        box.fence.health.status,
        ...Option.toArray(specifier).map((held) => held.health.status),
      ]),
      diagnostics: [],
    },
    name: Option.getOrUndefined(name),
    specifier: Option.getOrUndefined(specifier),
  })
}

const strayBox = (box: BoxToken): BoxToken => {
  const health = faulty(
    box.fence.source.length > 3 ? ColonRun({ colons: box.fence.source }) : NestedBox(),
    box.fence.position,
  )
  return BoxTokenSchema.make({
    ...box,
    health: { status: health.status, diagnostics: [] },
    fence: BoxFenceTokenSchema.make({ ...box.fence, health }),
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
  const tokens = pairs.map(({ open, close }) => buildWarp(open, close, lineText, linePosition))
  return { tokens, unexpected: stray }
}

const indicesOf = (text: string, needle: string): ReadonlyArray<number> => {
  const step = (found: ReadonlyArray<number>, from: number): ReadonlyArray<number> => {
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
    .reduce((min, offset) => Math.min(min, offset), position.end.offset - trailingWs)

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

const scanHeading = (text: string, position: Position, headingStartEnd: number): HeadingTokens => {
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
    health: strayHealth(text, status, unexpected),
    unexpected: unexpected.length > 0 ? unexpected : undefined,
    headingStart: weft.headingStart,
    title: Option.getOrUndefined(title),
    specifier: Option.getOrUndefined(specifier),
    sink: Option.getOrUndefined(sink),
  })
}
