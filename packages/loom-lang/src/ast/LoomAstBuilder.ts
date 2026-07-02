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
  LoomFrontmatterSchema,
  LoomHeadingSchema,
  LoomSectionSchema,
  type LoomDocument,
  type LoomFrontmatter,
  type LoomHeading,
  type LoomSection,
} from '@athrio/loom-ast/LoomAst'
import type { FrontmatterValueToken } from '@athrio/loom-ast/LoomTokens'
import { okHealth, type Position } from '@athrio/loom-ast/LoomNode'
import type { MixedEOL } from './LineRanges'
import type {
  FrontmatterWeft,
  HeadingWeft,
  LoomWeft,
  PreambleWeft,
  SectionBodyWeft,
} from '@athrio/loom-ast/Weft'

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

type TopLevelNode = PreambleWeft | LoomSection | FrontmatterWeft

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
    Match.when({ type: 'FrontmatterWeft' }, (weft) =>
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
  readonly frontmatter: ReadonlyArray<FrontmatterWeft>
  readonly preamble: ReadonlyArray<PreambleWeft>
  readonly sections: ReadonlyArray<LoomSection>
}

const initialDocument: DocumentBuilder = {
  frontmatter: [],
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
    Match.when({ type: 'FrontmatterWeft' }, (weft) => ({
      ...doc,
      frontmatter: [...doc.frontmatter, weft],
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
    specifier: weft.specifier,
    sink: weft.sink,
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

const makeFrontmatter = (
  wefts: ReadonlyArray<FrontmatterWeft>,
): Option.Option<LoomFrontmatter> => {
  if (wefts.length === 0) return Option.none()
  const membership = Option.match(
    Option.fromNullable(wefts.find((w) => w.part !== undefined)),
    {
      onNone: () => ({}),
      onSome: (w) => ({ part: w.part, chapter: w.chapter, title: w.title }),
    },
  )
  return Option.some(
    LoomFrontmatterSchema.make({
      position: {
        start: wefts[0].position.start,
        end: wefts[wefts.length - 1].position.end,
      },
      source: sourceOf(wefts),
      health: okHealth,
      ...membership,
      package: Option.getOrUndefined(frontmatterField(wefts, 'Package')),
      language: Option.getOrUndefined(frontmatterField(wefts, 'Language')),
    }),
  )
}

const frontmatterField = (
  wefts: ReadonlyArray<FrontmatterWeft>,
  key: string,
): Option.Option<FrontmatterValueToken> =>
  pipe(
    Option.fromNullable(
      wefts.find((w) => w.key !== undefined && w.key.value === key),
    ),
    Option.flatMapNullable((w) => w.value),
  )

const documentSpan = (db: DocumentBuilder): Position => {
  const all: ReadonlyArray<{ readonly position: Position }> = [
    ...db.frontmatter,
    ...db.preamble,
    ...db.sections,
  ]
  return all.length === 0
    ? { start: { line: 1, offset: 0 }, end: { line: 1, offset: 0 } }
    : { start: all[0].position.start, end: all[all.length - 1].position.end }
}

const makeDocument = (db: DocumentBuilder): LoomDocument => {
  const position = documentSpan(db)
  return LoomDocumentSchema.make({
    position,
    source: sourceOf(db.frontmatter, db.preamble, db.sections),
    health: okHealth,
    frontmatter: Option.getOrUndefined(makeFrontmatter(db.frontmatter)),
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
