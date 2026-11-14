import { Context, Effect, Layer, Match, Option } from 'effect'
import { okHealth } from '@athrio/loom-ast/LoomNode'
import type {
  ExpandedDocument,
  ExpandedHeading,
  LoomDocument,
  ParsedDocument,
  ParsedHeading,
} from '@athrio/loom-ast/LoomAst'
import {
  labelKey,
  ParameterKeyTokenSchema,
  type ParameterToken,
  ParameterTokenSchema,
  ParameterValueTokenSchema,
  type ParametersToken,
  ParametersTokenSchema,
  sectionKinds,
  type SpecifierLabelToken,
  type SpecifierToken,
} from '@athrio/loom-ast/LoomTokens'
import { rewritten } from '@athrio/loom-ast/TreeFold'

export class LoomDocumentBuilder extends Context.Service<LoomDocumentBuilder>()(
  'LoomDocumentBuilder',
  {
    make: Effect.succeed({
      build: (parsed: ParsedDocument): LoomDocument => expandedDocument(sectionKinds)(parsed),
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
