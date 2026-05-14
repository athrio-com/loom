import { Option, Schema, SchemaAST } from "effect"
import { PositionSchema } from "./LoomDocument"
import { SourceLineSchema } from "./LoomSourceStream"

// =============================================================================
// Probe annotation — schema-level metadata carrying the regex the Tokeniser
// uses to recognise this token kind. Probe matches do not equal the token:
// they're an input to the Tokeniser, which assembles the typed token
// (including any subtoken positions) from the match per kind.
// =============================================================================

export const Probe: unique symbol = Symbol.for("loom/Probe")

export const getProbe = (
  schema: Schema.Schema<any, any, never>,
): Option.Option<RegExp> =>
  SchemaAST.getAnnotation<RegExp>(Probe)(schema.ast)

// =============================================================================
// Tokens — building blocks emitted by the Tokeniser and used as typed fields
// of Wefts (below). Every token has a Probe; text-only portions of a line
// (between or around recognised tokens) are derivable from `source.text` and
// the surrounding positions, so they're not modelled as a token.
//
// Tokens with internal anatomy (Tag, Specifier, HeadingStart) expose their
// parts as subtokens — `{ value, position }` — so downstream consumers can
// target the precision they need.
// =============================================================================

export const HeadingStartTokenSchema = Schema.Struct({
  type: Schema.Literal("HeadingStart"),
  position: PositionSchema, // whole `## ` including trailing space
  markers: Schema.Struct({
    value: Schema.String.pipe(Schema.pattern(/^#{1,6}$/)),
    position: PositionSchema,
  }),
}).annotations({
  [Probe]: /^#{1,6} /,
})
export type HeadingStartToken = typeof HeadingStartTokenSchema.Type

export const TagTokenSchema = Schema.Struct({
  type: Schema.Literal("Tag"),
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
}).annotations({
  [Probe]: /\[[a-zA-Z0-9_-]+\]/g,
})
export type TagToken = typeof TagTokenSchema.Type

export const SpecifierTokenSchema = Schema.Struct({
  type: Schema.Literal("Specifier"),
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
}).annotations({
  [Probe]: /\{[a-zA-Z0-9_-]+\}/g,
})
export type SpecifierToken = typeof SpecifierTokenSchema.Type

export const ArrowTokenSchema = Schema.Struct({
  type: Schema.Literal("Arrow"),
  position: PositionSchema, // span of `=>` (without surrounding whitespace)
}).annotations({
  [Probe]: /^\s*=>/,
})
export type ArrowToken = typeof ArrowTokenSchema.Type

export const TildeTokenSchema = Schema.Struct({
  type: Schema.Literal("Tilde"),
  position: PositionSchema, // span of the tilde stack (without surrounding whitespace)
}).annotations({
  [Probe]: /^\s*~+/,
})
export type TildeToken = typeof TildeTokenSchema.Type

export const SeparatorTokenSchema = Schema.Struct({
  type: Schema.Literal("Separator"),
  position: PositionSchema, // span of `---` at column 1
}).annotations({
  [Probe]: /^---$/,
})
export type SeparatorToken = typeof SeparatorTokenSchema.Type

// =============================================================================
// LoomToken — the union of all six tokens.
// =============================================================================

export const LoomTokenSchema = Schema.Union(
  HeadingStartTokenSchema,
  TagTokenSchema,
  SpecifierTokenSchema,
  ArrowTokenSchema,
  TildeTokenSchema,
  SeparatorTokenSchema,
)
export type LoomToken = typeof LoomTokenSchema.Type

// =============================================================================
// Wefts — line-level ADT. Each Weft preserves its SourceLine and carries any
// recognised structural tokens as typed fields. Weft boundaries replace any
// EndOfLine concept. Default/trailing text is derivable from `source.text`
// and structural-token positions.
//
// Kinds:
//   Weft           — default line, no recognised structure
//   HeadingWeft    — `#{1,6} ` line, optionally containing a tag and/or specifier
//   ArrowWeft      — optional indent + `=>` line
//   TildeWeft      — optional indent + `~+` line
//   SeparatorWeft  — exact `---` line
// =============================================================================

// Default Weft — line with no structure. Content is source.text.
export const WeftSchema = Schema.Struct({
  type: Schema.Literal("Weft"),
  source: SourceLineSchema,
})
export type Weft = typeof WeftSchema.Type

// HeadingWeft — heading line. Required headingStart; optional tag and/or
// specifier embedded in the title text. The title text itself is sliceable
// from `source.text` using `headingStart.position.end.offset`, `tag?.position`,
// `specifier?.position`, and `source.text.length`.
export const HeadingWeftSchema = Schema.Struct({
  type: Schema.Literal("HeadingWeft"),
  source: SourceLineSchema,
  headingStart: HeadingStartTokenSchema,
  tag: Schema.optional(TagTokenSchema),
  specifier: Schema.optional(SpecifierTokenSchema),
})
export type HeadingWeft = typeof HeadingWeftSchema.Type

// ArrowWeft — arrow line. Any trailing content is sliceable from source.text
// using `arrow.position.end.offset - source.startPoint.offset`.
export const ArrowWeftSchema = Schema.Struct({
  type: Schema.Literal("ArrowWeft"),
  source: SourceLineSchema,
  arrow: ArrowTokenSchema,
})
export type ArrowWeft = typeof ArrowWeftSchema.Type

// TildeWeft — tilde line. Trailing content derivable as with ArrowWeft.
export const TildeWeftSchema = Schema.Struct({
  type: Schema.Literal("TildeWeft"),
  source: SourceLineSchema,
  tilde: TildeTokenSchema,
})
export type TildeWeft = typeof TildeWeftSchema.Type

// SeparatorWeft — `---` line. No content.
export const SeparatorWeftSchema = Schema.Struct({
  type: Schema.Literal("SeparatorWeft"),
  source: SourceLineSchema,
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
  ArrowWeftSchema,
  TildeWeftSchema,
  SeparatorWeftSchema,
)
export type LoomWeft = typeof LoomWeftSchema.Type