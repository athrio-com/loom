import { Schema } from 'effect'
import { HealthSchema, okHealth, PositionSchema } from '#ast/LoomNode'

const productNode = <Tag extends string, Fields extends Schema.Struct.Fields>(
  tag: Tag,
  fields: Fields,
) =>
  Schema.Struct({
    type: Schema.Literal(tag).pipe(
      Schema.propertySignature,
      Schema.withConstructorDefault(() => tag),
    ),
    health: HealthSchema.pipe(
      Schema.propertySignature,
      Schema.withConstructorDefault(() => okHealth),
    ),
    ...fields,
  })

export const SectionIdSchema = Schema.Struct({
  path: Schema.String,
  name: Schema.String,
})
export type SectionId = typeof SectionIdSchema.Type

export const keyOf = (id: SectionId): string => JSON.stringify([id.path, id.name])

export const FragmentSchema = productNode('Fragment', {
  text: Schema.String,
  origin: PositionSchema,
})
export type Fragment = typeof FragmentSchema.Type

export const RefSchema = productNode('Ref', {
  target: Schema.OptionFromSelf(SectionIdSchema),
  anchor: PositionSchema,
})
export type Ref = typeof RefSchema.Type

export const PartSchema = Schema.Union(FragmentSchema, RefSchema)
export type Part = typeof PartSchema.Type

export const ComposedCodeSchema = productNode('ComposedCode', {
  origin: SectionIdSchema,
  languageId: Schema.String,
  parts: Schema.Array(PartSchema),
})
export type ComposedCode = typeof ComposedCodeSchema.Type

export const WovenProseSchema = productNode('WovenProse', {
  origin: SectionIdSchema,
  parts: Schema.Array(PartSchema),
})
export type WovenProse = typeof WovenProseSchema.Type

export const TangledFileSchema = productNode('TangledFile', {
  path: Schema.String,
  code: ComposedCodeSchema,
})
export type TangledFile = typeof TangledFileSchema.Type
