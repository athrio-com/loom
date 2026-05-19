import { Option, Schema, SchemaAST } from "effect"
import { PositionSchema } from "./LoomDocument"

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
// Tokens — building blocks emitted by the Tokeniser and consumed by Wefts as
// typed fields. Every token carries a Probe regex. Text-only portions of a
// line (between or around recognised tokens) are not modelled as a token —
// they're derivable from the surrounding token positions and the source.
//
// Tokens with internal anatomy (HeadingStart, Tag, Specifier) expose their
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
// LoomToken — the union of all six tokens. The Tokeniser's intermediate
// emission type, before Wefts assemble per-line groupings.
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
