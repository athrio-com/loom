import { Array, Context, Effect, Layer, Match, Option, pipe } from 'effect'
import { okHealth } from '@athrio/loom-ast/LoomNode'
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
} from '@athrio/loom-ast/LoomTokens'
import { rewritten } from '@athrio/loom-ast/TreeFold'
import { faulty, UnknownKind } from '#ast/LoomFault'

export class LoomDocumentBuilder extends Context.Service<LoomDocumentBuilder>()(
  'LoomDocumentBuilder',
  {
    make: Effect.succeed({
      build: (parsed: ParsedDocument): LoomDocument =>
        pipe(parsed, expandedDocument(sectionKinds), claimedDocument(sectionKinds)),
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
