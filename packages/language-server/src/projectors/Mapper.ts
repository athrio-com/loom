import type { Position } from '#ast/LoomNode'

// =============================================================================
// Mapper — mapping-aware text composition for the Loom Frame projector.
//
// What this module does, in one sentence: it lets a synth pass build
// the generated Frame code and a list of source-to-generated
// mappings in a single pass, by replacing raw `string` composition
// with a small algebra over a `Mapped` envelope.
//
// Why. Loom's LSP integration projects a `.loom` document to an
// internal TypeScript Frame and routes the TS language service's
// answers — diagnostics, hover, completion, go-to-def — back to the
// `.loom` positions the user is actually looking at. The routing
// table is the set of mappings between input AST positions and the
// offsets where the corresponding code lands in the projected Frame.
// Building those mappings during the synth pass means we never
// re-walk the AST to recover them and never let them drift from the
// code they describe.
//
// Shape. Every value the synth composes is a `Mapped`: a `genCode`
// string (the projected Frame text built so far) plus an array of
// `Mapping` records, each one tying a span of that code to its
// `sourcePosition` in the input AST. Field names are directional
// throughout: `gen*` for the generated side, `source*` for the
// input side. The composition algebra is small — three atoms
// (`empty`, `literal`, `sourced`), three combinators (`concat`,
// `concatAll`, `join`), and one tagged template helper (`m`) that
// subsumes `${…}` substitution in template literals. Synth code
// reads almost as it does today; the only difference is that leaf
// reads of `node.source` become `sourced(node)`, and template
// literals are wrapped in `m\`…\``.
//
// Coupling. Atoms and combinators speak only in `Mapped`. Synth
// functions return `Mapped` by default. Callers that need only the
// generated code (printing, debug, snapshot tests) read `.genCode`;
// callers that need provenance (the Volar adapter) read `.mappings`.
// There is no second projection pass; mappings ride along.
//
// Volar's `Mapping<CodeInformation>` format and Sourcemap v3 are
// boundary concerns — `Mapped` is the destination-neutral internal
// shape, translated to whichever consumer needs it at the edge.
// =============================================================================

// =============================================================================
// Types — `Mapping`, `Mapped`, and the per-mapping `MappingKind`.
//
// `Mapping.sourcePosition` is the full AST `Position` (line + offset)
// of the span the mapping ties to, preserved end-to-end so the
// boundary adapter never has to re-derive line numbers. `genStart`
// and `genLength` describe the corresponding range in the generated
// code — local to the enclosing `Mapped`'s own `genCode` string,
// not a global file offset, so each `Mapped` is self-contained and
// `concat` only has to shift offsets by the predecessor's
// `genCode.length`.
//
// `MappingKind` is a coarse classifier the boundary adapter
// translates into Volar's per-mapping `CodeInformation`: `code` for
// spans that should forward the full TS language service (the body
// of a `=>` block), `identifier` for narrower navigation+hover
// (tag labels, Warp names), `prose` for spans the LSP should ignore
// (preamble prose). Phase one can leave everything as `code`; the
// field exists so finer scoping is a decoration choice, not a
// restructure.
// =============================================================================

export type MappingKind = 'code' | 'identifier' | 'prose'

export interface Mapping {
  readonly sourcePosition: Position
  readonly genStart: number
  readonly genLength: number
  readonly kind: MappingKind
}

export interface Mapped {
  readonly genCode: string
  readonly mappings: ReadonlyArray<Mapping>
}

// =============================================================================
// Atoms — `empty`, `literal`, `sourced`.
//
// The three ways to create a `Mapped` from primitive inputs.
//
// `empty` is the identity for `concat` — `genCode: ""` with no
// mappings. `literal(s)` is engine glue: code that has no `.loom`
// origin and should stay invisible to the LSP. `sourced(node, kind?)`
// carries `node.source` as the `genCode` and records one mapping
// back to the node's `position`; the optional `kind` defaults to
// `"code"` so the common case stays terse.
//
// Every leaf in the synth — every place we currently read
// `node.source` — becomes a `sourced(node)` call. Every literal in a
// template body becomes a `literal(s)` (or rides inside the static
// parts of `m\`…\``, which lifts them automatically).
// =============================================================================

export const empty: Mapped = { genCode: '', mappings: [] }

export const literal = (s: string): Mapped => ({ genCode: s, mappings: [] })

export const sourced = (
  node: { readonly source: string; readonly position: Position },
  kind: MappingKind = 'code',
): Mapped => ({
  genCode: node.source,
  mappings: [
    {
      sourcePosition: node.position,
      genStart: 0,
      genLength: node.source.length,
      kind,
    },
  ],
})

// =============================================================================
// Combinators — `concat`, `concatAll`, `join`.
//
// `concat(a, b)` appends `b.genCode` to `a.genCode` and re-bases
// `b`'s mappings by `a.genCode.length`. That single offset shift is
// the reason mappings stay local to each `Mapped`: a binary concat
// is O(|a.mappings| + |b.mappings|) and never needs global
// knowledge.
//
// `concatAll(items)` is left-folded `concat` over a list, used by
// the tagged template helper and convenient when fanning out over
// many children. `join(items, sep)` interleaves a literal separator
// between elements — the separator carries no mapping, since it is
// engine glue. Both reduce to repeated `concat`s; correctness lives
// in `concat` alone.
// =============================================================================

export const concat = (a: Mapped, b: Mapped): Mapped => ({
  genCode: a.genCode + b.genCode,
  mappings: [
    ...a.mappings,
    ...b.mappings.map((mp) => ({
      ...mp,
      genStart: mp.genStart + a.genCode.length,
    })),
  ],
})

export const concatAll = (items: ReadonlyArray<Mapped>): Mapped =>
  items.reduce(concat, empty)

export const join = (items: ReadonlyArray<Mapped>, sep: string): Mapped => {
  if (items.length === 0) return empty
  const [first, ...rest] = items
  return rest.reduce(
    (acc, item) => concat(concat(acc, literal(sep)), item),
    first,
  )
}

// =============================================================================
// Tagged template — `m\`…${slot}…\``.
//
// The point of contact with the synth's existing style. Frame.ts
// composes via template literals (`\`export class ${name}…\``); the
// tagged template `m` preserves that shape while making the result
// mapping-aware.
//
// At runtime, `m` walks the `parts` (the static fragments TS hands
// it) and `slots` (the values that filled the `${…}` holes) in
// lock-step. Each `parts[i]` becomes a `literal`; each `slots[i]` is
// either already `Mapped` (carrying its own mappings, shifted by the
// surrounding code) or a raw `string` lifted into `literal`. The
// result is a single `Mapped` whose `genCode` equals what the bare
// template literal would have produced, plus the union of every
// slot's mappings at their correct genStart offsets.
// =============================================================================

const toMapped = (x: Mapped | string): Mapped =>
  typeof x === 'string' ? literal(x) : x

export const m = (
  parts: TemplateStringsArray,
  ...slots: ReadonlyArray<Mapped | string>
): Mapped =>
  concatAll(
    parts.flatMap(
      (part, i): ReadonlyArray<Mapped> =>
        i < slots.length
          ? [literal(part), toMapped(slots[i])]
          : [literal(part)],
    ),
  )
