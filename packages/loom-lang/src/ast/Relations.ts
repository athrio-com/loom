import { createHash } from 'node:crypto'
import { Array, Option, Order, pipe, Record, Schema } from 'effect'
import { byType } from '@athrio/loom-ast/LoomNode'
import type { Diagnostic, Position } from '@athrio/loom-ast/LoomNode'
import type { LoomSection } from '@athrio/loom-ast/LoomAst'
import type { Code, Part } from '@athrio/loom-ast/ProductAst'
import {
  type Catalogue,
  isTropeEntry,
  type Location,
  type LoomModule,
  referencesOf,
  resolveAnchor,
  resolveName,
  resolveReference,
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

type Found = Pick<Relation, 'section' | 'kind' | 'to' | 'at' | 'target'>

type ReferenceFinder = (catalogue: Catalogue, module: LoomModule) => ReadonlyArray<Found>

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
          Option.map(
            (target): Found => ({
              section,
              kind: 'anchor',
              to: edge.name,
              at: edge.anchor,
              target,
            }),
          ),
          Option.toArray,
        )

const foundInPart = byType<
  Part,
  [
    within: {
      readonly catalogue: Catalogue
      readonly module: LoomModule
      readonly host: Code
    },
  ]
>()<ReadonlyArray<Found>>({
  NameRef: (matched, { catalogue, module, host }) =>
    openEdge(catalogue, module, host.origin.name)(matched),
  ModuleRef: (matched, { catalogue, module, host }) =>
    openEdge(catalogue, module, host.origin.name)(matched),
  Fragment: (): ReadonlyArray<Found> => [],
})

const anchorsIn: ReferenceFinder = (catalogue, module) =>
  module.product.code.flatMap((host) =>
    host.fragments.flatMap((part) => foundInPart(part, { catalogue, module, host })),
  )

const linksIn: ReferenceFinder = (catalogue, module) =>
  module.doc.sections.flatMap((section) =>
    sectionLinksOf(section).flatMap((link) =>
      pipe(
        resolveAnchor(catalogue, module.path, link),
        Option.filter(inAnotherLoom(module)),
        Option.map(
          (target): Found => ({
            section: sectionNameOf(section),
            kind: 'link',
            to: link.name.value,
            at: link.name.position,
            target,
          }),
        ),
        Option.toArray,
      ),
    ),
  )

const parametersIn: ReferenceFinder = (catalogue, module) =>
  referencesOf(module).flatMap((held) =>
    pipe(
      held.section,
      Option.filter(() => !isTropeEntry(held)),
      Option.flatMap((section) =>
        pipe(
          resolveReference(catalogue, module.path, held),
          Option.filter(inAnotherLoom(module)),
          Option.map(
            (target): Found => ({
              section: sectionNameOf(section),
              kind: held.key,
              to: held.value.value,
              at: held.value.position,
              target,
            }),
          ),
        ),
      ),
      Option.toArray,
    ),
  )

export const referenceFinders: ReadonlyArray<ReferenceFinder> = [anchorsIn, linksIn, parametersIn]

const settled = (text: string): string =>
  text
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line !== '')
    .join('\n')

const said = (section: LoomSection): string =>
  [...section.preamble, ...section.code].map((weft) => weft.source).join('')

export const fingerprintOf = (section: LoomSection): string =>
  createHash('sha256').update(settled(said(section))).digest('hex')

type Named = Pick<Relation, 'loom' | 'section' | 'kind' | 'to'>

type Seen = Named & Pick<Relation, 'at' | 'target'> & { readonly now: string }

type Tracked = { readonly seen: Seen; readonly kept: Option.Option<KeptRelation> }

const keyOf = (named: Named): string =>
  JSON.stringify([named.loom, named.section, named.kind, named.to])

const seenIn = (catalogue: Catalogue, module: LoomModule): ReadonlyArray<Seen> =>
  referenceFinders.flatMap((find) =>
    find(catalogue, module).map((found): Seen => ({
      loom: module.path,
      section: found.section,
      kind: found.kind,
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
    unanswered.filter(follows(module, held)).reduce(
      (best, seen) =>
        Option.match(best, {
          onNone: () => Option.some(seen),
          onSome: (chosen) =>
            sharedLabels(held, seen) > sharedLabels(held, chosen) ? Option.some(seen) : best,
        }),
      Option.none<Seen>(),
    )

const trackedIn = (
  catalogue: Catalogue,
  module: LoomModule,
  kept: ReadonlyArray<KeptRelation>,
): ReadonlyArray<Tracked> => {
  const seen = seenIn(catalogue, module)
  const labelled = new Map(kept.map((held) => [keyOf(held), held] as const))
  const answering = (one: Seen): Option.Option<KeptRelation> =>
    Option.fromNullishOr(labelled.get(keyOf(one)))
  const answered = new Set(seen.map(keyOf))
  const strays = kept.filter((held) =>
    held.loom === module.path ? !answered.has(keyOf(held)) : !catalogue.modules.has(held.loom),
  )
  const follower = followerOf(
    module,
    seen.filter((one) => Option.isNone(answering(one))),
  )
  const followed = new Map(
    pipe(
      strays.map((held) => Option.map(follower(held), (one) => [keyOf(one), held] as const)),
      Array.getSomes,
      Array.reverse,
    ),
  )
  return seen.map((one) => ({
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
): ReadonlyArray<Relation> => trackedIn(catalogue, module, kept).map(relationOf)

export const driftFaults = (
  catalogue: Catalogue,
  module: LoomModule,
  kept: ReadonlyArray<KeptRelation>,
): ReadonlyArray<Diagnostic> =>
  relationsOf(catalogue, module, kept)
    .filter((relation) => relation.status === 'drifted')
    .flatMap((relation) => faulty(DriftedReference({ name: relation.to }), relation.at).diagnostics)

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
    relations.filter((relation) => relation.status === 'drifted'),
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
  Array.dedupeWith(
    tracked.filter((one) => chosen(relationOf(one))).map((one) => keptAs(one.seen, one.seen.now)),
    sameLabels,
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
    tracked.map((one) => Option.map(one.kept, (held) => keptAs(one.seen, held.fingerprint))),
  )
  const found = new Set(Array.getSomes(tracked.map((one) => one.kept)))
  const elsewhere = kept.filter((held) => held.loom !== module.path && !found.has(held))
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
  relationsOf(catalogue, module, kept)
    .filter((relation) => relation.status !== 'inStep' && meets(relation.at, start, end))
    .map((relation) => ({
      relation,
      keeps: approvedRelations(catalogue, module, kept, (other) => sameLabels(other, relation)),
    }))
