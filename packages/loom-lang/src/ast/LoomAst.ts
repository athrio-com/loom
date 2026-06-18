import { Schema } from 'effect'
import { loomNode } from './LoomNode'
import {
  HeadingStartTokenSchema,
  HeadingTitleTokenSchema,
  PathSpecifierTokenSchema,
  SpecifierTokenSchema,
  TagTokenSchema,
} from './LoomTokens'
import { PreambleWeftSchema, SectionBodyWeftSchema } from './Weft'

export const LoomHeadingSchema = loomNode('LoomHeading', {
  headingStart: HeadingStartTokenSchema,
  title: Schema.optional(HeadingTitleTokenSchema),
  tag: Schema.optional(TagTokenSchema),
  specifier: Schema.optional(
    Schema.Union(SpecifierTokenSchema, PathSpecifierTokenSchema),
  ),
})
export type LoomHeading = typeof LoomHeadingSchema.Type

export const LoomSectionSchema = loomNode('LoomSection', {
  heading: LoomHeadingSchema,
  preamble: Schema.Array(PreambleWeftSchema),
  code: Schema.Array(SectionBodyWeftSchema),
})
export type LoomSection = typeof LoomSectionSchema.Type

export const LoomDocumentSchema = loomNode('LoomDocument', {
  preamble: Schema.Array(PreambleWeftSchema),
  sections: Schema.Array(LoomSectionSchema),
})
export type LoomDocument = typeof LoomDocumentSchema.Type
