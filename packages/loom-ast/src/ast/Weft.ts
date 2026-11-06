import { Match, Option, Schema } from 'effect'
import { loomNode } from '#ast/LoomNode'
import {
  ArrowTokenSchema,
  type BoxToken,
  BoxTokenSchema,
  CodeFenceTokenSchema,
  CodeTokenSchema,
  DividerTokenSchema,
  FenceLabelTokenSchema,
  FrontmatterChapterTokenSchema,
  FrontmatterDiscussionTokenSchema,
  FrontmatterTropeTokenSchema,
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
  TocDiscussionTokenSchema,
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
  box: Schema.optional(BoxTokenSchema),
})
export type PreambleWeft = typeof PreambleWeftSchema.Type

export const ProseWeftSchema = loomNode('ProseWeft', {
  anchors: Schema.Array(WarpAnchorTokenSchema),
  box: Schema.optional(BoxTokenSchema),
})
export type ProseWeft = typeof ProseWeftSchema.Type

export const CodeWeftSchema = loomNode('CodeWeft', {
  anchors: Schema.Array(WarpAnchorTokenSchema),
})
export type CodeWeft = typeof CodeWeftSchema.Type

export const FenceWeftSchema = loomNode('FenceWeft', {
  side: Schema.Literals(['open', 'close']),
  fence: CodeFenceTokenSchema,
  label: Schema.optional(FenceLabelTokenSchema),
  anchors: Schema.Array(WarpAnchorTokenSchema),
})
export type FenceWeft = typeof FenceWeftSchema.Type

export const FrontmatterWeftSchema = loomNode('FrontmatterWeft', {
  fence: Schema.optional(FrontmatterFenceTokenSchema),
  part: Schema.optional(FrontmatterPartTokenSchema),
  partName: Schema.optional(FrontmatterPartNameTokenSchema),
  chapter: Schema.optional(FrontmatterChapterTokenSchema),
  discussion: Schema.optional(FrontmatterDiscussionTokenSchema),
  trope: Schema.optional(FrontmatterTropeTokenSchema),
  title: Schema.optional(FrontmatterTitleTokenSchema),
  key: Schema.optional(FrontmatterKeyTokenSchema),
  value: Schema.optional(FrontmatterValueTokenSchema),
})
export type FrontmatterWeft = typeof FrontmatterWeftSchema.Type

export const TocWeftSchema = loomNode('TocWeft', {
  part: Schema.optional(TocPartTokenSchema),
  chapter: Schema.optional(TocChapterTokenSchema),
  discussion: Schema.optional(TocDiscussionTokenSchema),
  title: Schema.optional(TocTitleTokenSchema),
})
export type TocWeft = typeof TocWeftSchema.Type

export const DividerWeftSchema = loomNode('DividerWeft', {
  dashes: DividerTokenSchema,
})
export type DividerWeft = typeof DividerWeftSchema.Type

export const LoomWeftSchema = Schema.Union([
  HeadingWeftSchema,
  ArrowWeftSchema,
  TildeWeftSchema,
  PreambleWeftSchema,
  ProseWeftSchema,
  CodeWeftSchema,
  FenceWeftSchema,
  FrontmatterWeftSchema,
  TocWeftSchema,
  DividerWeftSchema,
])
export type LoomWeft = typeof LoomWeftSchema.Type

export const SectionBodyWeftSchema = Schema.Union([
  ArrowWeftSchema,
  CodeWeftSchema,
  FenceWeftSchema,
  TildeWeftSchema,
  ProseWeftSchema,
])
export type SectionBodyWeft = typeof SectionBodyWeftSchema.Type

export const boxOf = (weft: LoomWeft): Option.Option<BoxToken> =>
  Match.value(weft).pipe(
    Match.when({ type: 'PreambleWeft' }, (line) => Option.fromNullishOr(line.box)),
    Match.when({ type: 'ProseWeft' }, (line) => Option.fromNullishOr(line.box)),
    Match.orElse(() => Option.none<BoxToken>()),
  )

export const nextBox = (inBox: boolean, weft: LoomWeft): boolean =>
  Option.match(boxOf(weft), {
    onNone: () => inBox,
    onSome: (box) =>
      Match.value(box.side).pipe(
        Match.when('open', () => true),
        Match.when('close', () => false),
        Match.when('stray', () => inBox),
        Match.exhaustive,
      ),
  })
