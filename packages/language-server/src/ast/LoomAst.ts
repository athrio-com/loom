import { Schema } from "effect"
import { LineRangeSchema } from "./LineRanges"

// =============================================================================
// Position — start/end byte offsets into source text.
//
// Used by every AST node and subnode for precise span boundaries.
// `line` and `column` are convenience fields for diagnostics; `offset` is
// the source of truth for Volar mappings.
// =============================================================================

export const PointSchema = Schema.Struct({
  line: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(1)),
  column: Schema.optional(
    Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(1))
  ),
  offset: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)),
})
export type Point = typeof PointSchema.Type

export const PositionSchema = Schema.Struct({
  start: PointSchema,
  end: PointSchema,
})
export type Position = typeof PositionSchema.Type

// =============================================================================
// Severity — diagnostic level. "info" is non-NOK; nodes carrying only info
// diagnostics keep health.status === "ok".
// =============================================================================

export const SeveritySchema = Schema.Literal("error", "warning", "info")
export type Severity = typeof SeveritySchema.Type

// =============================================================================
// Diagnostic — positioned message attached to a node's health field.
// =============================================================================

export const DiagnosticSchema = Schema.Struct({
  message: Schema.String,
  position: PositionSchema,
  severity: SeveritySchema,
})
export type Diagnostic = typeof DiagnosticSchema.Type

// =============================================================================
// Health — every AST node carries this. `status` summarises the worst of the
// attached diagnostics; "ok" if none above info.
// =============================================================================

export const HealthStatusSchema = Schema.Literal("ok", "error", "warning")
export type HealthStatus = typeof HealthStatusSchema.Type

export const HealthSchema = Schema.Struct({
  status: HealthStatusSchema,
  diagnostics: Schema.Array(DiagnosticSchema),
})
export type Health = typeof HealthSchema.Type

// Convenience: the canonical "no problems" health value. Use this everywhere
// the producer has nothing to report.
export const okHealth: Health = { status: "ok", diagnostics: [] }

// =============================================================================
// loomNode() — the AST schema combinator.
//
// Every AST node — top-level (Document, Chapter, Section, Heading, ...) and
// every subnode (heading markers/text, tag/specifier open/label/close) —
// carries the same three fields:
//
//   type:     a literal discriminator
//   position: source span
//   health:   diagnostics attached to this node
//
// loomNode(tag, fields) produces a Schema.Struct with those three plus the
// caller's fields. The walker recognises a node by the presence of `type`
// and recurses into any field whose value has one.
// =============================================================================

export const loomNode = <
  Tag extends string,
  Fields extends Schema.Struct.Fields,
>(tag: Tag, fields: Fields) => Schema.Struct({
  type: Schema.Literal(tag),
  position: PositionSchema,
  health: HealthSchema,
  ...fields,
})

// =============================================================================
// Heading subnodes — markers and text.
//
// `markers` is the leading `#`–`######` run. `text` is the heading title with
// inline tag/specifier brackets sliced out (positions of those live on the
// LoomTag/LoomSpecifier subnodes).
// =============================================================================

export const LoomHeadingMarkersSchema = loomNode("LoomHeadingMarkers", {
  value: Schema.String.pipe(Schema.pattern(/^#{1,6}$/)),
})
export type LoomHeadingMarkers = typeof LoomHeadingMarkersSchema.Type

export const LoomHeadingTextSchema = loomNode("LoomHeadingText", {
  value: Schema.String,
})
export type LoomHeadingText = typeof LoomHeadingTextSchema.Type

// =============================================================================
// Tag — `[name]`. Open/label/close are named subnodes so each can carry its
// own health (e.g. a "missing `]`" diagnostic lives on the close subnode).
// =============================================================================

export const LoomTagOpenSchema = loomNode("LoomTagOpen", {
  value: Schema.Literal("["),
})
export type LoomTagOpen = typeof LoomTagOpenSchema.Type

export const LoomTagLabelSchema = loomNode("LoomTagLabel", {
  value: Schema.String,
})
export type LoomTagLabel = typeof LoomTagLabelSchema.Type

export const LoomTagCloseSchema = loomNode("LoomTagClose", {
  value: Schema.Literal("]"),
})
export type LoomTagClose = typeof LoomTagCloseSchema.Type

export const LoomTagSchema = loomNode("LoomTag", {
  open: LoomTagOpenSchema,
  label: LoomTagLabelSchema,
  close: LoomTagCloseSchema,
})
export type LoomTag = typeof LoomTagSchema.Type

// =============================================================================
// Specifier — `{name}`. Same anatomy as Tag, different delimiters.
// =============================================================================

export const LoomSpecifierOpenSchema = loomNode("LoomSpecifierOpen", {
  value: Schema.Literal("{"),
})
export type LoomSpecifierOpen = typeof LoomSpecifierOpenSchema.Type

export const LoomSpecifierLabelSchema = loomNode("LoomSpecifierLabel", {
  value: Schema.String,
})
export type LoomSpecifierLabel = typeof LoomSpecifierLabelSchema.Type

export const LoomSpecifierCloseSchema = loomNode("LoomSpecifierClose", {
  value: Schema.Literal("}"),
})
export type LoomSpecifierClose = typeof LoomSpecifierCloseSchema.Type

export const LoomSpecifierSchema = loomNode("LoomSpecifier", {
  open: LoomSpecifierOpenSchema,
  label: LoomSpecifierLabelSchema,
  close: LoomSpecifierCloseSchema,
})
export type LoomSpecifier = typeof LoomSpecifierSchema.Type

// =============================================================================
// Heading — uniform for chapters and sections at the schema level.
//
// Tag and specifier are optional here. The parser enforces that chapter
// headings require both — that's a validation rule, not a type split.
// =============================================================================

export const LoomHeadingSchema = loomNode("LoomHeading", {
  markers: LoomHeadingMarkersSchema,
  text: LoomHeadingTextSchema,
  tag: Schema.optional(LoomTagSchema),
  specifier: Schema.optional(LoomSpecifierSchema),
})
export type LoomHeading = typeof LoomHeadingSchema.Type

// =============================================================================
// Arrow — the `=>` line that separates preamble from code.
// =============================================================================

export const LoomArrowSchema = loomNode("LoomArrow", {})
export type LoomArrow = typeof LoomArrowSchema.Type

// =============================================================================
// Section — one structural unit under a chapter.
//
// Self-descriptive: read the fields to know what's present.
//   - No arrow, no code  → prose section
//   - Arrow present       → code section (preamble before arrow, code after)
//
// Lines are stored as LineRanges into the source text. Text values are
// derived on demand via `text.slice(start, end)`.
// =============================================================================

export const LoomSectionSchema = loomNode("LoomSection", {
  heading: LoomHeadingSchema,
  preamble: Schema.Array(LineRangeSchema),
  arrow: Schema.optional(LoomArrowSchema),
  code: Schema.Array(LineRangeSchema),
})
export type LoomSection = typeof LoomSectionSchema.Type

// =============================================================================
// Chapter — a section that also holds child sections.
//
// Same shape as Section (heading, preamble, arrow, code) plus a `sections`
// array for ## members. The parser requires tag and specifier on the
// heading for chapters; the schema leaves them optional to keep one
// heading type.
// =============================================================================

export const LoomChapterSchema = loomNode("LoomChapter", {
  heading: LoomHeadingSchema,
  preamble: Schema.Array(LineRangeSchema),
  arrow: Schema.optional(LoomArrowSchema),
  code: Schema.Array(LineRangeSchema),
  sections: Schema.Array(LoomSectionSchema),
})
export type LoomChapter = typeof LoomChapterSchema.Type

// =============================================================================
// Document — the root. At least one chapter required.
// =============================================================================

export const LoomDocumentSchema = loomNode("LoomDocument", {
  chapters: Schema.Array(LoomChapterSchema).pipe(Schema.minItems(1)),
})
export type LoomDocument = typeof LoomDocumentSchema.Type
