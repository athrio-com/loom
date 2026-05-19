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
// typed fields. Every token carries a Probe regex.
//
// Tokens with internal anatomy (HeadingStart, Tag, Specifier) expose their
// parts as subtokens — `{ value, position }` — so downstream consumers can
// target the precision they need.
// =============================================================================

// Level-specific HeadingStart tokens. classifyWefts probes each and routes
// directly: a ChapterHeadingStart match yields a ChapterHeadingWeft; a
// SectionHeadingStart match yields one of SectionHeadingWeft /
// DependenciesHeadingWeft / TangleHeadingWeft (disambiguated by tag).

export const ChapterHeadingStartTokenSchema = Schema.Struct({
  type: Schema.Literal("ChapterHeadingStart"),
  position: PositionSchema, // whole `# ` including trailing space
  markers: Schema.Struct({
    value: Schema.Literal("#"),
    position: PositionSchema,
  }),
}).annotations({
  [Probe]: /^# /,
})
export type ChapterHeadingStartToken = typeof ChapterHeadingStartTokenSchema.Type

export const SectionHeadingStartTokenSchema = Schema.Struct({
  type: Schema.Literal("SectionHeadingStart"),
  position: PositionSchema, // whole `##` (1–5 trailing `#`s) + ` ` including trailing space
  markers: Schema.Struct({
    value: Schema.String.pipe(Schema.pattern(/^#{2,6}$/)),
    position: PositionSchema,
  }),
}).annotations({
  [Probe]: /^#{2,6} /,
})
export type SectionHeadingStartToken = typeof SectionHeadingStartTokenSchema.Type

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

export const TextTokenSchema = Schema.Struct({
  type: Schema.Literal("Text"),
  position: PositionSchema, // contiguous text run between structural tokens on a heading line
}).annotations({
  [Probe]: /[^\[\]\{\}]+/g,
})
export type TextToken = typeof TextTokenSchema.Type

export const CodeTokenSchema = Schema.Struct({
  type: Schema.Literal("Code"),
  position: PositionSchema, // code content; on an Arrow line, the content after `=>`
}).annotations({
  [Probe]: /(?<=^\s*=>\s*)\S.*$/,
})
export type CodeToken = typeof CodeTokenSchema.Type

export const ProseTokenSchema = Schema.Struct({
  type: Schema.Literal("Prose"),
  position: PositionSchema, // prose content; on a Tilde line, the content after `~`
}).annotations({
  [Probe]: /(?<=^\s*~+\s*)\S.*$/,
})
export type ProseToken = typeof ProseTokenSchema.Type

// =============================================================================
// LoomToken — the union of all six tokens. The Tokeniser's intermediate
// emission type, before Wefts assemble per-line groupings.
// =============================================================================

export const LoomTokenSchema = Schema.Union(
  ChapterHeadingStartTokenSchema,
  SectionHeadingStartTokenSchema,
  TagTokenSchema,
  SpecifierTokenSchema,
  ArrowTokenSchema,
  TildeTokenSchema,
  SeparatorTokenSchema,
  TextTokenSchema,
  CodeTokenSchema,
  ProseTokenSchema,
)
export type LoomToken = typeof LoomTokenSchema.Type
