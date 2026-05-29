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
// HeadingStart — one token for every heading line, any level (`#`..`######`).
//
// The marker is `<hashes><space>`; the token's `position` covers the whole
// marker — both the hashes and the mandatory trailing space. Position-only,
// like Arrow / Tilde: the marker text is `text.slice(start, end)`, and the
// heading level is `(end - start - 1)` (the hash count). Level is recorded
// only for the human reader — it carries no structural meaning, since every
// heading produces a flat Section.
// =============================================================================

export const HeadingStartTokenSchema = loomNode("HeadingStart", {}).annotations({
  [Probe]: /^#{1,6} /,
})
export type HeadingStartToken = typeof HeadingStartTokenSchema.Type

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
// PathSpecifier — `{path/to/file}`. Same `{` / `}` delimiters as Specifier,
// but the label admits path separators. A heading carrying a PathSpecifier
// is a tangle (file-emission) Section. The Tokeniser scans the `{` / `}`
// delimiters once and chooses Specifier vs PathSpecifier by whether the
// label contains a path separator — so open / close reuse the Specifier
// subnode tokens; only the label pattern differs.
// =============================================================================

// PathSpecifier label — same health-aware scheme as SpecifierLabel, but the
// character class admits the `.` and `/` of a file path.
export const PathSpecifierLabelTokenSchema = loomNode("PathSpecifierLabel", {
  value: Schema.String,
}).pipe(
  Schema.filter((t) => {
    if (t.value === "" && t.health.status === "ok") {
      return "empty `value` requires non-ok `health.status`"
    }
    if (t.value !== "" && !/^[a-zA-Z0-9_\-./]+$/.test(t.value)) {
      return `path specifier label must match [a-zA-Z0-9_-./]+, got \`${t.value}\``
    }
    return true
  }),
)
export type PathSpecifierLabelToken = typeof PathSpecifierLabelTokenSchema.Type

export const PathSpecifierTokenSchema = loomNode("PathSpecifier", {
  open: SpecifierOpenTokenSchema,
  label: PathSpecifierLabelTokenSchema,
  close: SpecifierCloseTokenSchema,
}).annotations({
  [Probe]: /\{[a-zA-Z0-9_\-./]+\}/g,
})
export type PathSpecifierToken = typeof PathSpecifierTokenSchema.Type

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
// Warp — `{{name: annotation [= default]}}`, the declaration site of a
// parameter inside a Preamble line. The Synth phase reads `annotation` as
// either a Tag reference (e.g. `Mult`) or a TS type expression, and `default`
// as a TS value expression matching that type.
//
// WarpAnchor — `{{name}}`, the reference site inside an ArrowWeft or Code line.
// Names a Warp declared earlier in the same Section.
//
// Open/close/name are named subnodes so each carries its own health.
// Annotation and default are opaque value tokens; their inner structure
// belongs to Synth.
// =============================================================================

export const WarpOpenTokenSchema = loomNode("WarpOpen", {
  value: Schema.Literal("{{"),
}).annotations({
  [Probe]: /\{\{/g,
})
export type WarpOpenToken = typeof WarpOpenTokenSchema.Type

export const WarpCloseTokenSchema = loomNode("WarpClose", {
  value: Schema.Literal("}}"),
}).annotations({
  [Probe]: /\}\}/g,
})
export type WarpCloseToken = typeof WarpCloseTokenSchema.Type

// WarpName — TS identifier inside `{{…}}`. Same cross-field rule as
// TagLabel: empty value admitted only when health is non-ok; non-empty
// values must match a TS identifier pattern.
export const WarpNameTokenSchema = loomNode("WarpName", {
  value: Schema.String,
}).pipe(
  Schema.filter((t) => {
    if (t.value === "" && t.health.status === "ok") {
      return "empty `value` requires non-ok `health.status`"
    }
    if (t.value !== "" && !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(t.value)) {
      return `warp name must be a TS identifier, got \`${t.value}\``
    }
    return true
  }),
)
export type WarpNameToken = typeof WarpNameTokenSchema.Type

// WarpAnnotation — the text between the name's `:` separator and either
// `=` or the closing `}}`. Opaque to the AST stage.
export const WarpAnnotationTokenSchema = loomNode("WarpAnnotation", {
  value: Schema.String,
})
export type WarpAnnotationToken = typeof WarpAnnotationTokenSchema.Type

// WarpDefault — the text after `=`. Opaque to the AST stage.
export const WarpDefaultTokenSchema = loomNode("WarpDefault", {
  value: Schema.String,
})
export type WarpDefaultToken = typeof WarpDefaultTokenSchema.Type

// WarpAnchorName — the reference content inside `{{…}}` on an Arrow / Code
// line. Unlike WarpName (a declaration's bound identifier), an anchor may
// name a Warp binding (an identifier, `{{m}}`) OR a Section by heading name
// (a multi-word phrase, `{{Multiplier Function}}`). The pattern is
// permissive: a non-empty value with no braces and no colon — a colon would
// make it a declaration, braces a delimiter. Which kind of reference it is
// (binding vs heading name) is resolved downstream, not at the AST stage.
export const WarpAnchorNameTokenSchema = loomNode("WarpAnchorName", {
  value: Schema.String,
}).pipe(
  Schema.filter((t) => {
    if (t.value === "" && t.health.status === "ok") {
      return "empty `value` requires non-ok `health.status`"
    }
    if (t.value !== "" && /[{}:]/.test(t.value)) {
      return `warp anchor name must not contain { } or :, got \`${t.value}\``
    }
    return true
  }),
)
export type WarpAnchorNameToken = typeof WarpAnchorNameTokenSchema.Type

export const WarpAnchorTokenSchema = loomNode("WarpAnchor", {
  open: WarpOpenTokenSchema,
  name: WarpAnchorNameTokenSchema,
  close: WarpCloseTokenSchema,
}).annotations({
  [Probe]: /\{\{[^{}:]+\}\}/g,
})
export type WarpAnchorToken = typeof WarpAnchorTokenSchema.Type

export const WarpTokenSchema = loomNode("Warp", {
  open: WarpOpenTokenSchema,
  name: WarpNameTokenSchema,
  annotation: WarpAnnotationTokenSchema,
  default: Schema.optional(WarpDefaultTokenSchema),
  close: WarpCloseTokenSchema,
}).annotations({
  [Probe]: /\{\{[^{}]*:[^{}]*\}\}/g,
})
export type WarpToken = typeof WarpTokenSchema.Type

// =============================================================================
// LoomToken — the union of all leaf tokens. The Tokeniser's emission type.
// =============================================================================

export const LoomTokenSchema = Schema.Union(
  HeadingStartTokenSchema,
  TagTokenSchema,
  SpecifierTokenSchema,
  PathSpecifierTokenSchema,
  ArrowTokenSchema,
  TildeTokenSchema,
  TextTokenSchema,
  CodeTokenSchema,
  ProseTokenSchema,
  WarpTokenSchema,
  WarpAnchorTokenSchema,
)
export type LoomToken = typeof LoomTokenSchema.Type
