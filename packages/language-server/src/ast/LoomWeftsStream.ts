import { Effect, Match, Option, pipe, Stream } from "effect"

// ─── Core types ──────────────────────────────────────────────────────────────

interface SourceLine {
  readonly text: string
  readonly range: readonly [start: number, end: number]
}

// Subtokens — extracted from text at parse time, no opinions
interface SubtokenAnatomy {
  readonly open: SourceLine
  readonly label: SourceLine
  readonly close: SourceLine
}

type LoomWeft =
  | { readonly _tag: "HeadingWeft"; readonly source: SourceLine; readonly level: number; readonly tag?: SubtokenAnatomy; readonly specifier?: SubtokenAnatomy }
  | { readonly _tag: "ArrowWeft"; readonly source: SourceLine }
  | { readonly _tag: "TildeWeft"; readonly source: SourceLine }
  | { readonly _tag: "SeparatorWeft"; readonly source: SourceLine }
  | { readonly _tag: "Weft"; readonly source: SourceLine }

interface LoomSection {
  readonly heading: Extract<LoomWeft, { _tag: "HeadingWeft" }>
  readonly body: ReadonlyArray<LoomWeft>
}

interface LoomDocument {
  readonly sections: ReadonlyArray<LoomSection>
}

// ─── Parse context (flows forward, never back) ───────────────────────────────

interface ParseContext {
  readonly inFence: boolean
}

const toggleFence = (ctx: ParseContext): ParseContext => ({ inFence: !ctx.inFence })

// ─── Helpers ─────────────────────────────────────────────────────────────────

const headingLevel = (line: SourceLine): number =>
  line.text.length - line.text.trimStart().replace(/^#+/, "").length

// ─── Step 1 — classify ───────────────────────────────────────────────────────
//
// One context bit threads forward: are we inside a fence?
// Inside a fence every line is opaque — it belongs to TypeScript, not Loom.

const classifyLines = Stream.mapAccum(
  { inFence: false } satisfies ParseContext,
  (ctx, line: SourceLine): readonly [ParseContext, LoomWeft] => {
    if (line.text.startsWith("~")) return [toggleFence(ctx), { _tag: "TildeWeft", source: line }]
    if (ctx.inFence) return [ctx, { _tag: "Weft", source: line }]
    if (line.text.startsWith("#")) return [ctx, { _tag: "HeadingWeft", source: line, level: headingLevel(line) }]
    if (line.text.trimStart()
      .startsWith("=>")) return [ctx, { _tag: "ArrowWeft", source: line }]
    if (line.text.startsWith("---")) return [ctx, { _tag: "SeparatorWeft", source: line }]
    return [ctx, { _tag: "Weft", source: line }]
  }
)

// ─── Step 2 — parse subtokens ────────────────────────────────────────────────
//
// Purely local: each line parses itself with no knowledge of neighbours.
// HeadingWeft pulls out [tag] and [specifier] from its own text.

const parseSubtokens = Stream.map((weft: LoomWeft): LoomWeft =>
  Match.value(weft).pipe(
    Match.tag("HeadingWeft", (w) => ({
      ...w,
      tag: extractBracketedSubtoken(w.source, "["),  // Option-returning, omitted for sketch
      specifier: extractBracketedSubtoken(w.source, "("),
    })),
    Match.orElse((w) => w)
  )
)

// ─── Step 3 — group into sections ────────────────────────────────────────────
//
// Each HeadingWeft opens a new section; the previous one is emitted.
// A sentinel flushes the final section without a special end token in the grammar.

const _Sentinel = { _tag: "_Sentinel" } as const
type _Sentinel = typeof _Sentinel

interface SectionAcc {
  readonly heading: Extract<LoomWeft, { _tag: "HeadingWeft" }>
  readonly body: ReadonlyArray<LoomWeft>
}

const groupSections = <E, R>(
  wefts: Stream.Stream<LoomWeft, E, R>
): Stream.Stream<LoomSection, E, R> =>
  pipe(
    Stream.concat(wefts, Stream.make(_Sentinel)) as Stream.Stream<LoomWeft | _Sentinel, E, R>,
    Stream.mapAccum(
      Option.none<SectionAcc>(),
      (acc, item): readonly [Option.Option<SectionAcc>, Option.Option<LoomSection>] =>
        Match.value(item).pipe(
          // new heading → emit accumulated section, open a fresh one
          Match.tag("HeadingWeft", (heading) => [
            Option.some({ heading, body: [] }),
            Option.map(acc, finishSection),
          ] as const),
          // sentinel → emit whatever remains
          Match.tag("_Sentinel", () => [
            Option.none(),
            Option.map(acc, finishSection),
          ] as const),
          // anything else → accumulate into current section body
          Match.orElse((weft) => [
            Option.map(acc, a => ({ ...a, body: [...a.body, weft as LoomWeft] })),
            Option.none(),
          ] as const)
        )
    ),
    Stream.filterMap((opt) => opt)
  )

const finishSection = (acc: SectionAcc): LoomSection => ({
  heading: acc.heading,
  body: acc.body,
})

// ─── Step 4 — fold sections into a document ──────────────────────────────────

const buildDocument = <E, R>(
  sections: Stream.Stream<LoomSection, E, R>
): Effect.Effect<LoomDocument, E, R> =>
  Stream.runFold(
    sections,
    { sections: [] as ReadonlyArray<LoomSection> },
    (doc, section) => ({ sections: [...doc.sections, section] })
  )

// ─── Pipeline ────────────────────────────────────────────────────────────────

const parseLoomDocument = <E, R>(
  source: Stream.Stream<SourceLine, E, R>
): Effect.Effect<LoomDocument, E, R> =>
  pipe(
    source,
    classifyLines,   // Stream<SourceLine>  → Stream<LoomWeft>
    parseSubtokens,  // Stream<LoomWeft>    → Stream<LoomWeft>   (subtokens filled)
    groupSections,   // Stream<LoomWeft>    → Stream<LoomSection>
    buildDocument    // Stream<LoomSection> → Effect<LoomDocument>
  )

// ─── Stub ────────────────────────────────────────────────────────────────────

declare function extractBracketedSubtoken(
  line: SourceLine,
  open: string
): SubtokenAnatomy | undefined
