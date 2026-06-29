import { Schema } from 'effect'
import { loomNode } from '#ast/LoomNode'
import {
  HeadingStartTokenSchema,
  HeadingTitleTokenSchema,
  SinkTokenSchema,
  SpecifierTokenSchema,
} from './LoomTokens'
import { PreambleWeftSchema, SectionBodyWeftSchema } from './Weft'

export const LoomHeadingSchema = loomNode('LoomHeading', {
  headingStart: HeadingStartTokenSchema,
  title: Schema.optional(HeadingTitleTokenSchema),
  specifier: Schema.optional(SpecifierTokenSchema),
  sink: Schema.optional(SinkTokenSchema),
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
