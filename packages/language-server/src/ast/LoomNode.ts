import { Schema } from "effect"

// =============================================================================
// LoomNode — the foundation layer shared by Tokens (leaf nodes) and
// containers (Heading, Section, Chapter, …).
//
// Every node in the Loom AST — top-level container or atomic leaf — flows
// through `loomNode(tag, fields)` and so carries the same three fields:
//
//   type:     a literal discriminator
//   position: source span
//   health:   diagnostics attached to this node
//
// The walker recognises a node by the presence of `type` and recurses into
// any field whose value has one.
//
// This module owns:
//   - Point / Position            — source-position primitives
//   - Severity / Diagnostic       — diagnostic payload
//   - HealthStatus / Health       — node-level health field
//   - okHealth                    — canonical "no problems" value
//   - loomNode                    — the schema combinator
// =============================================================================

// =============================================================================
// Position — start/end byte offsets into source text.
//
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

// "incomplete" marks a node still under construction by an earlier pipeline
// stage — required fields are knowingly absent and a later stage is expected
// to fill them. It is NOK in the same sense as "error"/"warning": the node
// is not yet a finished claim. A consumer reading an "incomplete" node should
// not trust missing fields; a consumer reading "ok" / "error" / "warning"
// should treat the node as structurally final.
export const HealthStatusSchema = Schema.Literal("ok", "error", "warning", "incomplete")
export type HealthStatus = typeof HealthStatusSchema.Type

export const HealthSchema = Schema.Struct({
  status: HealthStatusSchema,
  diagnostics: Schema.Array(DiagnosticSchema),
})
export type Health = typeof HealthSchema.Type

// The canonical "no problems" health value — `status: "ok"` with no
// diagnostics. Shared singleton for nodes with nothing to report.
export const okHealth: Health = { status: "ok", diagnostics: [] }

// The canonical "Classifier-Stage partial" health value — required fields
// not yet filled, no diagnostics raised. The Tokeniser fills the subnodes
// from source and flips the status to `ok` (or `error` if validation
// surfaces a problem).
export const incompleteHealth: Health = { status: "incomplete", diagnostics: [] }

// =============================================================================
// UnexpectedToken — positional marker for structural anomalies (orphan
// brackets, extra tags, stray punctuation) captured at the node where they
// were encountered. No `health` field: the token's presence in a node's
// `unexpected` array IS the anomaly, and the parent node's health status
// is what reflects it.
// =============================================================================

export const UnexpectedTokenSchema = Schema.Struct({
  type: Schema.Literal("UnexpectedToken").pipe(
    Schema.propertySignature,
    Schema.withConstructorDefault(() => "UnexpectedToken" as const),
  ),
  position: PositionSchema,
  value: Schema.String,
})
export type UnexpectedToken = typeof UnexpectedTokenSchema.Type

// =============================================================================
// loomNode() — the AST schema combinator.
//
// Produces a Schema.Struct with `type`/`position`/`source`/`health`/
// `unexpected?` plus the caller's fields. Used uniformly by container
// schemas (LoomHeading, LoomSection, …) and leaf token schemas (TagToken,
// ArrowToken, …).
//
// `source` is the original byte slice the node covers — `text.slice(
// position.start.offset, position.end.offset)` at construction time —
// stored once per node so downstream consumers (Frame projection, LSP
// hovers, snapshot dumps) read text directly without threading the
// source string. Slices overlap across nesting layers (a Weft's source
// contains its tokens' sources, a TagToken contains its TagLabel's),
// which is the natural cost of self-contained nodes. V8 typically
// materialises substring views as slot + offsets over the parent
// string, so the practical overhead is much closer to one slot per
// node than to duplicated bytes.
//
// `unexpected` is `Schema.optional` — the absence of unexpected tokens is
// the common case, so it is omittable both from `Schema.make` calls and
// from typed object literals.
// =============================================================================

export const loomNode = <
  Tag extends string,
  Fields extends Schema.Struct.Fields,
>(tag: Tag, fields: Fields) => Schema.Struct({
  type: Schema.Literal(tag).pipe(
    Schema.propertySignature,
    Schema.withConstructorDefault(() => tag),
  ),
  position: PositionSchema,
  source: Schema.String,
  health: HealthSchema,
  unexpected: Schema.optional(Schema.Array(UnexpectedTokenSchema)),
  ...fields,
})
