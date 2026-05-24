import { Schema } from "effect"
import { loomNode } from "./LoomNode"
import {
  ChapterHeadingStartTokenSchema,
  SectionHeadingStartTokenSchema,
  SpecifierTokenSchema,
  TagTokenSchema,
  TextTokenSchema,
} from "./LoomTokens"
import {
  PreambleWeftSchema,
  SectionBodyWeftSchema,
} from "./Weft"

// =============================================================================
// Containers — the inner AST. Leaves (tokens and wefts) live in LoomTokens.ts
// and Weft.ts; this file defines container nodes that bind those leaves into
// structural shapes.
//
// All nodes — containers and leaves — go through loomNode() and therefore
// carry the same `type`/`position`/`health` shape. Walkers don't need to
// distinguish "is this a container or a leaf?" — every field with a `type`
// is a node.
// =============================================================================

// =============================================================================
// Heading — uniform for chapters and sections at the schema level.
//
// `markers` is a union of the two heading-start token kinds; the inner
// `type` distinguishes chapter (level 1) from section (level 2+).
// `texts` is the array of contiguous text segments between structural
// tokens on the heading line — heading text can be non-contiguous, e.g.
// `# [Loom] is written in {Loom}` has a text segment after the tag and
// before the specifier.
//
// Tag and specifier are optional. The parser enforces that chapter headings
// require both — a validation rule, not a type split.
// =============================================================================

export const LoomHeadingMarkersSchema = Schema.Union(
  ChapterHeadingStartTokenSchema,
  SectionHeadingStartTokenSchema,
)
export type LoomHeadingMarkers = typeof LoomHeadingMarkersSchema.Type

export const LoomHeadingSchema = loomNode("LoomHeading", {
  markers: LoomHeadingMarkersSchema,
  texts: Schema.Array(TextTokenSchema),
  tag: Schema.optional(TagTokenSchema),
  specifier: Schema.optional(SpecifierTokenSchema),
})
export type LoomHeading = typeof LoomHeadingSchema.Type

// =============================================================================
// Section — one structural unit under a chapter.
//
// Body is two ordered weft sequences:
//   - preamble: PreambleWefts (default mode after the heading)
//   - code:     the post-preamble sequence, ordered as the source emitted it.
//               The grammar's forward-only mode progression
//               (Preamble → Arrow → Code → Tilde → Prose) is preserved
//               implicitly in the array order; the classifier enforces it.
//               Valid prefixes: [], [ArrowWeft, ...], [TildeWeft, ...].
// =============================================================================

export const LoomSectionSchema = loomNode("LoomSection", {
  heading: LoomHeadingSchema,
  preamble: Schema.Array(PreambleWeftSchema),
  code: Schema.Array(SectionBodyWeftSchema),
})
export type LoomSection = typeof LoomSectionSchema.Type

// =============================================================================
// Chapter — a section that also holds children.
//
// Same body shape as Section (heading + preamble + code, with the
// grammar's forward-only mode progression encoded implicitly in `code`'s
// order) plus a `children` array for sub-sections.
// =============================================================================

export const LoomChapterSchema = loomNode("LoomChapter", {
  heading: LoomHeadingSchema,
  preamble: Schema.Array(PreambleWeftSchema),
  code: Schema.Array(SectionBodyWeftSchema),
  children: Schema.Array(LoomSectionSchema),
})
export type LoomChapter = typeof LoomChapterSchema.Type

// =============================================================================
// Document — the root.
//
// `chapters` may be empty. A real Loom document is expected to have at
// least one chapter, but that's a grammar concern reported via
// `health.diagnostics` — not a schema-shape constraint. Failure cases
// (MixedEOL, empty file) yield a document with `chapters: []` and a NOK
// root health.
// =============================================================================

export const LoomDocumentSchema = loomNode("LoomDocument", {
  chapters: Schema.Array(LoomChapterSchema),
})
export type LoomDocument = typeof LoomDocumentSchema.Type
