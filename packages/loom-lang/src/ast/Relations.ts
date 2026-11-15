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

const said = (section: LoomSection): string =>
  Array.join(
    Array.map([...section.preamble, ...section.code], (weft) => weft.source),
    '',
  )

export const fingerprintOf = (section: LoomSection): string =>
  createHash('sha256').update(settled(said(section))).digest('hex')

type Named = Pick<Relation, 'loom' | 'section' | 'kind' | 'to'>

type Seen = Named & Pick<Relation, 'at' | 'target'> & { readonly now: string }

type Tracked = { readonly seen: Seen; readonly kept: Option.Option<KeptRelation> }

const keyOf = (named: Named): string =>
  JSON.stringify([named.loom, named.section, named.kind, named.to])

const seenIn = (catalogue: Catalogue, module: LoomModule): ReadonlyArray<Seen> =>
  Array.flatMap(relationKinds, (kind) =>
    Array.map(kind.referencesIn(catalogue, module), (found): Seen => ({
      loom: module.path,
      section: found.section,
      kind: kind.name,
      to: found.to,
      at: found.at,
      target: found.target,
      now: fingerprintOf(found.target.section),
    })),
  )

const sharedLabels = (held: KeptRelation, seen: Seen): number =>
  (held.section === seen.section ? 1 : 0) + (held.to === seen.to ? 1 : 0)

const follows =
  (module: LoomModule, held: KeptRelation) =>
  (seen: Seen): boolean =>
    held.kind === seen.kind &&
    held.fingerprint === seen.now &&
    (held.loom === module.path || sharedLabels(held, seen) === 2)

const followerOf =
  (module: LoomModule, unanswered: ReadonlyArray<Seen>) =>
  (held: KeptRelation): Option.Option<Seen> =>
    Array.reduce(
      Array.filter(unanswered, follows(module, held)),
      Option.none<Seen>(),
      (best, seen) =>
        Option.match(best, {
          onNone: () => Option.some(seen),
          onSome: (chosen) =>
            sharedLabels(held, seen) > sharedLabels(held, chosen) ? Option.some(seen) : best,
        }),
    )

const trackedIn = (
  catalogue: Catalogue,
  module: LoomModule,
  kept: ReadonlyArray<KeptRelation>,
): ReadonlyArray<Tracked> => {
  const seen = seenIn(catalogue, module)
  const labelled = new Map(Array.map(kept, (held) => [keyOf(held), held] as const))
  const answering = (one: Seen): Option.Option<KeptRelation> =>
    Option.fromNullishOr(labelled.get(keyOf(one)))
  const answered = new Set(Array.map(seen, keyOf))
  const strays = Array.filter(kept, (held) =>
    held.loom === module.path ? !answered.has(keyOf(held)) : !catalogue.modules.has(held.loom),
  )
  const follower = followerOf(
    module,
    Array.filter(seen, (one) => Option.isNone(answering(one))),
  )
  const followed = new Map(
    pipe(
      Array.map(strays, (held) => Option.map(follower(held), (one) => [keyOf(one), held] as const)),
      Array.getSomes,
      Array.reverse,
    ),
  )
  return Array.map(seen, (one) => ({
    seen: one,
    kept: Option.orElse(answering(one), () => Option.fromNullishOr(followed.get(keyOf(one)))),
  }))
}

const statusOf = (tracked: Tracked): RelationStatus =>
  Option.match(tracked.kept, {
    onNone: () => 'untracked',
    onSome: (held) => (held.fingerprint === tracked.seen.now ? 'inStep' : 'drifted'),
  })

const relationOf = (tracked: Tracked): Relation => ({
  loom: tracked.seen.loom,
  section: tracked.seen.section,
  kind: tracked.seen.kind,
  to: tracked.seen.to,
  at: tracked.seen.at,
  target: tracked.seen.target,
  status: statusOf(tracked),
})

export const relationsOf = (
  catalogue: Catalogue,
  module: LoomModule,
  kept: ReadonlyArray<KeptRelation>,
): ReadonlyArray<Relation> => Array.map(trackedIn(catalogue, module, kept), relationOf)

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

const byLabels: Order.Order<KeptRelation> = Order.mapInput(Order.String, keyOf)

const sameLabels = (one: Named, other: Named): boolean => keyOf(one) === keyOf(other)

const keptAs = (seen: Seen, fingerprint: string): KeptRelation => ({
  loom: seen.loom,
  section: seen.section,
  kind: seen.kind,
  to: seen.to,
  fingerprint,
})

const chosenIn = (
  tracked: ReadonlyArray<Tracked>,
  chosen: (relation: Relation) => boolean,
): ReadonlyArray<KeptRelation> =>
  pipe(
    Array.filter(tracked, (one) => chosen(relationOf(one))),
    Array.map((one) => keptAs(one.seen, one.seen.now)),
    Array.dedupeWith(sameLabels),
  )

export const chosenRelations = (
  catalogue: Catalogue,
  module: LoomModule,
  kept: ReadonlyArray<KeptRelation>,
  chosen: (relation: Relation) => boolean,
): ReadonlyArray<KeptRelation> => chosenIn(trackedIn(catalogue, module, kept), chosen)

export const approvedRelations = (
  catalogue: Catalogue,
  module: LoomModule,
  kept: ReadonlyArray<KeptRelation>,
  chosen: (relation: Relation) => boolean,
): ReadonlyArray<KeptRelation> => {
  const tracked = trackedIn(catalogue, module, kept)
  const standing = Array.getSomes(
    Array.map(tracked, (one) =>
      Option.map(one.kept, (held) => keptAs(one.seen, held.fingerprint)),
    ),
  )
  const found = new Set(Array.getSomes(Array.map(tracked, (one) => one.kept)))
  const elsewhere = Array.filter(kept, (held) => held.loom !== module.path && !found.has(held))
  return pipe(
    [...chosenIn(tracked, chosen), ...standing, ...elsewhere],
    Array.dedupeWith(sameLabels),
    Array.sort(byLabels),
  )
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
      keeps: approvedRelations(catalogue, module, kept, (other) => sameLabels(other, relation)),
    })),
  )
