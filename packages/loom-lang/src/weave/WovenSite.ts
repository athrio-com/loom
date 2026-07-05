import { Schema } from 'effect'

const intAtLeast = (min: number) =>
  Schema.makeFilter<number>((n) =>
    Number.isInteger(n) && n >= min ? undefined : `must be an integer >= ${min}`,
  )

export const AnchorLinkSchema = Schema.Struct({
  name: Schema.String,
  targetSlug: Schema.String,
  targetId: Schema.String,
  offset: Schema.Number.check(intAtLeast(0)),
  length: Schema.Number.check(intAtLeast(0)),
})
export type AnchorLink = typeof AnchorLinkSchema.Type

export const ProseBlockSchema = Schema.Struct({
  type: Schema.tag('prose'),
  markdown: Schema.String,
})
export type ProseBlock = typeof ProseBlockSchema.Type

export const HeadingBlockSchema = Schema.Struct({
  type: Schema.tag('heading'),
  level: Schema.Number.check(intAtLeast(1)),
  title: Schema.String,
  id: Schema.String,
})
export type HeadingBlock = typeof HeadingBlockSchema.Type

export const CodeBlockSchema = Schema.Struct({
  type: Schema.tag('code'),
  language: Schema.String,
  source: Schema.String,
  links: Schema.Array(AnchorLinkSchema),
})
export type CodeBlock = typeof CodeBlockSchema.Type

export const NoteBlockSchema = Schema.Struct({
  type: Schema.tag('note'),
  markdown: Schema.String,
})
export type NoteBlock = typeof NoteBlockSchema.Type

export const WovenBlockSchema = Schema.Union([
  ProseBlockSchema,
  HeadingBlockSchema,
  CodeBlockSchema,
  NoteBlockSchema,
])
export type WovenBlock = typeof WovenBlockSchema.Type

export const WovenPageSchema = Schema.Struct({
  slug: Schema.String,
  title: Schema.String,
  part: Schema.optional(Schema.String),
  blocks: Schema.Array(WovenBlockSchema),
})
export type WovenPage = typeof WovenPageSchema.Type

export const WovenNavEntrySchema = Schema.Struct({
  number: Schema.String,
  title: Schema.String,
  slug: Schema.String,
})
export type WovenNavEntry = typeof WovenNavEntrySchema.Type

export const WovenPartSchema = Schema.Struct({
  number: Schema.String,
  name: Schema.String,
  chapters: Schema.Array(WovenNavEntrySchema),
})
export type WovenPart = typeof WovenPartSchema.Type

export const WovenSiteSchema = Schema.Struct({
  nav: Schema.Array(WovenPartSchema),
  pages: Schema.Array(WovenPageSchema),
})
export type WovenSite = typeof WovenSiteSchema.Type
