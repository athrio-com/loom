import { Effect, Option, Schema } from 'effect'
import type { Position } from '#ast/LoomNode'
import * as FrameAst from '#projectors/FrameAst'
import {
  type FrameModule,
  renderOrderOf,
  type SpanKind,
} from '#projectors/FrameAst'

// =============================================================================
// synthesise — FrameModule → { genCode, mappings } (the render arrow).
//
// Each node renders by mapping its fields — visited in the node's explicit
// `RenderOrder` — to self-contained chunks, then folding them with the `Rendered`
// monoid (`append`), which concatenates code and shifts each chunk's mappings
// into place. A `text` field is emitted, recorded as a mapping back to its
// `.loom` span iff the node is authored (carries a `position`); synth glue has no
// position, so it emits without a mapping (`kind` selects which features the
// language service forwards). The walk introduces no text of its own — the
// schema owns every byte.
// =============================================================================

// A generated span paired with the `.loom` it maps to. `source` is the source
// *side* of the mapping (Volar's term) — it carries the authored node's
// `position`; a node's own location field is named `position`, not `source`.
// The kind of a mapped span: a frame `name` / `prose` (Synthesiser), or de
// re `product` code (Resolver). Drives which features Volar forwards there.
export type MappingKind = SpanKind | 'product'

export interface Mapping {
  readonly genStart: number
  readonly genLength: number
  readonly source: Position
  readonly kind?: MappingKind
}

export interface Rendered {
  readonly genCode: string
  readonly mappings: ReadonlyArray<Mapping>
}

// The `type` literal of a frameNode schema — the key for its render order.
const typeTagOf = (
  schema: Schema.Schema<any, any, never>,
): string | undefined => {
  const ast = schema.ast as any
  if (ast?._tag !== 'TypeLiteral') return undefined
  const sig = ast.propertySignatures?.find((p: any) => p.name === 'type')
  const literal = sig?.type
  return literal?._tag === 'Literal' ? String(literal.literal) : undefined
}

// tag → render order, derived once from the FrameAst node schemas.
const orderByType: ReadonlyMap<string, ReadonlyArray<string>> = new Map(
  (Object.values(FrameAst) as ReadonlyArray<unknown>).flatMap((v) => {
    if (
      v == null ||
      (typeof v !== 'object' && typeof v !== 'function') ||
      !('ast' in v)
    ) {
      return []
    }
    const schema = v as Schema.Schema<any, any, never>
    const order = renderOrderOf(schema)
    const tag = typeTagOf(schema)
    return Option.isSome(order) && tag !== undefined
      ? [[tag, order.value] as const]
      : []
  }),
)

const empty: Rendered = { genCode: '', mappings: [] }

// append — concatenate two rendered chunks, shifting the second's mappings past
// the first's code. `Rendered` is a monoid under `append` / `empty`, so a node
// renders by mapping its fields then folding them.
const append = (left: Rendered, right: Rendered): Rendered => ({
  genCode: left.genCode + right.genCode,
  mappings: [
    ...left.mappings,
    ...right.mappings.map((m) => ({
      ...m,
      genStart: m.genStart + left.genCode.length,
    })),
  ],
})

// renderField — one field of a node, rendered to a self-contained chunk with its
// mappings from offset 0. A string is emitted, mapped iff the node is authored
// (carries a `position`); an array renders each element; an absent optional is
// empty; a sub-node recurses.
const renderField = (parent: any, field: any): Rendered => {
  if (typeof field === 'string') {
    return {
      genCode: field,
      mappings:
        parent.position !== undefined
          ? [
              {
                genStart: 0,
                genLength: field.length,
                source: parent.position as Position,
                kind: parent.kind as SpanKind | undefined,
              },
            ]
          : [],
    }
  }
  if (Array.isArray(field)) return field.map(renderNode).reduce(append, empty)
  if (field == null) return empty // optional field absent
  return renderNode(field) // sub-node
}

// renderNode — render a node by mapping its fields (in RenderOrder), then folding.
const renderNode = (node: any): Rendered =>
  (orderByType.get(node.type) ?? [])
    .map((name) => renderField(node, node[name]))
    .reduce(append, empty)

export const synthesise = (frame: FrameModule): Rendered => renderNode(frame)

// Synthesiser — the render arrow as an Effect.Service.
export class Synthesiser extends Effect.Service<Synthesiser>()('Synthesiser', {
  succeed: {
    run: (frame: FrameModule) => Effect.sync(() => synthesise(frame)),
  },
}) {}
