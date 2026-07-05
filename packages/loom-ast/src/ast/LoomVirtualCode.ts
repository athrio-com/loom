import { Schema } from 'effect'
import { PositionSchema } from '#ast/LoomNode'
import { SymbolKindSchema } from '#ast/LoomSymbol'

export const MappingKindSchema = Schema.Union([
  SymbolKindSchema,
  Schema.Literal('source'),
  Schema.Literal('product'),
])
export type MappingKind = typeof MappingKindSchema.Type

export const MappingSchema = Schema.Struct({
  genStart: Schema.Number,
  genLength: Schema.Number,
  source: PositionSchema,
  kind: Schema.optional(MappingKindSchema),
})
export type Mapping = typeof MappingSchema.Type

export interface LoomVirtualCode {
  readonly id: string
  readonly languageId: string
  readonly code: string
  readonly mappings: ReadonlyArray<Mapping>
  readonly embeddedCodes: ReadonlyArray<LoomVirtualCode>
}

export const LoomVirtualCodeSchema: Schema.Schema<LoomVirtualCode> =
  Schema.Struct({
    id: Schema.String,
    languageId: Schema.String,
    code: Schema.String,
    mappings: Schema.Array(MappingSchema),
    embeddedCodes: Schema.Array(
      Schema.suspend(() => LoomVirtualCodeSchema),
    ),
  })
