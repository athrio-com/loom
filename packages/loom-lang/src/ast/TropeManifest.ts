import { Option, pipe, Result, Schema } from 'effect'
import { KeysSchema } from '@athrio/loom-ast/LoomTokens'

export const contractVersion = '1'

export const BoxKindDeclarationSchema = Schema.Struct({
  kind: Schema.NonEmptyString,
  body: Schema.NonEmptyString,
})
export type BoxKindDeclaration = typeof BoxKindDeclarationSchema.Type

export const SectionKindDeclarationSchema = Schema.Struct({
  kind: Schema.NonEmptyString,
  parameters: Schema.optional(KeysSchema),
})
export type SectionKindDeclaration = typeof SectionKindDeclarationSchema.Type

export const TropeManifestSchema = Schema.Struct({
  contract: Schema.Literal(contractVersion),
  contributes: Schema.Struct({
    kinds: Schema.Struct({
      box: Schema.optional(Schema.Array(BoxKindDeclarationSchema)),
      section: Schema.optional(Schema.Array(SectionKindDeclarationSchema)),
    }),
  }),
})
export type TropeManifest = typeof TropeManifestSchema.Type

export const boxKindsOf = (manifest: TropeManifest): ReadonlyArray<BoxKindDeclaration> =>
  Option.getOrElse(Option.fromNullishOr(manifest.contributes.kinds.box), () => [])

export const sectionKindsOf = (manifest: TropeManifest): ReadonlyArray<SectionKindDeclaration> =>
  Option.getOrElse(Option.fromNullishOr(manifest.contributes.kinds.section), () => [])

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
