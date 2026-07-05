import { Schema } from 'effect'
import { loomNode } from '#ast/LoomNode'
import {
  ArrowTokenSchema,
  CodeTokenSchema,
  FrontmatterChapterTokenSchema,
  FrontmatterFenceTokenSchema,
  FrontmatterKeyTokenSchema,
  FrontmatterPartTokenSchema,
  FrontmatterPartNameTokenSchema,
  FrontmatterTitleTokenSchema,
  FrontmatterValueTokenSchema,
  HeadingStartTokenSchema,
  HeadingTitleTokenSchema,
  ProseTokenSchema,
  SinkTokenSchema,
  SpecifierTokenSchema,
  TildeTokenSchema,
  TocChapterTokenSchema,
  TocPartTokenSchema,
  TocTitleTokenSchema,
  WarpAnchorTokenSchema,
  WarpTokenSchema,
} from './LoomTokens'

export const HeadingWeftSchema = loomNode('HeadingWeft', {
  headingStart: HeadingStartTokenSchema,
  title: Schema.optional(HeadingTitleTokenSchema),
  specifier: Schema.optional(SpecifierTokenSchema),
  sink: Schema.optional(SinkTokenSchema),
})
export type HeadingWeft = typeof HeadingWeftSchema.Type

export const ArrowWeftSchema = loomNode('ArrowWeft', {
  arrow: ArrowTokenSchema,
  code: Schema.optional(CodeTokenSchema),
  anchors: Schema.Array(WarpAnchorTokenSchema),
})
export type ArrowWeft = typeof ArrowWeftSchema.Type

export const TildeWeftSchema = loomNode('TildeWeft', {
  tilde: TildeTokenSchema,
  prose: Schema.optional(ProseTokenSchema),
  anchors: Schema.Array(WarpAnchorTokenSchema),
})
export type TildeWeft = typeof TildeWeftSchema.Type

export const PreambleWeftSchema = loomNode('PreambleWeft', {
  warps: Schema.Array(WarpTokenSchema),
  anchors: Schema.Array(WarpAnchorTokenSchema),
})
export type PreambleWeft = typeof PreambleWeftSchema.Type

export const ProseWeftSchema = loomNode('ProseWeft', {
  anchors: Schema.Array(WarpAnchorTokenSchema),
})
export type ProseWeft = typeof ProseWeftSchema.Type

export const CodeWeftSchema = loomNode('CodeWeft', {
  anchors: Schema.Array(WarpAnchorTokenSchema),
})
export type CodeWeft = typeof CodeWeftSchema.Type

export const FrontmatterWeftSchema = loomNode('FrontmatterWeft', {
  fence: Schema.optional(FrontmatterFenceTokenSchema),
  part: Schema.optional(FrontmatterPartTokenSchema),
  partName: Schema.optional(FrontmatterPartNameTokenSchema),
  chapter: Schema.optional(FrontmatterChapterTokenSchema),
  title: Schema.optional(FrontmatterTitleTokenSchema),
  key: Schema.optional(FrontmatterKeyTokenSchema),
  value: Schema.optional(FrontmatterValueTokenSchema),
})
export type FrontmatterWeft = typeof FrontmatterWeftSchema.Type

export const TocWeftSchema = loomNode('TocWeft', {
  part: Schema.optional(TocPartTokenSchema),
  chapter: Schema.optional(TocChapterTokenSchema),
  title: Schema.optional(TocTitleTokenSchema),
})
export type TocWeft = typeof TocWeftSchema.Type

export const LoomWeftSchema = Schema.Union([
  HeadingWeftSchema,
  ArrowWeftSchema,
  TildeWeftSchema,
  PreambleWeftSchema,
  ProseWeftSchema,
  CodeWeftSchema,
  FrontmatterWeftSchema,
  TocWeftSchema,
])
export type LoomWeft = typeof LoomWeftSchema.Type

export const SectionBodyWeftSchema = Schema.Union([
  ArrowWeftSchema,
  CodeWeftSchema,
  TildeWeftSchema,
  ProseWeftSchema,
])
export type SectionBodyWeft = typeof SectionBodyWeftSchema.Type
