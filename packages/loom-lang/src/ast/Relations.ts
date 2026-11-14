import { createHash } from 'node:crypto'
import { Array, Match, Option, Order, pipe, Schema } from 'effect'
import type { Diagnostic, Position } from '@athrio/loom-ast/LoomNode'
import type { LoomSection } from '@athrio/loom-ast/LoomAst'
import {
  type Catalogue,
  type Location,
  type LoomModule,
  resolveAnchor,
  resolveName,
  sectionLinksOf,
  type SectionRef,
} from '@athrio/loom-ast/LoomCorpusAst'
import { DriftedReference, faulty } from '#ast/LoomFault'
import { sectionNameOf } from '#ast/ProductBuilder'

export const RelationSchema = Schema.Struct({
  loom: Schema.String,
  section: Schema.String,
  kind: Schema.String,
  to: Schema.String,
  fingerprint: Schema.String,
})
export type Relation = typeof RelationSchema.Type

export type Reference = {
  readonly kind: string
  readonly section: string
  readonly to: string
  readonly at: Position
  readonly target: SectionRef
}

type Found = Omit<Reference, 'kind'>

export type RelationKind = {
  readonly name: string
  readonly referencesIn: (catalogue: Catalogue, module: LoomModule) => ReadonlyArray<Found>
}

const inAnotherLoom =
  (module: LoomModule) =>
  (target: SectionRef): boolean =>
    target.module !== module.path

type Edge = {
  readonly name: string
  readonly target: Option.Option<unknown>
  readonly anchor: Position
}

const openEdge =
  (catalogue: Catalogue, module: LoomModule, section: string) =>
  (edge: Edge): ReadonlyArray<Found> =>
    Option.isSome(edge.target)
      ? []
      : pipe(
          resolveName(catalogue, module.path, edge.name),
          Option.filter(inAnotherLoom(module)),
          Option.map((target): Found => ({ section, to: edge.name, at: edge.anchor, target })),
          Option.toArray,
        )

const anchorsIn = (catalogue: Catalogue, module: LoomModule): ReadonlyArray<Found> =>
  Array.flatMap(module.product.code, (host) =>
    Array.flatMap(host.fragments, (part) =>
      Match.value(part).pipe(
        Match.when({ type: 'NameRef' }, openEdge(catalogue, module, host.origin.name)),
        Match.when({ type: 'ModuleRef' }, openEdge(catalogue, module, host.origin.name)),
        Match.when({ type: 'Fragment' }, (): ReadonlyArray<Found> => []),
        Match.exhaustive,
      ),
    ),
  )

const linksIn = (catalogue: Catalogue, module: LoomModule): ReadonlyArray<Found> =>
  Array.flatMap(module.doc.sections, (section) =>
    Array.flatMap(sectionLinksOf(section), (link) =>
      pipe(
        resolveAnchor(catalogue, module.path, link),
        Option.filter(inAnotherLoom(module)),
        Option.map(
          (target): Found => ({
            section: sectionNameOf(section),
            to: link.name.value,
            at: link.name.position,
            target,
          }),
        ),
        Option.toArray,
      ),
    ),
  )

export const relationKinds: ReadonlyArray<RelationKind> = [
  { name: 'anchor', referencesIn: anchorsIn },
  { name: 'link', referencesIn: linksIn },
]

export const referencesOf = (
  catalogue: Catalogue,
  module: LoomModule,
): ReadonlyArray<Reference> =>
  Array.flatMap(relationKinds, (kind) =>
    Array.map(kind.referencesIn(catalogue, module), (found) => ({ ...found, kind: kind.name })),
  )

const settled = (text: string): string =>
  pipe(
    text.split('\n'),
    Array.map((line) => line.trimEnd()),
    Array.filter((line) => line !== ''),
    Array.join('\n'),
  )

export const fingerprintOf = (section: LoomSection): string =>
  createHash('sha256').update(settled(section.source)).digest('hex')

const keyOf = (loom: Location, held: Pick<Relation, 'section' | 'kind' | 'to'>): string =>
  JSON.stringify([loom, held.section, held.kind, held.to])

export const driftFaults = (
  catalogue: Catalogue,
  module: LoomModule,
  kept: ReadonlyArray<Relation>,
): ReadonlyArray<Diagnostic> => {
  const approved = new Map(
    Array.map(kept, (relation) => [keyOf(relation.loom, relation), relation.fingerprint] as const),
  )
  return Array.flatMap(referencesOf(catalogue, module), (reference) =>
    pipe(
      Option.fromNullishOr(approved.get(keyOf(module.path, reference))),
      Option.filter((fingerprint) => fingerprint !== fingerprintOf(reference.target.section)),
      Option.match({
        onNone: (): ReadonlyArray<Diagnostic> => [],
        onSome: () => faulty(DriftedReference({ name: reference.to }), reference.at).diagnostics,
      }),
    ),
  )
}

const byNames: Order.Order<Relation> = Order.mapInput(Order.String, (relation: Relation) =>
  keyOf(relation.loom, relation),
)

export const approvedRelations = (
  catalogue: Catalogue,
  module: LoomModule,
  kept: ReadonlyArray<Relation>,
): ReadonlyArray<Relation> =>
  pipe(
    [
      ...Array.filter(kept, (relation) => relation.loom !== module.path),
      ...Array.dedupeWith(
        Array.map(
          referencesOf(catalogue, module),
          (reference): Relation => ({
            loom: module.path,
            section: reference.section,
            kind: reference.kind,
            to: reference.to,
            fingerprint: fingerprintOf(reference.target.section),
          }),
        ),
        (one: Relation, other: Relation) => keyOf(one.loom, one) === keyOf(other.loom, other),
      ),
    ],
    Array.sort(byNames),
  )
