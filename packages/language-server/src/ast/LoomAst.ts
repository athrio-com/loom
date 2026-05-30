import { Schema } from "effect"
import { loomNode } from "./LoomNode"
import {
  HeadingStartTokenSchema,
  HeadingTitleTokenSchema,
  PathSpecifierTokenSchema,
  SpecifierTokenSchema,
  TagTokenSchema,
} from "./LoomTokens"
import { PreambleWeftSchema, SectionBodyWeftSchema } from "./Weft"

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
// Heading — one shape for every heading, any level.
//
// `headingStart` is the single heading-start token; its position records the
// level for the human reader, but level carries no structural meaning — every
// heading produces a flat Section. `title` is the optional human-readable
// title: the text run between the marker and the first structural token,
// trimmed of surrounding whitespace; absent when there is no such text.
//
// Tag and specifier are both optional. The Tokeniser synthesises a
// hash-derived tag for a tagless heading, and the specifier is either a label
// (`{Scala}`) or a path (`{src/index.ts}`, a tangle sink).
// =============================================================================

export const LoomHeadingSchema = loomNode("LoomHeading", {
  headingStart: HeadingStartTokenSchema,
  title: Schema.optional(HeadingTitleTokenSchema),
  tag: Schema.optional(TagTokenSchema),
  specifier: Schema.optional(
    Schema.Union(SpecifierTokenSchema, PathSpecifierTokenSchema),
  ),
})
export type LoomHeading = typeof LoomHeadingSchema.Type

// =============================================================================
// Section — one structural unit, created by a heading at any level. Sections
// are flat on the Document; heading level is reader-facing organisation only.
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
// Document — the root container, the implicit module named by its file.
//
// Two slots, no heading:
//   preamble — the Document Preamble: the run of PreambleWefts before the
//              first heading. Carries the `{{lang: …}}` declaration and any
//              introductory prose.
//   sections — flat Sections in source order, one per heading at any level.
//
// Either slot may be empty. Failure cases (MixedEOL, empty file) yield a
// document with both slots empty and a NOK root health.
// =============================================================================

export const LoomDocumentSchema = loomNode("LoomDocument", {
  preamble: Schema.Array(PreambleWeftSchema),
  sections: Schema.Array(LoomSectionSchema),
})
export type LoomDocument = typeof LoomDocumentSchema.Type
