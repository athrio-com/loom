import { Schema } from "effect"

// =============================================================================
// Position
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
// Heading tokens
// =============================================================================

export const LoomHeadingTextSchema = Schema.Struct({
  type: Schema.Literal("LoomHeadingText"),
  position: PositionSchema,
  value: Schema.String,
})
export type LoomHeadingText = typeof LoomHeadingTextSchema.Type

export const LoomTagSchema = Schema.Struct({
  type: Schema.Literal("LoomTag"),
  position: PositionSchema, // whole `[name]`
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
  position: PositionSchema, // whole `{name}`
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

// =============================================================================
// Heading variants
// =============================================================================

const headingBase = {
  position: PositionSchema,
  markers: Schema.Struct({
    value: Schema.String.pipe(Schema.pattern(/^#{1,6}$/)),
    position: PositionSchema,
  }),
  text: LoomHeadingTextSchema,
}

export const LoomChapterHeadingSchema = Schema.Struct({
  type: Schema.Literal("LoomChapterHeading"),
  ...headingBase,
  tag: LoomTagSchema,             // required
  specifier: LoomSpecifierSchema, // required
})
export type LoomChapterHeading = typeof LoomChapterHeadingSchema.Type

export const LoomSectionHeadingSchema = Schema.Struct({
  type: Schema.Literal("LoomSectionHeading"),
  ...headingBase,
  tag: Schema.optional(LoomTagSchema),
  specifier: Schema.optional(LoomSpecifierSchema),
})
export type LoomSectionHeading = typeof LoomSectionHeadingSchema.Type

// =============================================================================
// Sections — Prose, Code, Dependencies
// =============================================================================

export const LoomProseLineSchema = Schema.Struct({
  type: Schema.Literal("LoomProseLine"),
  position: PositionSchema,
  value: Schema.String,
})
export type LoomProseLine = typeof LoomProseLineSchema.Type

export const LoomProseSectionSchema = Schema.Struct({
  type: Schema.Literal("LoomProseSection"),
  position: PositionSchema,
  heading: LoomSectionHeadingSchema,
  lines: Schema.Array(LoomProseLineSchema),
})
export type LoomProseSection = typeof LoomProseSectionSchema.Type

// -----------------------------------------------------------------------------
// LoomCodeSection primitives
// -----------------------------------------------------------------------------

// Stub — to be filled when Param syntax (e.g. `{{name: type}}`) is implemented.
export const LoomParamSchema = Schema.Struct({
  type: Schema.Literal("LoomParam"),
  position: PositionSchema,
})
export type LoomParam = typeof LoomParamSchema.Type

export const LoomPreambleLineSchema = Schema.Struct({
  type: Schema.Literal("LoomPreambleLine"),
  position: PositionSchema,
  value: Schema.String,
  params: Schema.Array(LoomParamSchema), // empty until Param recognition lands
})
export type LoomPreambleLine = typeof LoomPreambleLineSchema.Type

export const LoomPreambleSchema = Schema.Struct({
  type: Schema.Literal("LoomPreamble"),
  position: PositionSchema,
  lines: Schema.Array(LoomPreambleLineSchema),
})
export type LoomPreamble = typeof LoomPreambleSchema.Type

export const LoomArrowSchema = Schema.Struct({
  type: Schema.Literal("LoomArrow"),
  position: PositionSchema, // span of `=>`
})
export type LoomArrow = typeof LoomArrowSchema.Type

export const LoomCodeLineSchema = Schema.Struct({
  type: Schema.Literal("LoomCodeLine"),
  position: PositionSchema,
  value: Schema.String,
})
export type LoomCodeLine = typeof LoomCodeLineSchema.Type

export const LoomCodeSchema = Schema.Struct({
  type: Schema.Literal("LoomCode"),
  position: PositionSchema,
  lines: Schema.Array(Schema.Union(LoomCodeLineSchema, LoomProseLineSchema)),
})
export type LoomCode = typeof LoomCodeSchema.Type

// -----------------------------------------------------------------------------
// LoomCodeSection — heading + optional preamble + arrow + code
// -----------------------------------------------------------------------------

export const LoomCodeSectionSchema = Schema.Struct({
  type: Schema.Literal("LoomCodeSection"),
  position: PositionSchema,
  heading: LoomSectionHeadingSchema,
  preamble: Schema.optional(LoomPreambleSchema),
  arrow: LoomArrowSchema,
  code: LoomCodeSchema,
})
export type LoomCodeSection = typeof LoomCodeSectionSchema.Type

export const LoomDependenciesSectionSchema = Schema.Struct({
  type: Schema.Literal("LoomDependenciesSection"),
  position: PositionSchema,
  heading: LoomSectionHeadingSchema,
})
export type LoomDependenciesSection = typeof LoomDependenciesSectionSchema.Type

export const LoomSectionSchema = Schema.Union(
  LoomProseSectionSchema,
  LoomCodeSectionSchema,
  LoomDependenciesSectionSchema,
)
export type LoomSection = typeof LoomSectionSchema.Type

// =============================================================================
// Chapter — not a section, holds sections and an optional dependencies section
// =============================================================================

export const LoomChapterSchema = Schema.Struct({
  type: Schema.Literal("LoomChapter"),
  position: PositionSchema,
  heading: LoomChapterHeadingSchema,
  sections: Schema.Array(Schema.Union(
    LoomProseSectionSchema,
    LoomCodeSectionSchema,
  )),
  dependencies: Schema.optional(LoomDependenciesSectionSchema),
})
export type LoomChapter = typeof LoomChapterSchema.Type

// =============================================================================
// Document — at least one chapter required (uniform hoisting rule)
// =============================================================================

export const LoomDocumentSchema = Schema.Struct({
  type: Schema.Literal("LoomDocument"),
  position: PositionSchema,
  chapters: Schema.Array(LoomChapterSchema).pipe(Schema.minItems(1)),
})
export type LoomDocument = typeof LoomDocumentSchema.Type
