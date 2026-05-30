import { Chunk, Effect, Function, Match, Option, Sink, Stream, pipe } from "effect"
import {
  LoomDocumentSchema,
  LoomHeadingSchema,
  LoomSectionSchema,
  type LoomDocument,
  type LoomHeading,
  type LoomSection,
} from "./LoomAst"
import { okHealth, type Health, type Position } from "./LoomNode"
import type {
  HeadingWeft,
  LoomWeft,
  PreambleWeft,
  SectionBodyWeft,
} from "./Weft"

// =============================================================================
// LoomAstBuilder — final stage of the parse pipeline.
//
//   build(Stream<LoomWeft>): Effect<LoomDocument>
//
// One transduce stage plus a routing fold:
//
//   Stream<LoomWeft>
//     → Stream.transduce(nodeSink)        // peel: pre-heading Preamble | Section
//     → Stream.filterMap(identity)        // drop end-of-input Option.none
//     → Stream.runFold(appendToDocument)  // route into preamble | sections
//     → Effect<LoomDocument>
//
// `nodeSink` peels one weft. A pre-heading PreambleWeft passes through as a
// Document-Preamble node; a HeadingWeft opens a Section and collects its body
// wefts until the next heading. Sections are flat — heading level is reader-
// facing only — so there is no second assembly stage. The single shared
// abstraction is `parsingSink`.
// =============================================================================

export class LoomAstBuilder extends Effect.Service<LoomAstBuilder>()(
  "LoomAstBuilder",
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

const isHeading = (w: LoomWeft): w is HeadingWeft => w.type === "HeadingWeft"

const isSectionBody = (w: LoomWeft): w is SectionBodyWeft =>
  w.type === "ArrowWeft" ||
  w.type === "CodeWeft" ||
  w.type === "TildeWeft" ||
  w.type === "ProseWeft"

const isPreamble = (w: LoomWeft): w is PreambleWeft =>
  w.type === "PreambleWeft"

// =============================================================================
// TopLevelNode — the element type of the routing fold. A pre-heading
// PreambleWeft (the Document Preamble) or a fully-built LoomSection.
// =============================================================================

type TopLevelNode = PreambleWeft | LoomSection

// =============================================================================
// nodeSink — flat parse. Peels one weft, dispatches by type. A HeadingWeft
// opens a Section whose body it collects via `Sink.collectAllWhile`; the next
// heading terminates and becomes leftover for the next `nodeSink` iteration. A
// pre-heading PreambleWeft passes through as a Document-Preamble node. Body
// wefts can't reach the top level — the Classifier keeps the Document Preamble
// preamble-only, and the heading sink consumes a Section's body — so the
// unreachable branches die with the offending kind, satisfying
// `Match.exhaustive`.
// =============================================================================

const nodeSink = parsingSink<LoomWeft, TopLevelNode>((w) => dispatchNode(w))

const dispatchNode = (w: LoomWeft): Sink.Sink<TopLevelNode, LoomWeft, LoomWeft> =>
  pipe(
    Match.value(w),
    Match.when({ type: "HeadingWeft" }, sectionSink),
    Match.when({ type: "PreambleWeft" }, (weft) => Sink.succeed<TopLevelNode>(weft)),
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

// `sectionSink` collects the heading's body: every non-heading weft up to the
// next heading, which terminates and becomes leftover for the next iteration.
const sectionSink = (
  heading: HeadingWeft,
): Sink.Sink<LoomSection, LoomWeft, LoomWeft> =>
  Sink.collectAllWhile<LoomWeft>((w) => !isHeading(w)).pipe(
    Sink.map((body) => buildSection(heading, body)),
  )

// =============================================================================
// Document fold — pure routing by node type. Match.exhaustive over the two
// TopLevelNode variants.
// =============================================================================

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
    Match.when({ type: "LoomSection" }, (section) => ({
      ...doc,
      sections: [...doc.sections, section],
    })),
    Match.when({ type: "PreambleWeft" }, (weft) => ({
      ...doc,
      preamble: [...doc.preamble, weft],
    })),
    Match.exhaustive,
  )

// =============================================================================
// Builders — turn a heading + body chunk into a schema-typed Section. The body
// is partitioned by type with `Chunk.filter`; no imperative loops.
// =============================================================================

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

// Container source — concatenation of the constituent children's sources
// in order. Each child's source carries its trailing newline; concatenation
// reconstructs the original byte range the container spans.
const sourceOf = (
  ...groups: ReadonlyArray<
    { readonly source: string }
    | ReadonlyArray<{ readonly source: string }>
  >
): string =>
  groups
    .flatMap((g) => (Array.isArray(g) ? g : [g as { readonly source: string }]))
    .map((n) => n.source)
    .join("")

// =============================================================================
// Position derivation. `spanFrom` takes the heading position and any number of
// ordered constituent groups (preamble, code, …); the end is the last
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

// =============================================================================
// makeDocument — assemble the LoomDocument. The Document Preamble must carry a
// `{{lang: …}}` Warp naming the primary language; its absence is a warning on
// the document's health (parsing still proceeds).
// =============================================================================

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
  preamble.some((weft) => weft.warps.some((warp) => warp.name.value === "lang"))

const documentHealth = (db: DocumentBuilder, position: Position): Health =>
  hasLangWarp(db.preamble)
    ? okHealth
    : {
        status: "warning",
        diagnostics: [{
          message:
            "No `{{lang: …}}` declaration in the Document Preamble; the primary language is unknown.",
          position: { start: position.start, end: position.start },
          severity: "warning",
        }],
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
