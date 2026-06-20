import {
  Chunk,
  Effect,
  Function,
  Match,
  Option,
  Sink,
  Stream,
  pipe,
} from 'effect'
import {
  LoomDocumentSchema,
  LoomHeadingSchema,
  LoomSectionSchema,
  type LoomDocument,
  type LoomHeading,
  type LoomSection,
} from './LoomAst'
import { okHealth, type Health, type Position } from './LoomNode'
import type { MixedEOL } from './LineRanges'
import type {
  HeadingWeft,
  LoomWeft,
  PreambleWeft,
  SectionBodyWeft,
} from './Weft'

export class LoomAstBuilder extends Effect.Service<LoomAstBuilder>()(
  'LoomAstBuilder',
  {
    succeed: {
      build: (source: Stream.Stream<LoomWeft>): Effect.Effect<LoomDocument> =>
        source.pipe(
          Stream.transduce(nodeSink),
          Stream.filterMap(Function.identity),
          Stream.runFold(initialDocument, appendToDocument),
          Effect.map(makeDocument),
        ),
    },
  },
) {}

const parsingSink = <In, A>(
  dispatch: (item: In) => Sink.Sink<A, In, In>,
): Sink.Sink<Option.Option<A>, In, In> =>
  Sink.head<In>().pipe(
    Sink.flatMap(
      Option.match({
        onNone: () => Sink.succeed(Option.none<A>()),
        onSome: (item) => dispatch(item).pipe(Sink.map(Option.some)),
      }),
    ),
  )

const isHeading = (w: LoomWeft): w is HeadingWeft => w.type === 'HeadingWeft'

const isSectionBody = (w: LoomWeft): w is SectionBodyWeft =>
  w.type === 'ArrowWeft' ||
  w.type === 'CodeWeft' ||
  w.type === 'TildeWeft' ||
  w.type === 'ProseWeft'

const isPreamble = (w: LoomWeft): w is PreambleWeft => w.type === 'PreambleWeft'

type TopLevelNode = PreambleWeft | LoomSection

const nodeSink = parsingSink<LoomWeft, TopLevelNode>((w) => dispatchNode(w))

const dispatchNode = (
  w: LoomWeft,
): Sink.Sink<TopLevelNode, LoomWeft, LoomWeft> =>
  pipe(
    Match.value(w),
    Match.when({ type: 'HeadingWeft' }, sectionSink),
    Match.when({ type: 'PreambleWeft' }, (weft) =>
      Sink.succeed<TopLevelNode>(weft),
    ),
    Match.when({ type: 'ArrowWeft' }, unexpectedAtTop),
    Match.when({ type: 'CodeWeft' }, unexpectedAtTop),
    Match.when({ type: 'TildeWeft' }, unexpectedAtTop),
    Match.when({ type: 'ProseWeft' }, unexpectedAtTop),
    Match.exhaustive,
  )

const unexpectedAtTop = (
  w: LoomWeft,
): Sink.Sink<TopLevelNode, LoomWeft, LoomWeft> =>
  Sink.die(`dispatchNode: unexpected ${w.type} at top level`)

const sectionSink = (
  heading: HeadingWeft,
): Sink.Sink<LoomSection, LoomWeft, LoomWeft> =>
  Sink.collectAllWhile<LoomWeft>((w) => !isHeading(w)).pipe(
    Sink.map((body) => buildSection(heading, body)),
  )

type DocumentBuilder = {
  readonly preamble: ReadonlyArray<PreambleWeft>
  readonly sections: ReadonlyArray<LoomSection>
}

const initialDocument: DocumentBuilder = {
  preamble: [],
  sections: [],
}

const appendToDocument = (
  doc: DocumentBuilder,
  node: TopLevelNode,
): DocumentBuilder =>
  pipe(
    Match.value(node),
    Match.when({ type: 'LoomSection' }, (section) => ({
      ...doc,
      sections: [...doc.sections, section],
    })),
    Match.when({ type: 'PreambleWeft' }, (weft) => ({
      ...doc,
      preamble: [...doc.preamble, weft],
    })),
    Match.exhaustive,
  )

const buildSection = (
  heading: HeadingWeft,
  body: Chunk.Chunk<LoomWeft>,
): LoomSection => {
  const h = headingOf(heading)
  const preamble = Chunk.toReadonlyArray(Chunk.filter(body, isPreamble))
  const code = Chunk.toReadonlyArray(Chunk.filter(body, isSectionBody))
  return LoomSectionSchema.make({
    position: spanFrom(h.position, preamble, code),
    source: sourceOf(h, preamble, code),
    health: okHealth,
    heading: h,
    preamble,
    code,
  })
}

const headingOf = (weft: HeadingWeft): LoomHeading =>
  LoomHeadingSchema.make({
    position: weft.position,
    source: weft.source,
    health: weft.health,
    unexpected: weft.unexpected,
    headingStart: weft.headingStart,
    title: weft.title,
    tag: weft.tag,
    specifier: weft.specifier,
  })

const sourceOf = (
  ...groups: ReadonlyArray<
    { readonly source: string } | ReadonlyArray<{ readonly source: string }>
  >
): string =>
  groups
    .flatMap((g) => (Array.isArray(g) ? g : [g as { readonly source: string }]))
    .map((n) => n.source)
    .join('')

const spanFrom = (
  headingPos: Position,
  ...groups: ReadonlyArray<ReadonlyArray<{ readonly position: Position }>>
): Position => {
  const flat = groups.flat()
  return {
    start: headingPos.start,
    end:
      flat.length === 0 ? headingPos.end : flat[flat.length - 1].position.end,
  }
}

const documentSpan = (db: DocumentBuilder): Position => {
  const all: ReadonlyArray<{ readonly position: Position }> = [
    ...db.preamble,
    ...db.sections,
  ]
  return all.length === 0
    ? { start: { line: 1, offset: 0 }, end: { line: 1, offset: 0 } }
    : { start: all[0].position.start, end: all[all.length - 1].position.end }
}

const hasLangWarp = (preamble: ReadonlyArray<PreambleWeft>): boolean =>
  preamble.some((weft) => weft.warps.some((warp) => warp.name.value === 'lang'))

const documentHealth = (db: DocumentBuilder, position: Position): Health =>
  hasLangWarp(db.preamble)
    ? okHealth
    : {
        status: 'warning',
        diagnostics: [
          {
            message:
              'No `{{lang: …}}` declaration in the Document Preamble; the primary language is unknown.',
            position: { start: position.start, end: position.start },
            severity: 'warning',
          },
        ],
      }

const makeDocument = (db: DocumentBuilder): LoomDocument => {
  const position = documentSpan(db)
  return LoomDocumentSchema.make({
    position,
    source: sourceOf(db.preamble, db.sections),
    health: documentHealth(db, position),
    preamble: db.preamble,
    sections: db.sections,
  })
}

export const emptyDocument = (text: string, message: string): LoomDocument => {
  const position: Position = {
    start: { line: 1, offset: 0 },
    end: { line: 1, offset: text.length },
  }
  return {
    type: 'LoomDocument',
    position,
    source: text,
    health: {
      status: 'error',
      diagnostics: [{ message, position, severity: 'error' }],
    },
    preamble: [],
    sections: [],
  }
}

export const emptyDocumentFor = (text: string, err: MixedEOL): LoomDocument =>
  emptyDocument(
    text,
    `Mixed line terminators. Line ${err.primaryLine} has ${eolName(err.primary)}, but line ${err.foundLine} has ${eolName(err.found)}. Pick one and stick with it.`,
  )

const eolName = (kind: 'lf' | 'crlf' | 'cr'): string => {
  switch (kind) {
    case 'lf':
      return 'LF (Unix)'
    case 'crlf':
      return 'CRLF (Windows)'
    case 'cr':
      return 'CR (classic Mac)'
  }
}
