import {
  Array,
  Context,
  Effect,
  Layer,
  Match,
  Option,
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
  TocWeft,
} from '@athrio/loom-ast/Weft'

export class LoomAstBuilder extends Context.Service<LoomAstBuilder>()(
  'LoomAstBuilder',
  {
    make: Effect.succeed({
      build: (source: Stream.Stream<LoomWeft>): Effect.Effect<LoomDocument> =>
        Stream.runCollect(source).pipe(
          Effect.map((wefts) =>
            makeDocument(
              Array.reduce(groupNodes(wefts), initialDocument, appendToDocument),
            ),
          ),
        ),
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make)
}

const isHeading = (w: LoomWeft): w is HeadingWeft => w.type === 'HeadingWeft'

const isSectionBody = (w: LoomWeft): w is SectionBodyWeft =>
  w.type === 'ArrowWeft' ||
  w.type === 'CodeWeft' ||
  w.type === 'TildeWeft' ||
  w.type === 'ProseWeft'

const isPreamble = (w: LoomWeft): w is PreambleWeft => w.type === 'PreambleWeft'

const isToc = (w: LoomWeft): w is TocWeft => w.type === 'TocWeft'

const isTopLevelWeft = (w: LoomWeft): w is FrontmatterWeft | PreambleWeft =>
  w.type === 'FrontmatterWeft' || w.type === 'PreambleWeft'

type TopLevelNode = FrontmatterWeft | PreambleWeft | LoomSection

const sectionChunk = (
  group: Array.NonEmptyReadonlyArray<LoomWeft>,
): readonly [Option.Option<LoomSection>, ReadonlyArray<LoomWeft>] => {
  const [body, rest] = Array.span(Array.drop(group, 1), (w) => !isHeading(w))
  const heading = group[0]
  return [
    isHeading(heading)
      ? Option.some(buildSection(heading, body))
      : Option.none(),
    rest,
  ]
}

const groupNodes = (
  wefts: ReadonlyArray<LoomWeft>,
): ReadonlyArray<TopLevelNode> => {
  const [preamble, sections] = Array.span(wefts, (w) => !isHeading(w))
  return [
    ...Array.filter(preamble, isTopLevelWeft),
    ...Array.getSomes(Array.chop(sections, sectionChunk)),
  ]
}

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
  body: ReadonlyArray<LoomWeft>,
): LoomSection => {
  const h = headingOf(heading)
  const preamble = body.filter(isPreamble)
  const code = body.filter(isSectionBody)
  const entries = body.filter(isToc)
  return LoomSectionSchema.make({
    position: spanFrom(h.position, preamble, code, entries),
    source: sourceOf(h, preamble, code, entries),
    health: okHealth,
    heading: h,
    preamble,
    code,
    entries: entries.length > 0 ? entries : undefined,
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
  pipe(
    groups,
    Array.flatMap((g) => Array.ensure(g)),
    Array.map((n) => n.source),
    Array.join(''),
  )

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
  const partFields = Option.match(
    Option.fromNullishOr(wefts.find((w) => w.part !== undefined)),
    {
      onNone: () => ({}),
      onSome: (w) => ({ part: w.part, partName: w.partName }),
    },
  )
  const chapterFields = Option.match(
    Option.fromNullishOr(wefts.find((w) => w.chapter !== undefined)),
    {
      onNone: () => ({}),
      onSome: (w) => ({ chapter: w.chapter, title: w.title }),
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
      ...partFields,
      ...chapterFields,
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
    Option.fromNullishOr(
      wefts.find((w) => w.key !== undefined && w.key.value === key),
    ),
    Option.flatMapNullishOr((w) => w.value),
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
