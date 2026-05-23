import { Schema } from "effect"
import { loomNode } from "./LoomNode"
import {
  ArrowTokenSchema,
  ChapterHeadingStartTokenSchema,
  CodeTokenSchema,
  Probe,
  ProseTokenSchema,
  SectionHeadingStartTokenSchema,
  SpecifierTokenSchema,
  TagTokenSchema,
  TextTokenSchema,
  TildeTokenSchema,
} from "./LoomTokens"

// =============================================================================
// Wefts — line-level AST nodes.
//
// Each Weft is the typed shape of one source line as classified by mode plus
// any tokens recognised on it. Wefts are health-bearing loomNodes, so they
// carry type/position/health like every other AST node. The walker
// recurses into Wefts the same way it recurses into containers.
//
// The position spans one line (start.line === end.line); offsets cover from
// the line's first byte to its terminator inclusive.
// =============================================================================

// Default Weft — line with no recognised structure.
export const WeftSchema = loomNode("Weft", {})
export type Weft = typeof WeftSchema.Type

// ChapterHeadingWeft — `#` heading. The headingStart token kind enforces
// level 1. Title text decomposes into TextTokens between structural tokens.
// Both `tag` and `specifier` are required on a structurally complete chapter
// heading. The Classifier Stage emits the weft with NOK placeholder tokens carrying
// `health.status === "incomplete"` when the real tokens have not yet been
// recognised — the filter is satisfied at the schema level while the health
// field communicates that subnodes are stand-ins.
export const ChapterHeadingWeftSchema = loomNode("ChapterHeadingWeft", {
  headingStart: ChapterHeadingStartTokenSchema,
  texts: Schema.Array(TextTokenSchema),
  tag: Schema.optional(TagTokenSchema),
  specifier: Schema.optional(SpecifierTokenSchema),
}).pipe(
  Schema.filter((w) =>
    w.tag !== undefined && w.specifier !== undefined
      ? undefined
      : "ChapterHeadingWeft requires both tag and specifier",
  ),
)
export type ChapterHeadingWeft = typeof ChapterHeadingWeftSchema.Type

// SectionHeadingWeft — `##`+ heading. Does not apply to reserved Dependencies
// or Tangle headings; those are recognised at classification time.
export const SectionHeadingWeftSchema = loomNode("SectionHeadingWeft", {
  headingStart: SectionHeadingStartTokenSchema,
  texts: Schema.Array(TextTokenSchema),
  tag: Schema.optional(TagTokenSchema),
  specifier: Schema.optional(SpecifierTokenSchema),
})
export type SectionHeadingWeft = typeof SectionHeadingWeftSchema.Type

// DependenciesHeadingWeft — reserved `##`+ heading whose tag is `[D]`. The
// schema carries a line-level Probe that recognises the structural form
// "section marker + (any non-bracket/brace text) + [D] + (any non-bracket/
// brace text)" — exactly one reserved tag, no extras, no specifier. The
// Classifier consults this Probe via `getProbe` to discriminate at probe
// time, with no token construction.
//
// The filter is health-aware: NOK-health wefts (Classifier-Stage
// placeholders) are admitted with any tag content; `ok`-health wefts must
// satisfy `tag.label.value === "D"`. The Tokeniser Stage flips the health
// from `incomplete` to `ok` after building the real tag from source.
export const DependenciesHeadingWeftSchema = loomNode("DependenciesHeadingWeft", {
  headingStart: SectionHeadingStartTokenSchema,
  texts: Schema.Array(TextTokenSchema),
  tag: TagTokenSchema,
}).pipe(
  Schema.filter((w) => {
    if (w.health.status !== "ok") return true
    return w.tag.label.value === "D"
      ? true
      : "DependenciesHeadingWeft with `ok` health requires tag `[D]`"
  }),
).annotations({
  [Probe]: /^#{2,6} [^\[\]{}]*\[D\][^\[\]{}]*$/,
})
export type DependenciesHeadingWeft = typeof DependenciesHeadingWeftSchema.Type

// TangleHeadingWeft — same shape, `[T]` discriminator.
export const TangleHeadingWeftSchema = loomNode("TangleHeadingWeft", {
  headingStart: SectionHeadingStartTokenSchema,
  texts: Schema.Array(TextTokenSchema),
  tag: TagTokenSchema,
}).pipe(
  Schema.filter((w) => {
    if (w.health.status !== "ok") return true
    return w.tag.label.value === "T"
      ? true
      : "TangleHeadingWeft with `ok` health requires tag `[T]`"
  }),
).annotations({
  [Probe]: /^#{2,6} [^\[\]{}]*\[T\][^\[\]{}]*$/,
})
export type TangleHeadingWeft = typeof TangleHeadingWeftSchema.Type

// ArrowWeft — `=>` line. The Arrow token; any trailing code content is the
// optional CodeToken. The Arrow transition into Code mode is the line's
// structural significance.
export const ArrowWeftSchema = loomNode("ArrowWeft", {
  arrow: ArrowTokenSchema,
  code: Schema.optional(CodeTokenSchema),
})
export type ArrowWeft = typeof ArrowWeftSchema.Type

// TildeWeft — `~` line. The Tilde token; any trailing prose content is the
// optional ProseToken. The Tilde transition into Prose mode is one-way.
export const TildeWeftSchema = loomNode("TildeWeft", {
  tilde: TildeTokenSchema,
  prose: Schema.optional(ProseTokenSchema),
})
export type TildeWeft = typeof TildeWeftSchema.Type

// PreambleWeft — a line in Preamble mode (default for the body of a Section
// or Chapter before any mode transition). PreambleWefts have their own
// tokenisation rules — distinct from ProseWefts (which only appear after a
// Tilde transition).
// TODO: subtoken structure
export const PreambleWeftSchema = loomNode("PreambleWeft", {})
export type PreambleWeft = typeof PreambleWeftSchema.Type

// ProseWeft — a line in Prose mode (after a Tilde transition).
// TODO: subtoken structure
export const ProseWeftSchema = loomNode("ProseWeft", {})
export type ProseWeft = typeof ProseWeftSchema.Type

// CodeWeft — a line in Code mode (after an Arrow transition).
// Opaque to Loom; embedded-language tokenisation happens elsewhere.
export const CodeWeftSchema = loomNode("CodeWeft", {})
export type CodeWeft = typeof CodeWeftSchema.Type

// DependencyWeft — a line in the body of a LoomDependencies section.
// TODO: subtoken structure
export const DependencyWeftSchema = loomNode("DependencyWeft", {})
export type DependencyWeft = typeof DependencyWeftSchema.Type

// TangleWeft — a line in the body of a LoomTangle section.
// TODO: subtoken structure
export const TangleWeftSchema = loomNode("TangleWeft", {})
export type TangleWeft = typeof TangleWeftSchema.Type

// =============================================================================
// LoomWeft — the union of all Weft kinds. The Tokeniser's output stream
// element type and the AST's line-level leaf type.
// =============================================================================

export const LoomWeftSchema = Schema.Union(
  WeftSchema,
  ChapterHeadingWeftSchema,
  SectionHeadingWeftSchema,
  DependenciesHeadingWeftSchema,
  TangleHeadingWeftSchema,
  ArrowWeftSchema,
  TildeWeftSchema,
  PreambleWeftSchema,
  ProseWeftSchema,
  CodeWeftSchema,
  DependencyWeftSchema,
  TangleWeftSchema,
)
export type LoomWeft = typeof LoomWeftSchema.Type

// =============================================================================
// SectionBodyWeft — the Weft kinds that can appear in a Section or Chapter
// `code` body (after the preamble). The grammar's forward-only mode
// progression admits these four; the classifier enforces ordering.
// =============================================================================

export const SectionBodyWeftSchema = Schema.Union(
  ArrowWeftSchema,
  CodeWeftSchema,
  TildeWeftSchema,
  ProseWeftSchema,
)
export type SectionBodyWeft = typeof SectionBodyWeftSchema.Type
