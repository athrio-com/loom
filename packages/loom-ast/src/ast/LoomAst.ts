import { Schema } from 'effect'
import { loomNode } from '#ast/LoomNode'
import {
  DividerTokenSchema,
  FrontmatterBookTokenSchema,
  FrontmatterChapterTokenSchema,
  FrontmatterDiscussionTokenSchema,
  FrontmatterTropeTokenSchema,
  FrontmatterEntryTokenSchema,
  FrontmatterPartTokenSchema,
  FrontmatterPartNameTokenSchema,
  FrontmatterTitleTokenSchema,
  FrontmatterValueTokenSchema,
  HeadingStartTokenSchema,
  HeadingTitleTokenSchema,
  ParametersTokenSchema,
  SinkTokenSchema,
  SpecifierTokenSchema,
} from './LoomTokens'
import { PreambleWeftSchema, SectionBodyWeftSchema } from './Weft'

export const ParsedHeadingSchema = loomNode('LoomHeading', {
  marker: Schema.Union([HeadingStartTokenSchema, DividerTokenSchema]),
  title: Schema.optional(HeadingTitleTokenSchema),
  specifier: Schema.optional(Schema.Union([SpecifierTokenSchema, ParametersTokenSchema])),
  sink: Schema.optional(SinkTokenSchema),
})
export type ParsedHeading = typeof ParsedHeadingSchema.Type

export const ParsedSectionSchema = loomNode('LoomSection', {
  heading: ParsedHeadingSchema,
  preamble: Schema.Array(PreambleWeftSchema),
  code: Schema.Array(SectionBodyWeftSchema),
})
export type ParsedSection = typeof ParsedSectionSchema.Type

export const LoomFrontmatterSchema = loomNode('LoomFrontmatter', {
  part: Schema.optional(FrontmatterPartTokenSchema),
  partName: Schema.optional(FrontmatterPartNameTokenSchema),
  chapter: Schema.optional(FrontmatterChapterTokenSchema),
  discussion: Schema.optional(FrontmatterDiscussionTokenSchema),
  trope: Schema.optional(FrontmatterTropeTokenSchema),
  rootedIn: Schema.optional(FrontmatterTropeTokenSchema),
  entries: Schema.optional(Schema.Array(FrontmatterEntryTokenSchema)),
  book: Schema.optional(FrontmatterBookTokenSchema),
  title: Schema.optional(FrontmatterTitleTokenSchema),
  package: Schema.optional(FrontmatterValueTokenSchema),
  language: Schema.optional(FrontmatterValueTokenSchema),
  status: Schema.optional(FrontmatterValueTokenSchema),
  priority: Schema.optional(FrontmatterValueTokenSchema),
})
export type LoomFrontmatter = typeof LoomFrontmatterSchema.Type

export const ParsedDocumentSchema = loomNode('LoomDocument', {
  frontmatter: Schema.optional(LoomFrontmatterSchema),
  preamble: Schema.Array(PreambleWeftSchema),
  sections: Schema.Array(ParsedSectionSchema),
})
export type ParsedDocument = typeof ParsedDocumentSchema.Type

export const ExpandedHeadingSchema = Schema.Struct({
  ...ParsedHeadingSchema.fields,
  specifier: Schema.optional(ParametersTokenSchema),
})
export type ExpandedHeading = typeof ExpandedHeadingSchema.Type

export const ExpandedSectionSchema = Schema.Struct({
  ...ParsedSectionSchema.fields,
  heading: ExpandedHeadingSchema,
})
export type ExpandedSection = typeof ExpandedSectionSchema.Type

export const ExpandedDocumentSchema = Schema.Struct({
  ...ParsedDocumentSchema.fields,
  sections: Schema.Array(ExpandedSectionSchema),
})
export type ExpandedDocument = typeof ExpandedDocumentSchema.Type

export const ClaimedSectionSchema = Schema.Struct({
  ...ExpandedSectionSchema.fields,
  kind: Schema.optional(Schema.String),
})
export type ClaimedSection = typeof ClaimedSectionSchema.Type

export const ClaimedDocumentSchema = Schema.Struct({
  ...ExpandedDocumentSchema.fields,
  sections: Schema.Array(ClaimedSectionSchema),
})
export type ClaimedDocument = typeof ClaimedDocumentSchema.Type

export const LoomHeadingSchema = ExpandedHeadingSchema
export type LoomHeading = ExpandedHeading

export const LoomSectionSchema = ClaimedSectionSchema
export type LoomSection = ClaimedSection

export const LoomDocumentSchema = ClaimedDocumentSchema
export type LoomDocument = ClaimedDocument
