import { Array, Effect, pipe } from 'effect'
import type {
  Binding,
  CodeRef,
  Compose,
  EmbeddedCode,
  FrameModule,
  ServiceBody,
  ServiceClass,
} from '#projectors/FrameAst'
import type { Mapping } from '#projectors/Synthesiser'

// =============================================================================
// resolve — FrameModule → de re product compositions (the de re projection).
//
// The dual of `synthesise`. Where synthesise renders the de dicto frame as one
// TypeScript document, the Resolver renders the de re *product*: one document
// per content Service / tangle sink, in the section's own language, with its
// `{{…}}` transclusions inlined. Each `Compose` argument renders independently —
// an `EmbeddedCode` to its raw product text (sliced from the `.loom` by
// `position`, unescaped), a `CodeRef` to the resolved composition of the section
// it references — and the arguments fold together in composition order. This is
// where cross-section references resolve: `square`'s document carries `mul`'s
// code inlined ahead of the line that calls it.
//
// `FrameCode` (`{Loom}`) members are de dicto — skipped; only product Services
// project to de re documents. Cycles are guarded (a section never inlines an
// ancestor). Mappings are 1:1 (no escaping), each pointing at the `.loom` span a
// fragment came from — *including* a transcluded section's own spans, so a
// product diagnostic or hover lands in the section that actually wrote the code.
// =============================================================================

export interface Resolved {
  readonly id: string // the section's class name
  readonly languageId: string // the product language
  readonly code: string // the resolved composition, transclusions inlined
  readonly mappings: ReadonlyArray<Mapping>
}

interface Rendered {
  readonly code: string
  readonly mappings: ReadonlyArray<Mapping>
}

const empty: Rendered = { code: '', mappings: [] }

// A body's Warp/anchor bindings (StaticBody has none) as a local-name → tag map,
// for resolving a `CodeRef`'s local name (`m`, `_Mul`) to the Section it names.
const bindingsOf = (body: ServiceBody): ReadonlyArray<Binding> =>
  body.type === 'StaticBody'
    ? []
    : Array.map(body.bindings, (item) => item.value)

const tagsOf = (body: ServiceBody): ReadonlyMap<string, string> =>
  new Map(Array.map(bindingsOf(body), (b) => [b.name.text, b.tag.text] as const))

// A `Compose`'s arguments in composition order — the optional head, then the tail.
const argsOf = (compose: Compose): ReadonlyArray<EmbeddedCode | CodeRef> => {
  const tail = Array.map(compose.tail, (item) => item.value)
  return compose.head === undefined ? tail : [compose.head, ...tail]
}

// append — concatenate two documents, shifting the second's mappings past the
// code that now precedes them. `Rendered` is a monoid under `append` / `empty`,
// so a `Compose` resolves by mapping each argument then folding.
const append = (left: Rendered, right: Rendered): Rendered => ({
  code: left.code + right.code,
  mappings: [
    ...left.mappings,
    ...Array.map(right.mappings, (m) => ({
      ...m,
      genStart: m.genStart + left.code.length,
    })),
  ],
})

// renderArg — one `Compose` argument as a self-contained document, its mappings
// relative to the fragment's own start. `EmbeddedCode` → its raw (unescaped)
// `.loom` text and a 1:1 `product` mapping; a `CodeRef` → the referenced
// section's resolved composition, or `empty` when unresolved or a cycle.
const renderArg =
  (
    source: string,
    sections: ReadonlyMap<string, ServiceClass>,
    tags: ReadonlyMap<string, string>,
    visiting: ReadonlySet<string>,
  ) =>
  (arg: EmbeddedCode | CodeRef): Rendered => {
    if (arg.type === 'EmbeddedCode') {
      const raw = source.slice(
        arg.position.start.offset,
        arg.position.end.offset,
      )
      return {
        code: raw,
        mappings: [
          {
            genStart: 0,
            genLength: raw.length,
            source: arg.position,
            kind: 'product',
          },
        ],
      }
    }
    const target = sections.get(tags.get(arg.binding.text) ?? '')
    return target === undefined || visiting.has(target.name.text)
      ? empty // unresolved or a cycle — emit nothing (a diagnostic, later)
      : resolveBody(
          target.body,
          source,
          sections,
          new Set([...visiting, target.name.text]),
        )
  }

// resolveBody — render a Service body's `Compose`: each argument independently,
// then folded together in composition order.
const resolveBody = (
  body: ServiceBody,
  source: string,
  sections: ReadonlyMap<string, ServiceClass>,
  visiting: ReadonlySet<string>,
): Rendered =>
  pipe(
    argsOf(body.code),
    Array.map(renderArg(source, sections, tagsOf(body), visiting)),
    Array.reduce(empty, append),
  )

// resolve — every product Service projects to a de re document. The source text
// is needed to slice raw (unescaped) `EmbeddedCode` fragments by `position`.
export const resolve = (
  frame: FrameModule,
  source: string,
): ReadonlyArray<Resolved> => {
  const services = pipe(
    frame.members,
    Array.map((m) => m.value),
    Array.filter((v): v is ServiceClass => v.type === 'ServiceClass'),
  )
  const sections = new Map(
    Array.map(services, (s) => [s.name.text, s] as const),
  )
  return Array.map(services, (s) => {
    const rendered = resolveBody(s.body, source, sections, new Set([s.name.text]))
    return {
      id: s.name.text,
      languageId: s.languageId,
      code: rendered.code,
      mappings: rendered.mappings,
    }
  })
}

// Resolver — the de re projection as an Effect.Service.
export class Resolver extends Effect.Service<Resolver>()('Resolver', {
  succeed: {
    run: (frame: FrameModule, source: string) =>
      Effect.sync(() => resolve(frame, source)),
  },
}) {}
