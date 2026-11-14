import { Array, Context, Effect, Layer, Match, Option, pipe } from 'effect'
import { type Health, okHealth } from '@athrio/loom-ast/LoomNode'
import type {
  ClaimedDocument,
  ClaimedSection,
  ExpandedDocument,
  ExpandedHeading,
  ExpandedSection,
  LoomDocument,
  ParsedDocument,
  ParsedHeading,
} from '@athrio/loom-ast/LoomAst'
import {
  anchorKeys,
  boxKeys,
  type BoxToken,
  headingKeys,
  kindNamed,
  labelKey,
  ParameterKeyTokenSchema,
  type ParameterToken,
  ParameterTokenSchema,
  type ParameterValueToken,
  ParameterValueTokenSchema,
  type ParametersToken,
  ParametersTokenSchema,
  sectionKinds,
  type SpecifierLabelToken,
  type SpecifierToken,
  type WarpAnchorToken,
} from '@athrio/loom-ast/LoomTokens'
import { rewritten } from '@athrio/loom-ast/TreeFold'
import { type BracesOn, faulty, RepeatedKey, UnknownKey, UnknownKind } from '#ast/LoomFault'

export class LoomDocumentBuilder extends Context.Service<LoomDocumentBuilder>()(
  'LoomDocumentBuilder',
  {
    make: Effect.succeed({
      build: (parsed: ParsedDocument): LoomDocument =>
        pipe(
          parsed,
          expandedDocument(sectionKinds),
          claimedDocument(sectionKinds),
          checkedDocument,
        ),
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make)
}

export const expandedDocument =
  (kinds: ReadonlyArray<string>) =>
  (parsed: ParsedDocument): ExpandedDocument =>
    rewritten(parsed, { LoomHeading: expandedHeading(kinds) })

const expandedHeading =
  (kinds: ReadonlyArray<string>) =>
  (heading: ParsedHeading): ExpandedHeading => ({
    ...heading,
    specifier: Option.getOrUndefined(
      Option.map(Option.fromNullishOr(heading.specifier), inFull(kinds)),
    ),
  })

const inFull =
  (kinds: ReadonlyArray<string>) =>
  (specifier: SpecifierToken | ParametersToken): ParametersToken =>
    Match.value(specifier).pipe(
      Match.when({ type: 'Parameters' }, (held) => held),
      Match.when({ type: 'Specifier' }, expandedLabel(kinds)),
      Match.exhaustive,
    )

const expandedLabel =
  (kinds: ReadonlyArray<string>) =>
  (labelled: SpecifierToken): ParametersToken =>
    ParametersTokenSchema.make({
      position: labelled.position,
      source: labelled.source,
      health: {
        status: labelled.health.status,
        diagnostics: [...labelled.health.diagnostics, ...labelled.label.health.diagnostics],
      },
      unexpected: [...(labelled.unexpected ?? []), ...(labelled.label.unexpected ?? [])],
      open: labelled.open,
      parameters:
        labelled.label.health.status === 'ok' ? [labelParameter(kinds)(labelled.label)] : [],
      close: labelled.close,
    })

const labelParameter =
  (kinds: ReadonlyArray<string>) =>
  (label: SpecifierLabelToken): ParameterToken =>
    ParameterTokenSchema.make({
      position: label.position,
      source: label.source,
      health: okHealth,
      key: ParameterKeyTokenSchema.make({
        position: { start: label.position.start, end: label.position.start },
        source: '',
        health: okHealth,
        value: labelKey(kinds)(label.value),
      }),
      values: [
        ParameterValueTokenSchema.make({
          position: label.position,
          source: label.source,
          health: okHealth,
          value: label.value,
        }),
      ],
    })

export const claimedDocument =
  (kinds: ReadonlyArray<string>) =>
  (expanded: ExpandedDocument): ClaimedDocument =>
    rewritten(expanded, { LoomSection: claimedSection(kinds) })

type KindStated = {
  readonly held: ParametersToken
  readonly parameter: ParameterToken
  readonly value: ParameterValueToken
}

const kindStated = (heading: ExpandedHeading): Option.Option<KindStated> =>
  pipe(
    Option.fromNullishOr(heading.specifier),
    Option.flatMap((held) =>
      pipe(
        Array.findFirst(held.parameters, (parameter) => parameter.key.value === 'kind'),
        Option.flatMap((parameter) =>
          Option.map(Array.head(parameter.values), (value) => ({ held, parameter, value })),
        ),
      ),
    ),
  )

const claimedSection =
  (kinds: ReadonlyArray<string>) =>
  (section: ExpandedSection): ClaimedSection =>
    Option.match(kindStated(section.heading), {
      onNone: () => section,
      onSome: (stated) =>
        Option.match(kindNamed(kinds)(stated.value.value), {
          onSome: (kind) => ({ ...section, kind }),
          onNone: () => ({ ...section, heading: unclaimed(kinds)(section.heading, stated) }),
        }),
    })

const unclaimed =
  (kinds: ReadonlyArray<string>) =>
  (heading: ExpandedHeading, stated: KindStated): ExpandedHeading => {
    const fault = faulty(
      UnknownKind({ kind: stated.value.value, kinds, on: 'heading' }),
      stated.value.position,
    )
    return {
      ...heading,
      health: { ...heading.health, status: fault.status },
      specifier: {
        ...stated.held,
        health: { ...stated.held.health, status: fault.status },
        parameters: Array.map(stated.held.parameters, (parameter) =>
          parameter === stated.parameter ? { ...parameter, health: fault } : parameter,
        ),
      },
    }
  }

type Takes = { readonly on: BracesOn; readonly keys: ReadonlyArray<string> }

const headingTakes: Takes = { on: 'heading', keys: headingKeys }

const anchorTakes: Takes = { on: 'anchor', keys: anchorKeys }

const boxTakes: Takes = { on: 'box', keys: boxKeys }

export const checkedDocument = (claimed: ClaimedDocument): ClaimedDocument =>
  rewritten(claimed, {
    LoomHeading: (heading: ExpandedHeading): ExpandedHeading =>
      checkedBearer(headingTakes)(heading),
    WarpAnchor: (anchor: WarpAnchorToken): WarpAnchorToken => checkedBearer(anchorTakes)(anchor),
    Box: (box: BoxToken): BoxToken => checkedBearer(boxTakes)(box),
  })

const keyFault = (
  takes: Takes,
  parameter: ParameterToken,
  earlier: ReadonlyArray<ParameterToken>,
): Option.Option<Health> => {
  const key = parameter.key.value
  return Match.value({
    repeated: Array.some(earlier, (before) => before.key.value === key),
    known: Array.contains(takes.keys, key),
  }).pipe(
    Match.when({ repeated: true }, () =>
      Option.some(faulty(RepeatedKey({ key }), parameter.key.position)),
    ),
    Match.when({ known: false }, () =>
      Option.some(
        faulty(UnknownKey({ key, keys: takes.keys, on: takes.on }), parameter.key.position),
      ),
    ),
    Match.orElse(() => Option.none()),
  )
}

const faultedParameters =
  (takes: Takes) =>
  (held: ParametersToken): Option.Option<ParametersToken> => {
    const faults = Array.map(held.parameters, (parameter, at) =>
      keyFault(takes, parameter, Array.take(held.parameters, at)),
    )
    return Option.map(Array.head(Array.getSomes(faults)), (first) => ({
      ...held,
      health: { ...held.health, status: first.status },
      parameters: Array.zipWith(held.parameters, faults, (parameter, fault) =>
        Option.match(fault, {
          onNone: () => parameter,
          onSome: (health) => ({ ...parameter, health }),
        }),
      ),
    }))
  }

type Braced = {
  readonly health: Health
  readonly specifier?: SpecifierToken | ParametersToken | undefined
}

const checkedBearer =
  (takes: Takes) =>
  <Bearer extends Braced>(bearer: Bearer): Bearer =>
    pipe(
      Option.fromNullishOr(bearer.specifier),
      Option.filter((braces): braces is ParametersToken => braces.type === 'Parameters'),
      Option.flatMap(faultedParameters(takes)),
      Option.match({
        onNone: () => bearer,
        onSome: (faulted) => ({
          ...bearer,
          health: { ...bearer.health, status: faulted.health.status },
          specifier: faulted,
        }),
      }),
    )
