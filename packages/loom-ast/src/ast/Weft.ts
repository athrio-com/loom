import { Schema } from 'effect'
import { loomNode } from '#ast/LoomNode'
import {
  ArrowTokenSchema,
  CodeTokenSchema,
  DirSpecifierTokenSchema,
  HeadingStartTokenSchema,
  PathSpecifierTokenSchema,
  ProseTokenSchema,
  HeadingTitleTokenSchema,
  SpecifierTokenSchema,
  TildeTokenSchema,
  WarpAnchorTokenSchema,
  WarpTokenSchema,
} from './LoomTokens'

export const HeadingWeftSchema = loomNode('HeadingWeft', {
  headingStart: HeadingStartTokenSchema,
  title: Schema.optional(HeadingTitleTokenSchema),
  specifier: Schema.optional(
    Schema.Union(
      SpecifierTokenSchema,
      PathSpecifierTokenSchema,
      DirSpecifierTokenSchema,
    ),
  ),
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
})
export type TildeWeft = typeof TildeWeftSchema.Type

export const PreambleWeftSchema = loomNode('PreambleWeft', {
  warps: Schema.Array(WarpTokenSchema),
})
export type PreambleWeft = typeof PreambleWeftSchema.Type

export const ProseWeftSchema = loomNode('ProseWeft', {})
export type ProseWeft = typeof ProseWeftSchema.Type

export const CodeWeftSchema = loomNode('CodeWeft', {
  anchors: Schema.Array(WarpAnchorTokenSchema),
})
export type CodeWeft = typeof CodeWeftSchema.Type

export const LoomWeftSchema = Schema.Union(
  HeadingWeftSchema,
  ArrowWeftSchema,
  TildeWeftSchema,
  PreambleWeftSchema,
  ProseWeftSchema,
  CodeWeftSchema,
)
export type LoomWeft = typeof LoomWeftSchema.Type

export const SectionBodyWeftSchema = Schema.Union(
  ArrowWeftSchema,
  CodeWeftSchema,
  TildeWeftSchema,
  ProseWeftSchema,
)
export type SectionBodyWeft = typeof SectionBodyWeftSchema.Type
