import { Schema } from 'effect'
import { PositionSchema } from '#ast/LoomNode'

// =============================================================================
// LoomVirtualCode — the terminal model of the pipeline: the projection a `.loom`
// presents to Volar. It is not an AST (no source tree), but it is the same
// `Model + Builder` pair the spine uses everywhere — built by
// `LoomVirtualCodeBuilder`'s two passes (`fromFrame`, the de dicto frame;
// `fromProduct`, a de re product), assembled into one tree per file:
//
//   root (loom)
//   ├── frame      (typescript)   ← fromFrame: the generated composition frame
//   └── <section>  (per language) ← fromProduct: one product document per section
//
// It mirrors Volar's own `VirtualCode` shape — an `id`, a `languageId`, and a
// recursive `embeddedCodes` tree — but stays plain data: it holds `code` (a
// string) rather than Volar's function-based `IScriptSnapshot`, and our `Mapping`
// rather than Volar's `CodeMapping`. Neither of those is serialisable data, so the
// `LoomCompiler.toVolar` adapter derives them at the editor boundary (the
// only place we touch Volar's types) — the snapshot from `code`, the `CodeMapping`
// from each `Mapping`. So the whole pipeline stays model-to-model, and Volar's
// runtime concerns live at one edge.
// =============================================================================

// MappingKind — which language-service features Volar forwards at a mapped span.
// A de dicto frame span is `name` (an identifier) or `prose` (titles, preambles);
// a de re span is `product` (the author's code, in its own language).
export const MappingKindSchema = Schema.Literal('name', 'prose', 'product')
export type MappingKind = typeof MappingKindSchema.Type

// Mapping — a generated span (`genStart`, `genLength`, offsets into this virtual
// code's `code`) paired with the `.loom` `source` span it projects from. `kind`
// chooses the forwarded features. The unit a pass folds; `toVolar` turns each into
// a Volar `CodeMapping`.
export const MappingSchema = Schema.Struct({
  genStart: Schema.Number,
  genLength: Schema.Number,
  source: PositionSchema,
  kind: Schema.optional(MappingKindSchema),
})
export type Mapping = typeof MappingSchema.Type

// LoomVirtualCode — one node of the projected tree. The interface is declared
// first so the schema can recurse through `embeddedCodes` (Effect needs the type
// to break the cycle in `Schema.suspend`).
export interface LoomVirtualCode {
  readonly id: string
  readonly languageId: string
  readonly code: string
  readonly mappings: ReadonlyArray<Mapping>
  readonly embeddedCodes: ReadonlyArray<LoomVirtualCode>
}

export const LoomVirtualCodeSchema: Schema.Schema<LoomVirtualCode> =
  Schema.Struct({
    id: Schema.String,
    languageId: Schema.String,
    code: Schema.String,
    mappings: Schema.Array(MappingSchema),
    embeddedCodes: Schema.Array(
      Schema.suspend(() => LoomVirtualCodeSchema),
    ),
  })
