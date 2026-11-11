import { Array, Context, Data, Effect, Layer, Match, Option, Stream, pipe } from 'effect'
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
import {
  boxKind,
  type BoxToken,
  chapterKind,
  conclusionKind,
  type FrontmatterValueToken,
  isPointingKind,
  type HeadingTitleToken,
  HeadingTitleTokenSchema,
  openingFence,
} from '@athrio/loom-ast/LoomTokens'
import { okHealth, type Position } from '@athrio/loom-ast/LoomNode'
import type { MixedEOL } from './LineRanges'
import {
  ChapterBoxBesideCode,
  ConclusionOutsideTopic,
  SecondConclusion,
  DividerAgainstCode,
  faulty,
  HeadingAgainstCode,
  type LoomFault,
  UnclosedBox,
  UnclosedFence,
  UnnamedBox,
} from './LoomFault'
import {
  boxOf,
  type DividerWeft,
  type FenceWeft,
  type FrontmatterWeft,
  type HeadingWeft,
  type LoomWeft,
  type PreambleWeft,
  type ProseWeft,
  type SectionBodyWeft,
} from '@athrio/loom-ast/Weft'

export class LoomAstBuilder extends Context.Service<LoomAstBuilder>()('LoomAstBuilder', {
  make: Effect.succeed({
    build: (source: Stream.Stream<LoomWeft>): Effect.Effect<LoomDocument> =>
      Stream.runCollect(source).pipe(
        Effect.map((wefts) =>
          makeDocument(
            Array.reduce(
              groupNodes(
                warnDividerAgainstCode(
                  warnHeadingAgainstCode(faultUnclosedBox(faultUnclosedFence(wefts))),
                ),
              ),
              initialDocument,
              appendToDocument,
            ),
          ),
        ),
      ),
  }),
}) {
  static readonly layer = Layer.effect(this, this.make)
}

const isFence = (weft: LoomWeft): weft is FenceWeft => weft.type === 'FenceWeft'

const opensFence = (weft: LoomWeft): boolean => isFence(weft) && weft.side === 'open'

const unclosedFence = (wefts: ReadonlyArray<LoomWeft>): Option.Option<number> =>
  pipe(
    Array.findLastIndex(wefts, isFence),
    Option.filter((at) => Option.exists(Array.get(wefts, at), opensFence)),
  )

const faultedFence = (weft: FenceWeft): FenceWeft => ({
  ...weft,
  fence: {
    ...weft.fence,
    health: faulty(UnclosedFence({ fence: weft.fence.source }), weft.fence.position),
  },
})

const faultUnclosedFence = (wefts: ReadonlyArray<LoomWeft>): ReadonlyArray<LoomWeft> =>
  Option.match(unclosedFence(wefts), {
    onNone: () => wefts,
    onSome: (open) =>
      Array.map(wefts, (weft, at) => (at === open && isFence(weft) ? faultedFence(weft) : weft)),
  })

const isBoxEdge = (weft: LoomWeft): boolean =>
  Option.exists(boxOf(weft), (box) => box.side !== 'stray')

const opensBox = (weft: LoomWeft): boolean =>
  Option.exists(boxOf(weft), (box) => box.side === 'open')

const unclosedBox = (wefts: ReadonlyArray<LoomWeft>): Option.Option<number> =>
  pipe(
    Array.findLastIndex(wefts, isBoxEdge),
    Option.filter((at) => Option.exists(Array.get(wefts, at), opensBox)),
  )

const faultedBox =
  (fault: LoomFault) =>
  <Line extends PreambleWeft | ProseWeft>(line: Line): Line =>
    Option.match(Option.fromNullishOr(line.box), {
      onNone: () => line,
      onSome: (box) => ({
        ...line,
        box: { ...box, fence: { ...box.fence, health: faulty(fault, box.position) } },
      }),
    })

const faultedBoxLine =
  (fault: LoomFault) =>
  (weft: LoomWeft): LoomWeft =>
    Match.value(weft).pipe(
      Match.when({ type: 'PreambleWeft' }, faultedBox(fault)),
      Match.when({ type: 'ProseWeft' }, faultedBox(fault)),
      Match.orElse(() => weft),
    )

const faultUnclosedBox = (wefts: ReadonlyArray<LoomWeft>): ReadonlyArray<LoomWeft> =>
  Option.match(unclosedBox(wefts), {
    onNone: () => wefts,
    onSome: (open) =>
      Array.map(wefts, (weft, at) => (at === open ? faultedBoxLine(UnclosedBox())(weft) : weft)),
  })

const loomBoxFault = (box: BoxToken, code: boolean): Option.Option<LoomFault> => {
  const kind = boxKind(box)
  return box.side !== 'open' || !isPointingKind(kind)
    ? Option.none()
    : Option.match(Option.fromNullishOr(box.name), {
        onNone: () => Option.some(UnnamedBox({ kind })),
        onSome: (name) =>
          code && kind === chapterKind
            ? Option.some(ChapterBoxBesideCode({ name: name.value }))
            : Option.none(),
      })
}

const judgeLoomBoxes = (body: ReadonlyArray<LoomWeft>): ReadonlyArray<LoomWeft> => {
  const code = Array.some(body, (weft) => weft.type === 'ArrowWeft')
  return Array.map(body, (weft) =>
    Option.match(
      Option.flatMap(boxOf(weft), (box) => loomBoxFault(box, code)),
      {
        onNone: () => weft,
        onSome: (fault) => faultedBoxLine(fault)(weft),
      },
    ),
  )
}

const isConclusion = (weft: LoomWeft): boolean =>
  Option.exists(boxOf(weft), (box) => box.side === 'open' && boxKind(box) === conclusionKind)

const conclusionFault = (topic: boolean, earlier: number): Option.Option<LoomFault> =>
  Match.value({ topic, earlier }).pipe(
    Match.when({ topic: false }, () => Option.some(ConclusionOutsideTopic())),
    Match.when({ earlier: 0 }, () => Option.none()),
    Match.orElse(() => Option.some(SecondConclusion())),
  )

const judgeConclusions = (body: ReadonlyArray<LoomWeft>, topic: boolean): ReadonlyArray<LoomWeft> =>
  Array.mapAccum(body, 0, (earlier, weft) =>
    isConclusion(weft)
      ? [
          earlier + 1,
          Option.match(conclusionFault(topic, earlier), {
            onNone: () => weft,
            onSome: (fault) => faultedBoxLine(fault)(weft),
          }),
        ]
      : [earlier, weft],
  )[1]

const isFlushCode = (weft: LoomWeft): boolean =>
  weft.type === 'CodeWeft' && weft.source.trim() !== ''

const warnedHeading = (weft: HeadingWeft): HeadingWeft => ({
  ...weft,
  headingStart: {
    ...weft.headingStart,
    health: faulty(HeadingAgainstCode(), weft.headingStart.position),
  },
})

const warnHeadingAgainstCode = (wefts: ReadonlyArray<LoomWeft>): ReadonlyArray<LoomWeft> =>
  Array.map(wefts, (weft, at) =>
    isHeading(weft) && Option.exists(Array.get(wefts, at - 1), isFlushCode)
      ? warnedHeading(weft)
      : weft,
  )

const dividesCode = (weft: LoomWeft): boolean => isFlushCode(weft) || weft.type === 'ArrowWeft'

const warnedDivider = (weft: DividerWeft): DividerWeft => ({
  ...weft,
  dashes: {
    ...weft.dashes,
    health: faulty(DividerAgainstCode(), weft.dashes.position),
  },
})

const warnDividerAgainstCode = (wefts: ReadonlyArray<LoomWeft>): ReadonlyArray<LoomWeft> =>
  Array.map(wefts, (weft, at) =>
    isDivider(weft) && Option.exists(Array.get(wefts, at - 1), dividesCode)
      ? warnedDivider(weft)
      : weft,
  )

const isHeading = (w: LoomWeft): w is HeadingWeft => w.type === 'HeadingWeft'

const isDivider = (w: LoomWeft): w is DividerWeft => w.type === 'DividerWeft'

const isSectionBody = (w: LoomWeft): w is SectionBodyWeft =>
  w.type === 'ArrowWeft' ||
  w.type === 'CodeWeft' ||
  w.type === 'FenceWeft' ||
  w.type === 'TildeWeft' ||
  w.type === 'ProseWeft'

const isPreamble = (w: LoomWeft): w is PreambleWeft => w.type === 'PreambleWeft'

const isTopLevelWeft = (w: LoomWeft): w is FrontmatterWeft | PreambleWeft =>
  w.type === 'FrontmatterWeft' || w.type === 'PreambleWeft'

type TopLevelNode = FrontmatterWeft | PreambleWeft | LoomSection

type LabelLine = PreambleWeft | ProseWeft

type Opener = Data.TaggedEnum<{
  Heading: { readonly heading: HeadingWeft }
  Division: { readonly divider: DividerWeft; readonly label: Option.Option<LabelLine> }
}>

const Opener = Data.taggedEnum<Opener>()

const isLabelLine = (w: LoomWeft): w is LabelLine =>
  (w.type === 'PreambleWeft' || w.type === 'ProseWeft') &&
  w.source.trim() !== '' &&
  Option.isNone(boxOf(w)) &&
  Option.isNone(openingFence(w.source))

const labelsAt = (wefts: ReadonlyArray<LoomWeft>, at: number): boolean =>
  Option.exists(Array.get(wefts, at), isLabelLine) &&
  Option.exists(Array.get(wefts, at + 1), isDivider)

const opensSection = (wefts: ReadonlyArray<LoomWeft>, at: number): boolean =>
  Option.exists(
    Array.get(wefts, at),
    (w) => isHeading(w) || labelsAt(wefts, at) || (isDivider(w) && !labelsAt(wefts, at - 1)),
  )

const labelledDivision = (
  group: ReadonlyArray<LoomWeft>,
): Option.Option<readonly [Opener, number]> =>
  Option.map(
    Option.all([
      Option.filter(Array.get(group, 0), isLabelLine),
      Option.filter(Array.get(group, 1), isDivider),
    ]),
    ([label, divider]) => [Opener.Division({ divider, label: Option.some(label) }), 2] as const,
  )

const openerOf = (
  group: Array.NonEmptyReadonlyArray<LoomWeft>,
): Option.Option<readonly [Opener, number]> =>
  Option.orElse(labelledDivision(group), () =>
    Match.value(Array.headNonEmpty(group)).pipe(
      Match.when({ type: 'HeadingWeft' }, (heading) =>
        Option.some([Opener.Heading({ heading }), 1] as const),
      ),
      Match.when({ type: 'DividerWeft' }, (divider) =>
        Option.some([Opener.Division({ divider, label: Option.none() }), 1] as const),
      ),
      Match.orElse(() => Option.none<readonly [Opener, number]>()),
    ),
  )

const sectionChunk =
  (discussion: boolean) =>
  (
    group: Array.NonEmptyReadonlyArray<LoomWeft>,
  ): readonly [Option.Option<LoomSection>, ReadonlyArray<LoomWeft>] => {
    const opened = openerOf(group)
    const width = Option.match(opened, { onNone: () => 1, onSome: ([, lines]) => lines })
    const end = pipe(
      Array.findFirstIndex(Array.drop(group, width), (_, at) => opensSection(group, at + width)),
      Option.map((at) => at + width),
      Option.getOrElse(() => group.length),
    )
    return [
      Option.map(opened, ([opener]) =>
        buildSection(opener, Array.take(Array.drop(group, width), end - width), discussion),
      ),
      Array.drop(group, end),
    ]
  }

const namesDiscussion = (w: LoomWeft): boolean =>
  w.type === 'FrontmatterWeft' && w.discussion !== undefined

const groupNodes = (wefts: ReadonlyArray<LoomWeft>): ReadonlyArray<TopLevelNode> => {
  const [preamble, sections] = Array.span(wefts, (w) => !isHeading(w))
  const discussion = Array.some(preamble, namesDiscussion)
  return [
    ...Array.filter(preamble, isTopLevelWeft),
    ...Array.getSomes(Array.chop(sections, sectionChunk(discussion))),
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

const appendToDocument = (doc: DocumentBuilder, node: TopLevelNode): DocumentBuilder =>
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
  opener: Opener,
  body: ReadonlyArray<LoomWeft>,
  discussion: boolean,
): LoomSection => {
  const h = headingOf(opener)
  const topic = discussion && opener._tag === 'Division'
  const judged = judgeConclusions(judgeLoomBoxes(body), topic)
  const preamble = judged.filter(isPreamble)
  const code = judged.filter(isSectionBody)
  return LoomSectionSchema.make({
    position: spanFrom(h.position, preamble, code),
    source: sourceOf(h, preamble, code),
    health: okHealth,
    heading: h,
    preamble,
    code,
  })
}

const headingOf = (opener: Opener): LoomHeading =>
  Opener.$match(opener, {
    Heading: ({ heading }) =>
      LoomHeadingSchema.make({
        position: heading.position,
        source: heading.source,
        health: heading.health,
        unexpected: heading.unexpected,
        marker: heading.headingStart,
        title: heading.title,
        specifier: heading.specifier,
        sink: heading.sink,
      }),
    Division: ({ divider, label }) => divisionHeadingOf(divider, label),
  })

const titleOfLabel = (line: LabelLine): HeadingTitleToken => {
  const content = line.source.replace(/\r?\n$/, '')
  const words = content.trim()
  const start = line.position.start.offset + content.length - content.trimStart().length
  return HeadingTitleTokenSchema.make({
    position: {
      start: { line: line.position.start.line, offset: start },
      end: { line: line.position.start.line, offset: start + words.length },
    },
    source: words,
    health: okHealth,
  })
}

const divisionHeadingOf = (divider: DividerWeft, label: Option.Option<LabelLine>): LoomHeading =>
  LoomHeadingSchema.make({
    position: {
      start: Option.match(label, {
        onNone: () => divider.position.start,
        onSome: (line) => line.position.start,
      }),
      end: divider.position.end,
    },
    source:
      Option.match(label, { onNone: () => '', onSome: (line) => line.source }) + divider.source,
    health: divider.health,
    marker: divider.dashes,
    title: Option.getOrUndefined(Option.map(label, titleOfLabel)),
  })

const sourceOf = (
  ...groups: ReadonlyArray<{ readonly source: string } | ReadonlyArray<{ readonly source: string }>>
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
    end: flat.length === 0 ? headingPos.end : flat[flat.length - 1].position.end,
  }
}

const makeFrontmatter = (wefts: ReadonlyArray<FrontmatterWeft>): Option.Option<LoomFrontmatter> => {
  if (wefts.length === 0) return Option.none()
  const partFields = Option.match(
    Option.fromNullishOr(wefts.find((w) => w.part !== undefined || w.partName !== undefined)),
    {
      onNone: () => ({}),
      onSome: (w) => ({ part: w.part, partName: w.partName }),
    },
  )
  const chapterFields = Option.match(
    Option.fromNullishOr(
      wefts.find(
        (w) => w.chapter !== undefined || w.discussion !== undefined || w.title !== undefined,
      ),
    ),
    {
      onNone: () => ({}),
      onSome: (w) => ({ chapter: w.chapter, discussion: w.discussion, title: w.title }),
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
      package: Option.getOrUndefined(
        Option.orElse(frontmatterField(wefts, 'Target'), () => frontmatterField(wefts, 'Package')),
      ),
      trope: wefts.find((w) => w.trope !== undefined)?.trope,
      rootedIn: wefts.find((w) => w.rootedIn !== undefined)?.rootedIn,
      entries: wefts.find((w) => w.entries !== undefined)?.entries,
      language: Option.getOrUndefined(frontmatterField(wefts, 'Language')),
      status: Option.getOrUndefined(frontmatterField(wefts, 'Status')),
      priority: Option.getOrUndefined(frontmatterField(wefts, 'Priority')),
    }),
  )
}

const frontmatterField = (
  wefts: ReadonlyArray<FrontmatterWeft>,
  key: string,
): Option.Option<FrontmatterValueToken> =>
  pipe(
    Option.fromNullishOr(wefts.find((w) => w.key !== undefined && w.key.value === key)),
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
