import { Schema } from 'effect'
import { loomNode } from '#ast/LoomNode'
import {
  FrontmatterChapterTokenSchema,
  FrontmatterPartTokenSchema,
  FrontmatterPartNameTokenSchema,
  FrontmatterTitleTokenSchema,
  FrontmatterValueTokenSchema,
  HeadingStartTokenSchema,
  HeadingTitleTokenSchema,
  SinkTokenSchema,
  SpecifierTokenSchema,
} from './LoomTokens'
import {
  PreambleWeftSchema,
  SectionBodyWeftSchema,
  TocWeftSchema,
} from './Weft'

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
  entries: Schema.optional(Schema.Array(TocWeftSchema)),
})
export type LoomSection = typeof LoomSectionSchema.Type

export const LoomFrontmatterSchema = loomNode('LoomFrontmatter', {
  part: Schema.optional(FrontmatterPartTokenSchema),
  partName: Schema.optional(FrontmatterPartNameTokenSchema),
  chapter: Schema.optional(FrontmatterChapterTokenSchema),
  title: Schema.optional(FrontmatterTitleTokenSchema),
  package: Schema.optional(FrontmatterValueTokenSchema),
  language: Schema.optional(FrontmatterValueTokenSchema),
})
export type LoomFrontmatter = typeof LoomFrontmatterSchema.Type

export const LoomDocumentSchema = loomNode('LoomDocument', {
  frontmatter: Schema.optional(LoomFrontmatterSchema),
  preamble: Schema.Array(PreambleWeftSchema),
  sections: Schema.Array(LoomSectionSchema),
})
export type LoomDocument = typeof LoomDocumentSchema.Type
