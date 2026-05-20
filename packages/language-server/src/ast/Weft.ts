import { Schema } from "effect"
import { LineRangeSchema } from "./LineRanges"
import {
  ArrowTokenSchema,
  ChapterHeadingStartTokenSchema,
  CodeTokenSchema,
  ProseTokenSchema,
  SectionHeadingStartTokenSchema,
  SeparatorTokenSchema,
  SpecifierTokenSchema,
  TagTokenSchema,
  TextTokenSchema,
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

// ChapterHeadingWeft — `#` heading. The headingStart token kind enforces
// level 1. Title text is decomposed into TextTokens (one per contiguous run
// between structural tokens). Both `tag` and `specifier` are required: the
// chapter heading declares the document's name and language.
export const ChapterHeadingWeftSchema = Schema.Struct({
  type: Schema.Literal("ChapterHeadingWeft"),
  source: LineRangeSchema,
  headingStart: ChapterHeadingStartTokenSchema,
  texts: Schema.Array(TextTokenSchema),
  tag: Schema.optional(TagTokenSchema),
  specifier: Schema.optional(SpecifierTokenSchema),
}).pipe(
  Schema.filter((w) =>
    w.tag !== undefined && w.specifier !== undefined
      ? undefined
      : "ChapterHeadingWeft requires both tag and specifier",
  ),
)
export type ChapterHeadingWeft = typeof ChapterHeadingWeftSchema.Type

// SectionHeadingWeft — `##`+ heading. The headingStart token kind enforces
// level 2+. Tag and specifier are both optional. Does not apply when the
// heading is recognised as a reserved Dependencies or Tangle heading at
// classification time.
export const SectionHeadingWeftSchema = Schema.Struct({
  type: Schema.Literal("SectionHeadingWeft"),
  source: LineRangeSchema,
  headingStart: SectionHeadingStartTokenSchema,
  texts: Schema.Array(TextTokenSchema),
  tag: Schema.optional(TagTokenSchema),
  specifier: Schema.optional(SpecifierTokenSchema),
})
export type SectionHeadingWeft = typeof SectionHeadingWeftSchema.Type

// DependenciesHeadingWeft — reserved `##`+ heading whose tag is `[D]`.
// Recognised by `classifyWefts` by inspecting the tag of a SectionHeadingStart
// match; not promoted from SectionHeadingWeft later.
export const DependenciesHeadingWeftSchema = Schema.Struct({
  type: Schema.Literal("DependenciesHeadingWeft"),
  source: LineRangeSchema,
  headingStart: SectionHeadingStartTokenSchema,
  texts: Schema.Array(TextTokenSchema),
  tag: TagTokenSchema,
}).pipe(
  Schema.filter((w) =>
    w.tag.label.value === "D"
      ? undefined
      : "DependenciesHeadingWeft requires tag `[D]`",
  ),
)
export type DependenciesHeadingWeft = typeof DependenciesHeadingWeftSchema.Type

// TangleHeadingWeft — reserved `##`+ heading whose tag is `[T]`. Same
// recognition approach as DependenciesHeadingWeft.
export const TangleHeadingWeftSchema = Schema.Struct({
  type: Schema.Literal("TangleHeadingWeft"),
  source: LineRangeSchema,
  headingStart: SectionHeadingStartTokenSchema,
  texts: Schema.Array(TextTokenSchema),
  tag: TagTokenSchema,
}).pipe(
  Schema.filter((w) =>
    w.tag.label.value === "T"
      ? undefined
      : "TangleHeadingWeft requires tag `[T]`",
  ),
)
export type TangleHeadingWeft = typeof TangleHeadingWeftSchema.Type

// ArrowWeft — arrow line. Any trailing code content is tokenised as a
// CodeToken; lines with only `=>` omit `code`.
export const ArrowWeftSchema = Schema.Struct({
  type: Schema.Literal("ArrowWeft"),
  source: LineRangeSchema,
  arrow: ArrowTokenSchema,
  code: Schema.optional(CodeTokenSchema),
})
export type ArrowWeft = typeof ArrowWeftSchema.Type

// TildeWeft — tilde line. Any trailing prose content is tokenised as a
// ProseToken; lines with only the tilde stack omit `prose`.
export const TildeWeftSchema = Schema.Struct({
  type: Schema.Literal("TildeWeft"),
  source: LineRangeSchema,
  tilde: TildeTokenSchema,
  prose: Schema.optional(ProseTokenSchema),
})
export type TildeWeft = typeof TildeWeftSchema.Type

// SeparatorWeft — `---` line. No content.
export const SeparatorWeftSchema = Schema.Struct({
  type: Schema.Literal("SeparatorWeft"),
  source: LineRangeSchema,
  separator: SeparatorTokenSchema,
})
export type SeparatorWeft = typeof SeparatorWeftSchema.Type

// ProseWeft — line classified in prose mode with no additional structure.
export const ProseWeftSchema = Schema.Struct({
  type: Schema.Literal("ProseWeft"),
  source: LineRangeSchema,
})
export type ProseWeft = typeof ProseWeftSchema.Type

// CodeWeft — line classified in code mode; opaque to Loom.
export const CodeWeftSchema = Schema.Struct({
  type: Schema.Literal("CodeWeft"),
  source: LineRangeSchema,
})
export type CodeWeft = typeof CodeWeftSchema.Type

// DependencyWeft — line classified in deps mode.
// TODO: subtoken structure
export const DependencyWeftSchema = Schema.Struct({
  type: Schema.Literal("DependencyWeft"),
  source: LineRangeSchema,
})
export type DependencyWeft = typeof DependencyWeftSchema.Type

// TangleWeft — line classified in tangle mode.
// TODO: subtoken structure
export const TangleWeftSchema = Schema.Struct({
  type: Schema.Literal("TangleWeft"),
  source: LineRangeSchema,
})
export type TangleWeft = typeof TangleWeftSchema.Type

// =============================================================================
// LoomWeft — the union of all Weft kinds. The Tokeniser's output stream
// element type.
// =============================================================================

export const LoomWeftSchema = Schema.Union(
  WeftSchema,
  ChapterHeadingWeftSchema,
  SectionHeadingWeftSchema,
  DependenciesHeadingWeftSchema,
  TangleHeadingWeftSchema,
  ArrowWeftSchema,
  TildeWeftSchema,
  SeparatorWeftSchema,
  ProseWeftSchema,
  CodeWeftSchema,
  DependencyWeftSchema,
  TangleWeftSchema,
)
export type LoomWeft = typeof LoomWeftSchema.Type
