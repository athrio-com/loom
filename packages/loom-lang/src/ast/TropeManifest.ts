import { Option, pipe, Result, Schema } from 'effect'
import { type Keys, KeysSchema, StandingSchema } from '@athrio/loom-ast/LoomTokens'

export const contractVersion = '1'

export const BoxKindDeclarationSchema = Schema.Struct({
  kind: Schema.NonEmptyString,
  body: Schema.NonEmptyString,
  parameters: Schema.optional(KeysSchema),
})
export type BoxKindDeclaration = typeof BoxKindDeclarationSchema.Type

export const SectionKindDeclarationSchema = Schema.Struct({
  kind: Schema.NonEmptyString,
  code: Schema.optional(Schema.Literal('none')),
  parameters: Schema.optional(KeysSchema),
})
export type SectionKindDeclaration = typeof SectionKindDeclarationSchema.Type

export const AnchorKindDeclarationSchema = Schema.Struct({
  kind: Schema.NonEmptyString,
  standsIn: Schema.optional(StandingSchema),
  parameters: Schema.optional(KeysSchema),
})
export type AnchorKindDeclaration = typeof AnchorKindDeclarationSchema.Type

export const HeadingsDeclarationSchema = Schema.Struct({ parameters: KeysSchema })
export type HeadingsDeclaration = typeof HeadingsDeclarationSchema.Type

export const TropeManifestSchema = Schema.Struct({
  contract: Schema.Literal(contractVersion),
  contributes: Schema.Struct({
    kinds: Schema.optional(
      Schema.Struct({
        box: Schema.optional(Schema.Array(BoxKindDeclarationSchema)),
        section: Schema.optional(Schema.Array(SectionKindDeclarationSchema)),
        anchor: Schema.optional(Schema.Array(AnchorKindDeclarationSchema)),
      }),
    ),
    headings: Schema.optional(HeadingsDeclarationSchema),
  }),
})
export type TropeManifest = typeof TropeManifestSchema.Type

const tableOf = <Declaration>(
  table: ReadonlyArray<Declaration> | undefined,
): ReadonlyArray<Declaration> => Option.getOrElse(Option.fromNullishOr(table), () => [])

export const boxKindsOf = (manifest: TropeManifest): ReadonlyArray<BoxKindDeclaration> =>
  tableOf(manifest.contributes.kinds?.box)

export const sectionKindsOf = (manifest: TropeManifest): ReadonlyArray<SectionKindDeclaration> =>
  tableOf(manifest.contributes.kinds?.section)

export const anchorKindsOf = (manifest: TropeManifest): ReadonlyArray<AnchorKindDeclaration> =>
  tableOf(manifest.contributes.kinds?.anchor)

export const parametersOf = (declaration: { readonly parameters?: Keys | undefined }): Keys =>
  Option.getOrElse(Option.fromNullishOr(declaration.parameters), (): Keys => ({}))

export const headingKeysOf = (manifest: TropeManifest): Keys =>
  Option.getOrElse(
    Option.map(Option.fromNullishOr(manifest.contributes.headings), (headings) => headings.parameters),
    (): Keys => ({}),
  )

const parsedJson = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Unknown))

const fitted = Schema.decodeUnknownResult(TropeManifestSchema)

const contractOf = (json: unknown): Option.Option<string> =>
  typeof json === 'object' &&
  json !== null &&
  'contract' in json &&
  typeof json.contract === 'string'
    ? Option.some(json.contract)
    : Option.none()

export const readManifest = (text: string): Result.Result<TropeManifest, string> =>
  pipe(
    parsedJson(text),
    Result.mapError(() => 'its manifest is not JSON'),
    Result.flatMap((json) =>
      Option.match(
        Option.filter(contractOf(json), (contract) => contract !== contractVersion),
        {
          onSome: (contract) =>
            Result.fail(
              `it needs contract ${contract}, and this Loom reads contract ${contractVersion}`,
            ),
          onNone: () =>
            pipe(
              fitted(json, { onExcessProperty: 'error' }),
              Result.mapError(
                (error) =>
                  `its manifest does not fit contract ${contractVersion}: ${error.message.replace(/\s+/g, ' ')}`,
              ),
            ),
        },
      ),
    ),
  )
