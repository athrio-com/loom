import { Schema } from "effect"
import { LineRangeSchema } from "./LineRanges"

// =============================================================================
// Position — start/end byte offsets into source text.
//
// Used by tokens and AST nodes that need precise span boundaries.
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
// Heading — uniform for both chapters and sections.
//
// Every heading has markers (`#` to `######`) and text. Tag and specifier
// are optional at the schema level. The parser enforces that chapters
// require both — that's a validation rule, not a type split.
// =============================================================================

export const LoomTagSchema = Schema.Struct({
  type: Schema.Literal("LoomTag"),
  position: PositionSchema,
  open: Schema.Struct({
    value: Schema.Literal("["),
    position: PositionSchema,
  }),
  label: Schema.Struct({
    value: Schema.String,
    position: PositionSchema,
  }),
  close: Schema.Struct({
    value: Schema.Literal("]"),
    position: PositionSchema,
  }),
})
export type LoomTag = typeof LoomTagSchema.Type

export const LoomSpecifierSchema = Schema.Struct({
  type: Schema.Literal("LoomSpecifier"),
  position: PositionSchema,
  open: Schema.Struct({
    value: Schema.Literal("{"),
    position: PositionSchema,
  }),
  label: Schema.Struct({
    value: Schema.String,
    position: PositionSchema,
  }),
  close: Schema.Struct({
    value: Schema.Literal("}"),
    position: PositionSchema,
  }),
})
export type LoomSpecifier = typeof LoomSpecifierSchema.Type

export const LoomHeadingSchema = Schema.Struct({
  type: Schema.Literal("LoomHeading"),
  position: PositionSchema,
  markers: Schema.Struct({
    value: Schema.String.pipe(Schema.pattern(/^#{1,6}$/)),
    position: PositionSchema,
  }),
  text: Schema.Struct({
    value: Schema.String,
    position: PositionSchema,
  }),
  tag: Schema.optional(LoomTagSchema),
  specifier: Schema.optional(LoomSpecifierSchema),
})
export type LoomHeading = typeof LoomHeadingSchema.Type

// =============================================================================
// Arrow — the `=>` line that separates preamble from code.
// =============================================================================

export const LoomArrowSchema = Schema.Struct({
  type: Schema.Literal("LoomArrow"),
  position: PositionSchema,
})
export type LoomArrow = typeof LoomArrowSchema.Type

// =============================================================================
// Section — one structural unit under a chapter.
//
// Self-descriptive: read the fields to know what's present.
//   - No arrow, no code  → prose section
//   - Arrow present       → code section (preamble before arrow, code after)
//
// "Dependencies" is not a structural variant — it's a section whose tag
// matches a reserved name. Semantic, not syntactic.
//
// Lines are stored as LineRanges into the source text. Text values are
// derived on demand via `text.slice(start, end)`.
// =============================================================================

export const LoomSectionSchema = Schema.Struct({
  type: Schema.Literal("LoomSection"),
  position: PositionSchema,
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

export const LoomChapterSchema = Schema.Struct({
  type: Schema.Literal("LoomChapter"),
  position: PositionSchema,
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

export const LoomDocumentSchema = Schema.Struct({
  type: Schema.Literal("LoomDocument"),
  position: PositionSchema,
  chapters: Schema.Array(LoomChapterSchema).pipe(Schema.minItems(1)),
})
export type LoomDocument = typeof LoomDocumentSchema.Type