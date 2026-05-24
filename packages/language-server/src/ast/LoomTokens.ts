import { Option, Schema, SchemaAST } from "effect"
import { loomNode } from "./LoomNode"

// =============================================================================
// Probe annotation — schema-level metadata carrying the regex the
// WeftClassifier / WeftTokeniser use to recognise this token kind. A Probe
// match is the recognition signal; the typed token is assembled from the
// match (and any subtoken positions) per kind.
// =============================================================================

export const Probe: unique symbol = Symbol.for("loom/Probe")

export const getProbe = (
  schema: Schema.Schema<any, any, never>,
): Option.Option<RegExp> =>
  SchemaAST.getAnnotation<RegExp>(Probe)(schema.ast)

// =============================================================================
// Tokens — the AST's leaf nodes. Every token goes through `loomNode`, so
// each carries `type` / `position` / `health` like any container.
//
// Compound tokens (Tag, Specifier) expose their parts as named subnodes —
// each subnode is itself a `loomNode`, so it carries its own health and can
// receive diagnostics directly (e.g. a "missing `]`" diagnostic attaches to
// the close subnode at the position it should have occupied).
// =============================================================================

// =============================================================================
// HeadingStart — split by level so classifyWefts can route by probe match.
//
// `value` is the marker string (`#` for chapter, `##`–`######` for section).
// `position` covers the marker characters only; the trailing space matched
// by the probe is not part of the token span.
// =============================================================================

export const ChapterHeadingStartTokenSchema = loomNode("ChapterHeadingStart", {
  value: Schema.Literal("#"),
}).annotations({
  [Probe]: /^# /,
})
export type ChapterHeadingStartToken = typeof ChapterHeadingStartTokenSchema.Type

export const SectionHeadingStartTokenSchema = loomNode("SectionHeadingStart", {
  value: Schema.String.pipe(Schema.pattern(/^#{2,6}$/)),
}).annotations({
  [Probe]: /^#{2,6} /,
})
export type SectionHeadingStartToken = typeof SectionHeadingStartTokenSchema.Type

// =============================================================================
// Tag — `[name]`. Open / label / close are named subnodes so each can carry
// its own health.
// =============================================================================

export const TagOpenTokenSchema = loomNode("TagOpen", {
  value: Schema.Literal("["),
}).annotations({
  [Probe]: /\[/g,
})
export type TagOpenToken = typeof TagOpenTokenSchema.Type

// Tag label — cross-field rule: a non-empty value must match the character
// class shared with the composite Probe; an empty value is admitted only on
// NOK-health nodes (incomplete/error/warning placeholders). Real labels with
// ok health are always pattern-conforming; placeholders communicate "no
// label here" via empty value + non-ok health.
export const TagLabelTokenSchema = loomNode("TagLabel", {
  value: Schema.String,
}).pipe(
  Schema.filter((t) => {
    if (t.value === "" && t.health.status === "ok") {
      return "empty `value` requires non-ok `health.status`"
    }
    if (t.value !== "" && !/^[a-zA-Z0-9_-]+$/.test(t.value)) {
      return `label value must match [a-zA-Z0-9_-]+, got \`${t.value}\``
    }
    return true
  }),
)
export type TagLabelToken = typeof TagLabelTokenSchema.Type

export const TagCloseTokenSchema = loomNode("TagClose", {
  value: Schema.Literal("]"),
}).annotations({
  [Probe]: /\]/g,
})
export type TagCloseToken = typeof TagCloseTokenSchema.Type

export const TagTokenSchema = loomNode("Tag", {
  open: TagOpenTokenSchema,
  label: TagLabelTokenSchema,
  close: TagCloseTokenSchema,
}).annotations({
  [Probe]: /\[[a-zA-Z0-9_-]+\]/g,
})
export type TagToken = typeof TagTokenSchema.Type

// =============================================================================
// Specifier — `{name}`. Same anatomy as Tag, different delimiters.
// =============================================================================

export const SpecifierOpenTokenSchema = loomNode("SpecifierOpen", {
  value: Schema.Literal("{"),
}).annotations({
  [Probe]: /\{/g,
})
export type SpecifierOpenToken = typeof SpecifierOpenTokenSchema.Type

// Specifier label — same cross-field rule as TagLabel: empty value allowed
// only when health is NOK; non-empty values must match the Probe's class.
export const SpecifierLabelTokenSchema = loomNode("SpecifierLabel", {
  value: Schema.String,
}).pipe(
  Schema.filter((t) => {
    if (t.value === "" && t.health.status === "ok") {
      return "empty `value` requires non-ok `health.status`"
    }
    if (t.value !== "" && !/^[a-zA-Z0-9_-]+$/.test(t.value)) {
      return `specifier label value must match [a-zA-Z0-9_-]+, got \`${t.value}\``
    }
    return true
  }),
)
export type SpecifierLabelToken = typeof SpecifierLabelTokenSchema.Type

export const SpecifierCloseTokenSchema = loomNode("SpecifierClose", {
  value: Schema.Literal("}"),
}).annotations({
  [Probe]: /\}/g,
})
export type SpecifierCloseToken = typeof SpecifierCloseTokenSchema.Type

export const SpecifierTokenSchema = loomNode("Specifier", {
  open: SpecifierOpenTokenSchema,
  label: SpecifierLabelTokenSchema,
  close: SpecifierCloseTokenSchema,
}).annotations({
  [Probe]: /\{[a-zA-Z0-9_-]+\}/g,
})
export type SpecifierToken = typeof SpecifierTokenSchema.Type

// =============================================================================
// Arrow — `=>` on a code line. Position-only.
// =============================================================================

export const ArrowTokenSchema = loomNode("Arrow", {}).annotations({
  [Probe]: /^\s*=>/,
})
export type ArrowToken = typeof ArrowTokenSchema.Type

// =============================================================================
// Tilde — `~+` on a prose line. Position-only.
// =============================================================================

export const TildeTokenSchema = loomNode("Tilde", {}).annotations({
  [Probe]: /^\s*~+/,
})
export type TildeToken = typeof TildeTokenSchema.Type

// =============================================================================
// Text — a contiguous text run between structural tokens on a heading line.
// Position-only; content is `text.slice(position.start.offset, ...end.offset)`.
// =============================================================================

export const TextTokenSchema = loomNode("Text", {}).annotations({
  [Probe]: /[^\[\]\{\}]+/g,
})
export type TextToken = typeof TextTokenSchema.Type

// =============================================================================
// Code — code content; on an Arrow line, the content after `=>`. Position-only.
// =============================================================================

export const CodeTokenSchema = loomNode("Code", {}).annotations({
  [Probe]: /(?<=^\s*=>\s*)\S.*$/,
})
export type CodeToken = typeof CodeTokenSchema.Type

// =============================================================================
// Prose — prose content; on a Tilde line, the content after `~`. Position-only.
// =============================================================================

export const ProseTokenSchema = loomNode("Prose", {}).annotations({
  [Probe]: /(?<=^\s*~+\s*)\S.*$/,
})
export type ProseToken = typeof ProseTokenSchema.Type

// =============================================================================
// LoomToken — the union of all leaf tokens. The Tokeniser's emission type.
// =============================================================================

export const LoomTokenSchema = Schema.Union(
  ChapterHeadingStartTokenSchema,
  SectionHeadingStartTokenSchema,
  TagTokenSchema,
  SpecifierTokenSchema,
  ArrowTokenSchema,
  TildeTokenSchema,
  TextTokenSchema,
  CodeTokenSchema,
  ProseTokenSchema,
)
export type LoomToken = typeof LoomTokenSchema.Type
