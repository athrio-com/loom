import { Schema } from "effect"
import { LineRangeSchema } from "./StreamLineRanges"
import {
  ArrowTokenSchema,
  HeadingStartTokenSchema,
  SeparatorTokenSchema,
  SpecifierTokenSchema,
  TagTokenSchema,
  TildeTokenSchema,
} from "./LoomTokens"

// =============================================================================
// Wefts — line-level ADT. Each Weft carries the LineRange of its source line
// and any recognised structural tokens as typed fields. Weft boundaries
// replace any EndOfLine concept. Default/trailing text is derivable from the
// source string sliced by `source` and any structural-token positions.
// =============================================================================

// Default Weft — line with no structure. Content is `source` sliced from the
// original text by the consumer.
export const WeftSchema = Schema.Struct({
  type: Schema.Literal("Weft"),
  source: LineRangeSchema,
})
export type Weft = typeof WeftSchema.Type

// HeadingWeft — heading line. Required headingStart; optional tag and/or
// specifier embedded in the title text. The title text itself is sliceable
// from the original source using `headingStart.position.end.offset`,
// `tag?.position`, `specifier?.position`, and `source[1]` (the line end).
export const HeadingWeftSchema = Schema.Struct({
  type: Schema.Literal("HeadingWeft"),
  source: LineRangeSchema,
  headingStart: HeadingStartTokenSchema,
  tag: Schema.optional(TagTokenSchema),
  specifier: Schema.optional(SpecifierTokenSchema),
})
export type HeadingWeft = typeof HeadingWeftSchema.Type

// ArrowWeft — arrow line. Any trailing content is sliceable from the original
// source using `arrow.position.end.offset` and `source[1]`.
export const ArrowWeftSchema = Schema.Struct({
  type: Schema.Literal("ArrowWeft"),
  source: LineRangeSchema,
  arrow: ArrowTokenSchema,
})
export type ArrowWeft = typeof ArrowWeftSchema.Type

// TildeWeft — tilde line. Trailing content derivable as with ArrowWeft.
export const TildeWeftSchema = Schema.Struct({
  type: Schema.Literal("TildeWeft"),
  source: LineRangeSchema,
  tilde: TildeTokenSchema,
})
export type TildeWeft = typeof TildeWeftSchema.Type

// SeparatorWeft — `---` line. No content.
export const SeparatorWeftSchema = Schema.Struct({
  type: Schema.Literal("SeparatorWeft"),
  source: LineRangeSchema,
  separator: SeparatorTokenSchema,
})
export type SeparatorWeft = typeof SeparatorWeftSchema.Type

// =============================================================================
// LoomWeft — the union of all five Weft kinds. The Tokeniser's output stream
// element type.
// =============================================================================

export const LoomWeftSchema = Schema.Union(
  WeftSchema,
  HeadingWeftSchema,
  // PreambleWeftSchema, ProseWeftSchema, CodeWeftSchema, 
  ArrowWeftSchema,
  TildeWeftSchema,
  SeparatorWeftSchema,
)
export type LoomWeft = typeof LoomWeftSchema.Type
