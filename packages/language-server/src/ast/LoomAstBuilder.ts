import { Chunk, Effect, Function, Match, Option, Sink, Stream, pipe } from "effect"
import {
  LoomChapterSchema,
  LoomDocumentSchema,
  LoomHeadingSchema,
  LoomSectionSchema,
  type LoomChapter,
  type LoomDocument,
  type LoomHeading,
  type LoomSection,
} from "./LoomAst"
import { okHealth, type Position } from "./LoomNode"
import type {
  ChapterHeadingWeft,
  LoomWeft,
  PreambleWeft,
  SectionBodyWeft,
  SectionHeadingWeft,
  Weft,
} from "./Weft"

// =============================================================================
// LoomAstBuilder — final stage of the parse pipeline.
//
//   build(Stream<LoomWeft>): Effect<LoomDocument>
//
// Two transduce stages plus a routing fold:
//
//   Stream<LoomWeft>
//     → Stream.transduce(nodeSink)       // flat parse: Chapter/Section/Weft
//     → Stream.filterMap(identity)       // drop end-of-input Option.none
//     → Stream.transduce(assemblySink)   // attach Sections to preceding Chapter
//     → Stream.filterMap(identity)
//     → Stream.runFold(appendToDocument)
//     → Effect<LoomDocument>
//
// Stage one (`nodeSink`) emits Chapters with empty `children`, Sections
// (whether chapterless or destined to be a Chapter's child), and orphan
// Wefts — all at the same level, in source order. Stage two
// (`assemblySink`) walks that flat stream and collapses runs of Sections
// onto the Chapter that precedes them. The final fold routes finished
// top-level nodes into the matching document slot.
//
// Parent-child structure is carried by stream ordering; no nullable state,
// no "is section open?". The single shared abstraction is `parsingSink`.
// =============================================================================

export class LoomAstBuilder extends Effect.Service<LoomAstBuilder>()(
  "LoomAstBuilder",
  {
    succeed: {
      build: (source: Stream.Stream<LoomWeft>): Effect.Effect<LoomDocument> =>
        source.pipe(
          Stream.transduce(nodeSink),
          Stream.filterMap(Function.identity),
          Stream.transduce(assemblySink),
          Stream.filterMap(Function.identity),
          Stream.runFold(initialDocument, appendToDocument),
          Effect.map(makeDocument),
        ),
    },
  },
) { }

// =============================================================================
// parsingSink — the only shared abstraction. Peels one input element,
// dispatches by type, wraps the result in `Option.some`. `transduce` calls
// the sink one extra time on exhausted input; `Sink.head` returns `None`
// there and we emit `Option.none`, which a downstream `Stream.filterMap`
// drops before the next stage sees it.
// =============================================================================

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

// =============================================================================
// Predicates.
// =============================================================================

const isChapterHeading = (w: LoomWeft): w is ChapterHeadingWeft =>
  w.type === "ChapterHeadingWeft"

const isSectionHeading = (w: LoomWeft): w is SectionHeadingWeft =>
  w.type === "SectionHeadingWeft"

const isHeading = (w: LoomWeft): boolean =>
  isChapterHeading(w) || isSectionHeading(w)

const isSectionBody = (w: LoomWeft): w is SectionBodyWeft =>
  w.type === "ArrowWeft" ||
  w.type === "CodeWeft" ||
  w.type === "TildeWeft" ||
  w.type === "ProseWeft"

const isPreamble = (w: LoomWeft): w is PreambleWeft =>
  w.type === "PreambleWeft"

// =============================================================================
// TopLevelNode — the element type of the assembly stream. All three variants
// are document-level nodes; assembly routes each to the matching slot or
// (for LoomChapter) absorbs trailing Sections as children.
// =============================================================================

type TopLevelNode = Weft | LoomSection | LoomChapter

const isLoomSection = (n: TopLevelNode): n is LoomSection =>
  n.type === "LoomSection"

// =============================================================================
// nodeSink — flat parse. Peels one weft, dispatches by type. Heading sinks
// collect body wefts via `Sink.collectAllWhile`; the next heading
// terminates and becomes leftover for the next `nodeSink` iteration.
// =============================================================================

const nodeSink = parsingSink<LoomWeft, TopLevelNode>((w) => dispatchNode(w))

const dispatchNode = (w: LoomWeft): Sink.Sink<TopLevelNode, LoomWeft, LoomWeft> =>
  pipe(
    Match.value(w),
    Match.when({ type: "Weft" }, (weft) => Sink.succeed<TopLevelNode>(weft)),
    Match.when({ type: "ChapterHeadingWeft" }, chapterSink),
    Match.when({ type: "SectionHeadingWeft" }, sectionSink),
    // Body wefts can't begin a top-level node — the Classifier only emits
    // them after a heading, and the heading sinks consume them before any
    // subsequent `nodeSink` iteration. `Match.exhaustive` demands compile-
    // time coverage of every LoomWeft variant, so the unreachable branches
    // die explicitly with the offending kind in the message.
    Match.when({ type: "PreambleWeft" }, unexpectedAtTop),
    Match.when({ type: "ArrowWeft" }, unexpectedAtTop),
    Match.when({ type: "CodeWeft" }, unexpectedAtTop),
    Match.when({ type: "TildeWeft" }, unexpectedAtTop),
    Match.when({ type: "ProseWeft" }, unexpectedAtTop),
    Match.exhaustive,
  )

const unexpectedAtTop = (
  w: LoomWeft,
): Sink.Sink<TopLevelNode, LoomWeft, LoomWeft> =>
  Sink.die(`dispatchNode: unexpected ${w.type} at top level`)

// `sectionSink` and `chapterSink` use the same stop condition: any heading
// terminates and becomes leftover. The single-pass parse is therefore flat —
// sections appearing inside a chapter body are emitted by subsequent
// `nodeSink` iterations, not collected as children at this stage.
const sectionSink = (
  heading: SectionHeadingWeft,
): Sink.Sink<LoomSection, LoomWeft, LoomWeft> =>
  Sink.collectAllWhile<LoomWeft>((w) => !isHeading(w)).pipe(
    Sink.map((body) => buildSection(heading, body)),
  )

const chapterSink = (
  heading: ChapterHeadingWeft,
): Sink.Sink<LoomChapter, LoomWeft, LoomWeft> =>
  Sink.collectAllWhile<LoomWeft>((w) => !isHeading(w)).pipe(
    Sink.map((body) => buildChapter(heading, body)),
  )

// =============================================================================
// assemblySink — second transduce stage. Walks the flat stream and assigns
// each run of Sections to the LoomChapter that immediately precedes it.
// Chapterless Sections and orphan Wefts pass through as document-level
// nodes.
// =============================================================================

const assemblySink = parsingSink<TopLevelNode, TopLevelNode>((n) => dispatchAssembly(n))

const dispatchAssembly = (
  node: TopLevelNode,
): Sink.Sink<TopLevelNode, TopLevelNode, TopLevelNode> =>
  pipe(
    Match.value(node),
    Match.when({ type: "LoomChapter" }, (chapter) =>
      Sink.collectAllWhile<TopLevelNode>(isLoomSection).pipe(
        Sink.map((children) =>
          attachChildren(chapter, Chunk.toReadonlyArray(children) as ReadonlyArray<LoomSection>),
        ),
      ),
    ),
    Match.when({ type: "LoomSection" }, (section) =>
      Sink.succeed<TopLevelNode>(section),
    ),
    Match.when({ type: "Weft" }, (weft) => Sink.succeed<TopLevelNode>(weft)),
    Match.exhaustive,
  )

// Children populate `chapter.children` and extend the chapter's position so
// it spans through the last section's last constituent.
const attachChildren = (
  chapter: LoomChapter,
  children: ReadonlyArray<LoomSection>,
): LoomChapter => ({
  ...chapter,
  children,
  position: extendEnd(chapter.position, children),
})

const extendEnd = (
  start: Position,
  trailing: ReadonlyArray<{ readonly position: Position }>,
): Position =>
  trailing.length === 0
    ? start
    : { start: start.start, end: trailing[trailing.length - 1].position.end }

// =============================================================================
// Document fold — pure routing by node type. Match.exhaustive over the three
// TopLevelNode variants.
// =============================================================================

type DocumentBuilder = {
  readonly wefts: ReadonlyArray<Weft>
  readonly sections: ReadonlyArray<LoomSection>
  readonly chapters: ReadonlyArray<LoomChapter>
}

const initialDocument: DocumentBuilder = {
  wefts: [],
  sections: [],
  chapters: [],
}

const appendToDocument = (
  doc: DocumentBuilder,
  node: TopLevelNode,
): DocumentBuilder =>
  pipe(
    Match.value(node),
    Match.when({ type: "LoomChapter" }, (chapter) => ({
      ...doc,
      chapters: [...doc.chapters, chapter],
    })),
    Match.when({ type: "LoomSection" }, (section) => ({
      ...doc,
      sections: [...doc.sections, section],
    })),
    Match.when({ type: "Weft" }, (weft) => ({
      ...doc,
      wefts: [...doc.wefts, weft],
    })),
    Match.exhaustive,
  )

// =============================================================================
// Builders — turn a heading + body chunk into a schema-typed container. The
// body is partitioned by type with `Chunk.filter`; no imperative loops.
// =============================================================================

const buildSection = (
  heading: SectionHeadingWeft,
  body: Chunk.Chunk<LoomWeft>,
): LoomSection => {
  const h = headingOf(heading)
  const preamble = Chunk.toReadonlyArray(Chunk.filter(body, isPreamble))
  const code = Chunk.toReadonlyArray(Chunk.filter(body, isSectionBody))
  return LoomSectionSchema.make({
    position: spanFrom(h.position, preamble, code),
    health: okHealth,
    heading: h,
    preamble,
    code,
  })
}

const buildChapter = (
  heading: ChapterHeadingWeft,
  body: Chunk.Chunk<LoomWeft>,
): LoomChapter => {
  const h = headingOf(heading)
  const preamble = Chunk.toReadonlyArray(Chunk.filter(body, isPreamble))
  const code = Chunk.toReadonlyArray(Chunk.filter(body, isSectionBody))
  return LoomChapterSchema.make({
    position: spanFrom(h.position, preamble, code),
    health: okHealth,
    heading: h,
    preamble,
    code,
    // Empty at parse stage; assemblySink populates this in stage two.
    children: [],
  })
}

const headingOf = (
  weft: ChapterHeadingWeft | SectionHeadingWeft,
): LoomHeading =>
  LoomHeadingSchema.make({
    position: weft.position,
    health: weft.health,
    unexpected: weft.unexpected,
    markers: weft.headingStart,
    texts: weft.texts,
    tag: weft.tag,
    specifier: weft.specifier,
  })

// =============================================================================
// Position derivation. `spanFrom` takes the heading position and any number
// of ordered constituent groups (preamble, code, …); the end is the last
// element's end across all groups, falling back to the heading's own end.
// =============================================================================

const spanFrom = (
  headingPos: Position,
  ...groups: ReadonlyArray<ReadonlyArray<{ readonly position: Position }>>
): Position => {
  const flat = groups.flat()
  return {
    start: headingPos.start,
    end:
      flat.length === 0
        ? headingPos.end
        : flat[flat.length - 1].position.end,
  }
}

const documentSpan = (db: DocumentBuilder): Position => {
  const all: ReadonlyArray<{ readonly position: Position }> = [
    ...db.wefts,
    ...db.sections,
    ...db.chapters,
  ]
  return all.length === 0
    ? { start: { line: 1, offset: 0 }, end: { line: 1, offset: 0 } }
    : { start: all[0].position.start, end: all[all.length - 1].position.end }
}

const makeDocument = (db: DocumentBuilder): LoomDocument =>
  LoomDocumentSchema.make({
    position: documentSpan(db),
    health: okHealth,
    wefts: db.wefts,
    sections: db.sections,
    chapters: db.chapters,
  })
