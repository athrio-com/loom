import { Schema } from 'effect'
import { HealthSchema, okHealth, PositionSchema } from '#ast/LoomNode'

// =============================================================================
// ProductAst (PAST) — the de re structure: built by `ProductAstBuilder`,
// flattened by `fromProduct`. Its unit is the `ComposedCode` of one section: that section's product
// code with its transclusions expressed as edges. The nodes live *per module* —
// each `LoomModule` carries a `code: Map<name, ComposedCode>` for its own sections
// — so this file owns the node types, not a corpus-wide container.
//
//   Loom AST ─FrameAstBuilder─▶ Frame AST ─ProductAstBuilder─▶ ComposedCode (per module)
//                                                       └─ fromProduct ─▶ text + mappings
//
// Shape — a corpus-spanning graph, stored distributed:
//
//   - Identity is module-qualified: `SectionId { path, name }`. Two files may both
//     define `Main`, and `loomA.S → loomB.S → loomC.S` is one walk across modules.
//   - A cross-(section|file) edge is a `Ref` holding the target *key*, resolved at
//     projection through the corpus. By key, never by pointer — so the graph is
//     Schema-serialisable and may *hold* a cycle edge for `fromProduct` to cut.
//   - Building a module's `ComposedCode` is a pure function of that module alone
//     (Fragments slice its own text; Refs are keys from its own frame + imports).
//     So it is per-module-atomic, exactly like `frame` — never reads another
//     module. Only `fromProduct` reaches across, following Refs.
//
// Because edges are keys, the *schema* is non-recursive (a `ComposedCode`'s parts
// are `Fragment | Ref` leaves) even though the *data* graph recurses — no
// `Schema.suspend`.
//
// `fromProduct` flattens one root's reachable cone to text + mappings: each `Fragment`
// emits a 1:1 `product` mapping to its `.loom` `origin`; crossing a `Ref` into
// another *file* re-pins the whole subtree onto the `anchor` in the consuming
// file; a `Ref` whose target is absent (unresolved) or already on the stack (a
// cycle) emits nothing. `health` rides the mapping back to source.
// =============================================================================

// productNode — `type` + `health` (semantic, default ok). PAST is flattened by
// graph walk (`fromProduct`), not field-order emit, so there is no `RenderOrder` annotation (cf.
// `frameNode`); the spans are named fields (`origin`, `anchor`).
const productNode = <Tag extends string, Fields extends Schema.Struct.Fields>(
  tag: Tag,
  fields: Fields,
) =>
  Schema.Struct({
    type: Schema.Literal(tag).pipe(
      Schema.propertySignature,
      Schema.withConstructorDefault(() => tag),
    ),
    health: HealthSchema.pipe(
      Schema.propertySignature,
      Schema.withConstructorDefault(() => okHealth),
    ),
    ...fields,
  })

// =============================================================================
// SectionId — a node's corpus-wide identity: which `.loom` (`path`) and which
// section within it (`name`, the Frame class name). A module keys its `code` by
// `name`; a `Ref` points at the full `{ path, name }`.
// =============================================================================

export const SectionIdSchema = Schema.Struct({
  path: Schema.String, // resolved `.loom` path — the module
  name: Schema.String, // the section's class name within that module
})
export type SectionId = typeof SectionIdSchema.Type

// keyOf — a module-qualified key for `fromProduct`'s visiting set (cycle cut), since a
// `Ref`'s target may cross modules. JSON-encoded, not separator-joined: unambiguous
// for any path/name without a control character (a raw NUL breaks highlighting).
export const keyOf = (id: SectionId): string => JSON.stringify([id.path, id.name])

// =============================================================================
// Leaves.
// =============================================================================

// Fragment — a literal product span: the unescaped code the author wrote in a
// section's code block. `origin` is its `.loom` span (in the section's own file),
// carried for the 1:1 mapping `fromProduct` emits; under a cross-file `Ref`,
// `fromProduct` re-pins past it.
export const FragmentSchema = productNode('Fragment', {
  text: Schema.String,
  origin: PositionSchema,
})
export type Fragment = typeof FragmentSchema.Type

// Ref — a transclusion edge, the de re analog of FrameAst's `CodeRef`. `target` is
// `Option<SectionId>`: `None` when the binding resolved to no section at all (an
// unresolved anchor — the type carries it, no sentinel path); `Some(id)` names the
// section to inline. `anchor` is the `{{…}}` site in the *consuming* section — the
// re-pin target for cross-file mappings and the site a resolution diagnostic lands
// on. `fromProduct` emits nothing for a `None` target, a `Some` the corpus doesn't hold,
// or a cycle.
export const RefSchema = productNode('Ref', {
  target: Schema.OptionFromSelf(SectionIdSchema),
  anchor: PositionSchema,
})
export type Ref = typeof RefSchema.Type

// =============================================================================
// ComposedCode — one section's resolved de re: its `parts` in composition order
// (a transcluded section precedes the code that uses it), each a `Fragment` (own
// product text) or a `Ref` (an edge to another section). `languageId` is the
// product language (the `{{lang}}` default or a `{specifier}`); a cross-specifier
// edge is a homogeneity diagnostic on `health`. A module holds one per section,
// keyed by name, in its `code` map.
// =============================================================================

export const PartSchema = Schema.Union(FragmentSchema, RefSchema)
export type Part = typeof PartSchema.Type

export const ComposedCodeSchema = productNode('ComposedCode', {
  origin: SectionIdSchema, // this node's own identity
  languageId: Schema.String,
  parts: Schema.Array(PartSchema),
})
export type ComposedCode = typeof ComposedCodeSchema.Type
