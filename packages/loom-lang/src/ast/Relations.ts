import { createHash } from 'node:crypto'
import { Array, Match, Option, Order, pipe, Record, Schema } from 'effect'
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

export const KeptRelationSchema = Schema.Struct({
  loom: Schema.String,
  section: Schema.String,
  kind: Schema.String,
  to: Schema.String,
  fingerprint: Schema.String,
})
export type KeptRelation = typeof KeptRelationSchema.Type

export type RelationStatus = 'untracked' | 'inStep' | 'drifted'

export type Relation = {
  readonly loom: Location
  readonly section: string
  readonly kind: string
  readonly to: string
  readonly at: Position
  readonly target: SectionRef
  readonly status: RelationStatus
}

type Found = Pick<Relation, 'section' | 'to' | 'at' | 'target'>

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

const settled = (text: string): string =>
  pipe(
    text.split('\n'),
    Array.map((line) => line.trimEnd()),
    Array.filter((line) => line !== ''),
    Array.join('\n'),
  )

export const fingerprintOf = (section: LoomSection): string =>
  createHash('sha256').update(settled(section.source)).digest('hex')

type Named = Pick<Relation, 'loom' | 'section' | 'kind' | 'to'>

const keyOf = (named: Named): string =>
  JSON.stringify([named.loom, named.section, named.kind, named.to])

const statusOf = (kept: Option.Option<string>, section: LoomSection): RelationStatus =>
  Option.match(kept, {
    onNone: () => 'untracked',
    onSome: (fingerprint) => (fingerprint === fingerprintOf(section) ? 'inStep' : 'drifted'),
  })

export const relationsOf = (
  catalogue: Catalogue,
  module: LoomModule,
  kept: ReadonlyArray<KeptRelation>,
): ReadonlyArray<Relation> => {
  const fingerprints = new Map(
    Array.map(kept, (held) => [keyOf(held), held.fingerprint] as const),
  )
  return Array.flatMap(relationKinds, (kind) =>
    Array.map(kind.referencesIn(catalogue, module), (found): Relation => {
      const named: Named = {
        loom: module.path,
        section: found.section,
        kind: kind.name,
        to: found.to,
      }
      return {
        ...named,
        at: found.at,
        target: found.target,
        status: statusOf(
          Option.fromNullishOr(fingerprints.get(keyOf(named))),
          found.target.section,
        ),
      }
    }),
  )
}

export const driftFaults = (
  catalogue: Catalogue,
  module: LoomModule,
  kept: ReadonlyArray<KeptRelation>,
): ReadonlyArray<Diagnostic> =>
  pipe(
    relationsOf(catalogue, module, kept),
    Array.filter((relation) => relation.status === 'drifted'),
    Array.flatMap(
      (relation) => faulty(DriftedReference({ name: relation.to }), relation.at).diagnostics,
    ),
  )

export type Drift = {
  readonly loom: Location
  readonly section: string
  readonly relations: ReadonlyArray<Relation>
}

const changedSection = (relation: Relation): string =>
  JSON.stringify([relation.target.module, sectionNameOf(relation.target.section)])

const titleOf = (section: LoomSection): string =>
  section.heading.title?.source ?? sectionNameOf(section)

export const driftsIn = (relations: ReadonlyArray<Relation>): ReadonlyArray<Drift> =>
  pipe(
    Array.filter(relations, (relation) => relation.status === 'drifted'),
    Array.groupBy(changedSection),
    Record.values,
    Array.map((drifted): Drift => {
      const { target } = Array.headNonEmpty(drifted)
      return { loom: target.module, section: titleOf(target.section), relations: drifted }
    }),
  )

const byNames: Order.Order<KeptRelation> = Order.mapInput(Order.String, keyOf)

const sameNames = (one: Named, other: Named): boolean => keyOf(one) === keyOf(other)

const keptOf = (relation: Relation): KeptRelation => ({
  loom: relation.loom,
  section: relation.section,
  kind: relation.kind,
  to: relation.to,
  fingerprint: fingerprintOf(relation.target.section),
})

export const chosenRelations = (
  catalogue: Catalogue,
  module: LoomModule,
  kept: ReadonlyArray<KeptRelation>,
  chosen: (relation: Relation) => boolean,
): ReadonlyArray<KeptRelation> =>
  pipe(
    Array.filter(relationsOf(catalogue, module, kept), chosen),
    Array.map(keptOf),
    Array.dedupeWith(sameNames),
  )

export const approvedRelations = (
  catalogue: Catalogue,
  module: LoomModule,
  kept: ReadonlyArray<KeptRelation>,
  chosen: (relation: Relation) => boolean,
): ReadonlyArray<KeptRelation> => {
  const fresh = chosenRelations(catalogue, module, kept, chosen)
  const present = new Set(Array.map(relationsOf(catalogue, module, kept), keyOf))
  const stands = (held: KeptRelation): boolean =>
    held.loom !== module.path ||
    (present.has(keyOf(held)) && !Array.some(fresh, (approved) => sameNames(approved, held)))
  return pipe([...Array.filter(kept, stands), ...fresh], Array.sort(byNames))
}

export type Approval = {
  readonly relation: Relation
  readonly keeps: ReadonlyArray<KeptRelation>
}

const meets = (at: Position, start: number, end: number): boolean =>
  at.start.offset <= end && start <= at.end.offset

export const approvalsAt = (
  catalogue: Catalogue,
  module: LoomModule,
  kept: ReadonlyArray<KeptRelation>,
  start: number,
  end: number,
): ReadonlyArray<Approval> =>
  pipe(
    relationsOf(catalogue, module, kept),
    Array.filter((relation) => relation.status !== 'inStep' && meets(relation.at, start, end)),
    Array.map((relation) => ({
      relation,
      keeps: approvedRelations(catalogue, module, kept, (other) => sameNames(other, relation)),
    })),
  )
