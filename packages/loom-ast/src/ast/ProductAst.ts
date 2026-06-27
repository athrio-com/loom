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

const refFields = {
  target: Schema.OptionFromSelf(SectionIdSchema),
  anchor: PositionSchema,
}

export const NameRefSchema = productNode('NameRef', refFields)
export type NameRef = typeof NameRefSchema.Type

export const TagRefSchema = productNode('TagRef', refFields)
export type TagRef = typeof TagRefSchema.Type

export const RefSchema = Schema.Union(NameRefSchema, TagRefSchema)
export type Ref = typeof RefSchema.Type

export const PartSchema = Schema.Union(FragmentSchema, RefSchema)
export type Part = typeof PartSchema.Type

export const CodeSchema = productNode('Code', {
  origin: SectionIdSchema,
  languageId: Schema.String,
  fragments: Schema.Array(PartSchema),
})
export type Code = typeof CodeSchema.Type

export const WovenProseSchema = productNode('WovenProse', {
  origin: SectionIdSchema,
  fragments: Schema.Array(PartSchema),
})
export type WovenProse = typeof WovenProseSchema.Type

export const FileSchema = productNode('File', {
  path: Schema.String,
  code: CodeSchema,
})
export type File = typeof FileSchema.Type

export const ProductSchema = Schema.Struct({
  code: Schema.Array(CodeSchema),
  files: Schema.Array(FileSchema),
})
export type Product = typeof ProductSchema.Type
