import { Schema } from "effect"
import { loomNode } from "./LoomNode"
import {
  ArrowTokenSchema,
  CodeTokenSchema,
  HeadingStartTokenSchema,
  PathSpecifierTokenSchema,
  ProseTokenSchema,
  HeadingTitleTokenSchema,
  SpecifierTokenSchema,
  TagTokenSchema,
  TildeTokenSchema,
  WarpAnchorTokenSchema,
  WarpTokenSchema,
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

// HeadingWeft — a `#{1,6}` heading line, any level. The headingStart token
// records the level for the human reader; it carries no structural meaning,
// since every heading produces a flat Section. `title` is the optional
// human-readable title — the text run between the marker and the first
// structural token, trimmed; absent when the heading has no such text.
// Both `tag` and `specifier` are optional: the Tokeniser synthesises a
// hash-derived `tag` for a tagless heading so every Section has a stable
// identifier, and a heading without a specifier inherits the Document
// Preamble's `lang`. The specifier is either a label `{Scala}` (language)
// or a path `{src/index.ts}` (tangle sink). The Classifier Stage emits the
// weft with NOK placeholders carrying `health.status === "incomplete"` for
// subtokens not yet recognised; the Tokeniser settles the health.
export const HeadingWeftSchema = loomNode("HeadingWeft", {
  headingStart: HeadingStartTokenSchema,
  title: Schema.optional(HeadingTitleTokenSchema),
  tag: Schema.optional(TagTokenSchema),
  specifier: Schema.optional(
    Schema.Union(SpecifierTokenSchema, PathSpecifierTokenSchema),
  ),
})
export type HeadingWeft = typeof HeadingWeftSchema.Type

// ArrowWeft — `=>` line. The Arrow token; any trailing code content is the
// optional CodeToken. `anchors` carries every `{{name}}` reference
// recognised inside the inline code. The Arrow transition into Code mode
// is the line's structural significance.
export const ArrowWeftSchema = loomNode("ArrowWeft", {
  arrow: ArrowTokenSchema,
  code: Schema.optional(CodeTokenSchema),
  anchors: Schema.Array(WarpAnchorTokenSchema),
})
export type ArrowWeft = typeof ArrowWeftSchema.Type

// TildeWeft — `~` line. The Tilde token; any trailing prose content is the
// optional ProseToken. The Tilde transition into Prose mode is one-way.
export const TildeWeftSchema = loomNode("TildeWeft", {
  tilde: TildeTokenSchema,
  prose: Schema.optional(ProseTokenSchema),
})
export type TildeWeft = typeof TildeWeftSchema.Type

// PreambleWeft — a line in Preamble mode (the default body mode after a
// heading, before any Arrow or Tilde transition). `warps` carries every
// `{{name: annotation [= default]}}` declaration recognised on the line.
export const PreambleWeftSchema = loomNode("PreambleWeft", {
  warps: Schema.Array(WarpTokenSchema),
})
export type PreambleWeft = typeof PreambleWeftSchema.Type

// ProseWeft — a line in Prose mode (after a Tilde transition).
export const ProseWeftSchema = loomNode("ProseWeft", {})
export type ProseWeft = typeof ProseWeftSchema.Type

// CodeWeft — a line in Code mode (after an Arrow transition). The line
// content is opaque to Loom (embedded-language tokenisation happens
// elsewhere); `anchors` carries every `{{name}}` reference recognised on
// the line.
export const CodeWeftSchema = loomNode("CodeWeft", {
  anchors: Schema.Array(WarpAnchorTokenSchema),
})
export type CodeWeft = typeof CodeWeftSchema.Type

// =============================================================================
// LoomWeft — the union of all Weft kinds. The Tokeniser's output stream
// element type and the AST's line-level leaf type.
// =============================================================================

export const LoomWeftSchema = Schema.Union(
  HeadingWeftSchema,
  ArrowWeftSchema,
  TildeWeftSchema,
  PreambleWeftSchema,
  ProseWeftSchema,
  CodeWeftSchema,
)
export type LoomWeft = typeof LoomWeftSchema.Type

// =============================================================================
// SectionBodyWeft — the Weft kinds that can appear in a Section `code` body
// (after the preamble). The grammar's forward-only mode progression admits
// these four; the classifier enforces ordering.
// =============================================================================

export const SectionBodyWeftSchema = Schema.Union(
  ArrowWeftSchema,
  CodeWeftSchema,
  TildeWeftSchema,
  ProseWeftSchema,
)
export type SectionBodyWeft = typeof SectionBodyWeftSchema.Type
