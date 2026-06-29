import { Data, Effect, Option, Schema, SchemaAST } from 'effect'
import { loomNode } from '#ast/LoomNode'

export const Probe: unique symbol = Symbol.for('loom/Probe')

export const getProbe = (
  schema: Schema.Schema<any, any, never>,
): Option.Option<RegExp> => SchemaAST.getAnnotation<RegExp>(Probe)(schema.ast)

export const HeadingStartTokenSchema = loomNode('HeadingStart', {}).annotations(
  {
    [Probe]: /^#{1,6} /,
  },
)
export type HeadingStartToken = typeof HeadingStartTokenSchema.Type

export const SpecifierOpenTokenSchema = loomNode('SpecifierOpen', {
  value: Schema.Literal('{'),
}).annotations({
  [Probe]: /\{/g,
})
export type SpecifierOpenToken = typeof SpecifierOpenTokenSchema.Type

export const SpecifierLabelTokenSchema = loomNode('SpecifierLabel', {
  value: Schema.String,
}).pipe(
  Schema.filter((t) => {
    if (t.value === '' && t.health.status === 'ok') {
      return 'empty `value` requires non-ok `health.status`'
    }
    if (t.value !== '' && !/^[a-zA-Z0-9_-]+$/.test(t.value)) {
      return `specifier label value must match [a-zA-Z0-9_-]+, got \`${t.value}\``
    }
    return true
  }),
)
export type SpecifierLabelToken = typeof SpecifierLabelTokenSchema.Type

export const SpecifierCloseTokenSchema = loomNode('SpecifierClose', {
  value: Schema.Literal('}'),
}).annotations({
  [Probe]: /\}/g,
})
export type SpecifierCloseToken = typeof SpecifierCloseTokenSchema.Type

export const SpecifierTokenSchema = loomNode('Specifier', {
  open: SpecifierOpenTokenSchema,
  label: SpecifierLabelTokenSchema,
  close: SpecifierCloseTokenSchema,
}).annotations({
  [Probe]: /\{[a-zA-Z0-9_-]+\}/g,
})
export type SpecifierToken = typeof SpecifierTokenSchema.Type

export const SinkOpenTokenSchema = loomNode('SinkOpen', {
  value: Schema.Literal('['),
}).annotations({
  [Probe]: /\[/g,
})
export type SinkOpenToken = typeof SinkOpenTokenSchema.Type

export const SinkCloseTokenSchema = loomNode('SinkClose', {
  value: Schema.Literal(']'),
}).annotations({
  [Probe]: /\]/g,
})
export type SinkCloseToken = typeof SinkCloseTokenSchema.Type

export const SinkDirLabelTokenSchema = loomNode('SinkDirLabel', {
  value: Schema.String,
}).pipe(
  Schema.filter((t) => {
    if (t.value === '' && t.health.status === 'ok') {
      return 'empty `value` requires non-ok `health.status`'
    }
    if (t.value !== '' && !/^[a-zA-Z0-9_\-./]+$/.test(t.value)) {
      return `sink directory label must match [a-zA-Z0-9_-./]+, got \`${t.value}\``
    }
    return true
  }),
)
export type SinkDirLabelToken = typeof SinkDirLabelTokenSchema.Type

export const SinkFileLabelTokenSchema = loomNode('SinkFileLabel', {
  value: Schema.String,
}).pipe(
  Schema.filter((t) => {
    if (t.value === '' && t.health.status === 'ok') {
      return 'empty `value` requires non-ok `health.status`'
    }
    if (t.value !== '' && !/^[a-zA-Z0-9_\-./]+$/.test(t.value)) {
      return `sink file label must match [a-zA-Z0-9_-./]+, got \`${t.value}\``
    }
    return true
  }),
)
export type SinkFileLabelToken = typeof SinkFileLabelTokenSchema.Type

export const SinkTokenSchema = loomNode('Sink', {
  open: SinkOpenTokenSchema,
  dir: SinkDirLabelTokenSchema,
  file: Schema.optional(SinkFileLabelTokenSchema),
  close: SinkCloseTokenSchema,
}).annotations({
  [Probe]: /\[[^\]]*\]/g,
})
export type SinkToken = typeof SinkTokenSchema.Type

export const ArrowTokenSchema = loomNode('Arrow', {}).annotations({
  [Probe]: /^\s*=>/,
})
export type ArrowToken = typeof ArrowTokenSchema.Type

export const TildeTokenSchema = loomNode('Tilde', {}).annotations({
  [Probe]: /^\s*~+/,
})
export type TildeToken = typeof TildeTokenSchema.Type

export const HeadingTitleTokenSchema = loomNode('HeadingTitle', {})
export type HeadingTitleToken = typeof HeadingTitleTokenSchema.Type

export const CodeTokenSchema = loomNode('Code', {}).annotations({
  [Probe]: /(?<=^\s*=>\s*)\S.*$/,
})
export type CodeToken = typeof CodeTokenSchema.Type

export const ProseTokenSchema = loomNode('Prose', {}).annotations({
  [Probe]: /(?<=^\s*~+\s*)\S.*$/,
})
export type ProseToken = typeof ProseTokenSchema.Type

export const WarpOpenTokenSchema = loomNode('WarpOpen', {
  value: Schema.Literal('{{'),
}).annotations({
  [Probe]: /\{\{/g,
})
export type WarpOpenToken = typeof WarpOpenTokenSchema.Type

export const WarpCloseTokenSchema = loomNode('WarpClose', {
  value: Schema.Literal('}}'),
}).annotations({
  [Probe]: /\}\}/g,
})
export type WarpCloseToken = typeof WarpCloseTokenSchema.Type

export const AnchorOpenTokenSchema = loomNode('AnchorOpen', {
  value: Schema.String,
}).annotations({
  [Probe]: /::\[/g,
})
export type AnchorOpenToken = typeof AnchorOpenTokenSchema.Type

export const AnchorCloseTokenSchema = loomNode('AnchorClose', {
  value: Schema.String,
})
export type AnchorCloseToken = typeof AnchorCloseTokenSchema.Type

export interface AnchorDelims {
  readonly open: string
  readonly close: string
}

export const defaultAnchorDelims: AnchorDelims = { open: '::' + '[', close: ']' }

export const WarpNameTokenSchema = loomNode('WarpName', {
  value: Schema.String,
}).pipe(
  Schema.filter((t) => {
    if (t.value === '' && t.health.status === 'ok') {
      return 'empty `value` requires non-ok `health.status`'
    }
    if (t.value !== '' && !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(t.value)) {
      return `warp name must be a TS identifier, got \`${t.value}\``
    }
    return true
  }),
)
export type WarpNameToken = typeof WarpNameTokenSchema.Type

export const WarpAnnotationTokenSchema = loomNode('WarpAnnotation', {
  value: Schema.String,
})
export type WarpAnnotationToken = typeof WarpAnnotationTokenSchema.Type

export const WarpDefaultTokenSchema = loomNode('WarpDefault', {
  value: Schema.String,
})
export type WarpDefaultToken = typeof WarpDefaultTokenSchema.Type

export const WarpAnchorNameTokenSchema = loomNode('WarpAnchorName', {
  value: Schema.String,
}).pipe(
  Schema.filter((t) => {
    if (t.value === '' && t.health.status === 'ok') {
      return 'empty `value` requires non-ok `health.status`'
    }
    if (t.value !== '' && t.value.includes(']')) {
      return `anchor name must not contain ], got \`${t.value}\``
    }
    return true
  }),
)
export type WarpAnchorNameToken = typeof WarpAnchorNameTokenSchema.Type

export const WarpAnchorTokenSchema = loomNode('WarpAnchor', {
  open: AnchorOpenTokenSchema,
  name: WarpAnchorNameTokenSchema,
  close: AnchorCloseTokenSchema,
  specifier: Schema.optional(
    Schema.Union(SpecifierTokenSchema, SinkTokenSchema),
  ),
}).annotations({
  [Probe]: /::\[[^\]]*\]/g,
})
export type WarpAnchorToken = typeof WarpAnchorTokenSchema.Type

export const WarpTokenSchema = loomNode('Warp', {
  open: WarpOpenTokenSchema,
  name: WarpNameTokenSchema,
  annotation: Schema.optional(WarpAnnotationTokenSchema),
  default: Schema.optional(WarpDefaultTokenSchema),
  close: WarpCloseTokenSchema,
}).annotations({
  [Probe]: /\{\{[^{}]*\}\}/g,
})
export type WarpToken = typeof WarpTokenSchema.Type

const suggestAnchorDelims = `Choose a distinct open that Loom does not use and that does not occur in your product code — for example \`${defaultAnchorDelims.open}\` and \`${defaultAnchorDelims.close}\` — in this package's loom.json.`

const reservedOpen: ReadonlyArray<string> = ['{{', '}}', '=>', '~', '#', '<', '>', '[', ']']

export class EmptyAnchorDelims extends Data.TaggedError('EmptyAnchorDelims')<{
  readonly open: string
  readonly close: string
}> {
  get message(): string {
    return `Anchor delimiters cannot be empty (got \`${this.open}\` and \`${this.close}\`). ${suggestAnchorDelims}`
  }
}

export class IdenticalAnchorDelims extends Data.TaggedError('IdenticalAnchorDelims')<{
  readonly delim: string
}> {
  get message(): string {
    return `Anchor open and close must differ; both are \`${this.delim}\`. A symmetric pair cannot be paired unambiguously. ${suggestAnchorDelims}`
  }
}

export class WhitespaceAnchorDelims extends Data.TaggedError('WhitespaceAnchorDelims')<{
  readonly open: string
  readonly close: string
}> {
  get message(): string {
    return `Anchor delimiters cannot contain whitespace (got \`${this.open}\` and \`${this.close}\`). ${suggestAnchorDelims}`
  }
}

export class ReservedAnchorDelims extends Data.TaggedError('ReservedAnchorDelims')<{
  readonly marker: string
}> {
  get message(): string {
    return `Anchor open \`${this.marker}\` is one of Loom's reserved markers. ${suggestAnchorDelims}`
  }
}

export type InvalidAnchorDelims =
  | EmptyAnchorDelims
  | IdenticalAnchorDelims
  | WhitespaceAnchorDelims
  | ReservedAnchorDelims

export const checkAnchorDelims = (
  delims: AnchorDelims,
): Effect.Effect<AnchorDelims, InvalidAnchorDelims> => {
  if (delims.open === '' || delims.close === '')
    return Effect.fail(
      new EmptyAnchorDelims({ open: delims.open, close: delims.close }),
    )
  if (delims.open === delims.close)
    return Effect.fail(new IdenticalAnchorDelims({ delim: delims.open }))
  if (/\s/.test(delims.open) || /\s/.test(delims.close))
    return Effect.fail(
      new WhitespaceAnchorDelims({ open: delims.open, close: delims.close }),
    )
  if (reservedOpen.includes(delims.open))
    return Effect.fail(new ReservedAnchorDelims({ marker: delims.open }))
  return Effect.succeed(delims)
}

export const LoomTokenSchema = Schema.Union(
  HeadingStartTokenSchema,
  SpecifierTokenSchema,
  SinkTokenSchema,
  ArrowTokenSchema,
  TildeTokenSchema,
  HeadingTitleTokenSchema,
  CodeTokenSchema,
  ProseTokenSchema,
  WarpTokenSchema,
  WarpAnchorTokenSchema,
)
export type LoomToken = typeof LoomTokenSchema.Type
