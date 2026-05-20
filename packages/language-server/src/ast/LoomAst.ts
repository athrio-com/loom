import { Schema } from "effect"
import { LineRangeSchema } from "./LineRanges"
import { loomNode } from "./LoomNode"
import {
  ArrowTokenSchema,
  ChapterHeadingStartTokenSchema,
  SectionHeadingStartTokenSchema,
  SpecifierTokenSchema,
  TagTokenSchema,
  TextTokenSchema,
} from "./LoomTokens"

// =============================================================================
// Containers — the inner AST. Leaves (Tag/Specifier/Arrow/HeadingStart/Text
// and their named subnodes) live in LoomTokens.ts; this file only defines
// container nodes that bind those leaves into structural shapes.
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
// tokens on the heading line (mirrors the originating Weft) — heading text
// can be non-contiguous, e.g. `# [Loom] is written in {Loom}` has a text
// segment after the tag and before the specifier.
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
// Self-descriptive: read the fields to know what's present.
//   - No arrow, no code  → prose section
//   - Arrow present       → code section (preamble before arrow, code after)
//
// `arrow` is an optional ArrowToken (the leaf). Preamble and code lines are
// stored as LineRanges into the source text; content is derived on demand.
// =============================================================================

export const LoomSectionSchema = loomNode("LoomSection", {
  heading: LoomHeadingSchema,
  preamble: Schema.Array(LineRangeSchema),
  arrow: Schema.optional(ArrowTokenSchema),
  code: Schema.Array(LineRangeSchema),
})
export type LoomSection = typeof LoomSectionSchema.Type

// =============================================================================
// Dependencies — a reserved-tag section under a chapter, recognised at
// classify time from `## ... [D]`. Same body shape as LoomSection; the
// distinct type tag lets downstream consumers dispatch on it (Frame
// projector treats the body as the `dependencies` Layer declarations).
// =============================================================================

export const LoomDependenciesSchema = loomNode("LoomDependencies", {
  heading: LoomHeadingSchema,
  preamble: Schema.Array(LineRangeSchema),
  arrow: Schema.optional(ArrowTokenSchema),
  code: Schema.Array(LineRangeSchema),
})
export type LoomDependencies = typeof LoomDependenciesSchema.Type

// =============================================================================
// Tangle — a reserved-tag section under a chapter, recognised at classify
// time from `## ... [T]`. Same body shape as LoomSection; the body is the
// composition program that emits a file at the path declared in the tag's
// arguments (path parsing comes later — out of scope for this step).
// =============================================================================

export const LoomTangleSchema = loomNode("LoomTangle", {
  heading: LoomHeadingSchema,
  preamble: Schema.Array(LineRangeSchema),
  arrow: Schema.optional(ArrowTokenSchema),
  code: Schema.Array(LineRangeSchema),
})
export type LoomTangle = typeof LoomTangleSchema.Type

// =============================================================================
// LoomChapterChild — the union of things a chapter can hold under its body.
// LoomSection covers any `##`+ heading that isn't reserved; LoomDependencies
// and LoomTangle cover the two reserved tags. classifyWefts decides which
// kind is produced per heading, so the union is closed at parse time.
// =============================================================================

export const LoomChapterChildSchema = Schema.Union(
  LoomSectionSchema,
  LoomDependenciesSchema,
  LoomTangleSchema,
)
export type LoomChapterChild = typeof LoomChapterChildSchema.Type

// =============================================================================
// Chapter — a section that also holds children.
//
// Same shape as Section (heading, preamble, arrow, code) plus a `children`
// array for the chapter's structural members (sections / dependencies /
// tangles). The parser requires tag and specifier on the heading for
// chapters; the schema leaves them optional to keep one heading type.
// =============================================================================

export const LoomChapterSchema = loomNode("LoomChapter", {
  heading: LoomHeadingSchema,
  preamble: Schema.Array(LineRangeSchema),
  arrow: Schema.optional(ArrowTokenSchema),
  code: Schema.Array(LineRangeSchema),
  children: Schema.Array(LoomChapterChildSchema),
})
export type LoomChapter = typeof LoomChapterSchema.Type

// =============================================================================
// Document — the root. At least one chapter required.
// =============================================================================

export const LoomDocumentSchema = loomNode("LoomDocument", {
  chapters: Schema.Array(LoomChapterSchema).pipe(Schema.minItems(1)),
})
export type LoomDocument = typeof LoomDocumentSchema.Type
