import { Array, Data, Effect, Match, Option, Result, Schema, pipe } from 'effect'
import { loomNode } from '#ast/LoomNode'

export const Probe = 'loom/Probe'

export const getProbe = (schema: Schema.Top): Option.Option<RegExp> =>
  Option.fromNullishOr(schema.ast.annotations?.[Probe] as RegExp | undefined)

export const HeadingStartTokenSchema = loomNode('HeadingStart', {}).annotate({
  [Probe]: /^#{1,6} /,
})
export type HeadingStartToken = typeof HeadingStartTokenSchema.Type

export const SpecifierOpenTokenSchema = loomNode('SpecifierOpen', {
  value: Schema.Literal('{'),
}).annotate({
  [Probe]: /\{/g,
})
export type SpecifierOpenToken = typeof SpecifierOpenTokenSchema.Type

export const SpecifierLabelTokenSchema = loomNode('SpecifierLabel', {
  value: Schema.String,
}).check(
  Schema.makeFilter((t) => {
    if (t.value === '' && t.health.status === 'ok') {
      return 'empty `value` requires non-ok `health.status`'
    }
    if (t.value !== '' && !/^[a-zA-Z0-9_-]+(?: [a-zA-Z0-9_-]+)*$/.test(t.value)) {
      return `specifier label value must be words of [a-zA-Z0-9_-]+, got \`${t.value}\``
    }
    return undefined
  }),
)
export type SpecifierLabelToken = typeof SpecifierLabelTokenSchema.Type

export const SpecifierCloseTokenSchema = loomNode('SpecifierClose', {
  value: Schema.Literal('}'),
}).annotate({
  [Probe]: /\}/g,
})
export type SpecifierCloseToken = typeof SpecifierCloseTokenSchema.Type

export const SpecifierTokenSchema = loomNode('Specifier', {
  open: SpecifierOpenTokenSchema,
  label: SpecifierLabelTokenSchema,
  close: SpecifierCloseTokenSchema,
}).annotate({
  [Probe]: /\{[a-zA-Z0-9_-]+(?: [a-zA-Z0-9_-]+)*\}/g,
})
export type SpecifierToken = typeof SpecifierTokenSchema.Type

export const ParameterKeyTokenSchema = loomNode('ParameterKey', {
  value: Schema.String,
})
export type ParameterKeyToken = typeof ParameterKeyTokenSchema.Type

export const ParameterValueTokenSchema = loomNode('ParameterValue', {
  value: Schema.String,
})
export type ParameterValueToken = typeof ParameterValueTokenSchema.Type

export const ParameterTokenSchema = loomNode('Parameter', {
  key: ParameterKeyTokenSchema,
  values: Schema.Array(ParameterValueTokenSchema),
})
export type ParameterToken = typeof ParameterTokenSchema.Type

export const ParametersTokenSchema = loomNode('Parameters', {
  open: SpecifierOpenTokenSchema,
  parameters: Schema.Array(ParameterTokenSchema),
  labels: Schema.Array(SpecifierLabelTokenSchema),
  close: SpecifierCloseTokenSchema,
})
export type ParametersToken = typeof ParametersTokenSchema.Type

export const parameterValue = (specifier: ParametersToken, key: string): Option.Option<string> =>
  pipe(
    Array.findFirst(specifier.parameters, (parameter) => parameter.key.value === key),
    Option.flatMap((parameter) => Array.head(parameter.values)),
    Option.map((value) => value.value),
  )

export const ScalarTypeSchema = Schema.Union([
  Schema.Literals(['text', 'number', 'boolean', 'locale', 'reference']),
  Schema.Struct({ choice: Schema.NonEmptyArray(Schema.NonEmptyString) }),
])
export type ScalarType = typeof ScalarTypeSchema.Type

export const ValueTypeSchema = Schema.Union([
  ScalarTypeSchema,
  Schema.Struct({ list: ScalarTypeSchema }),
])
export type ValueType = typeof ValueTypeSchema.Type

export const KeysSchema = Schema.Record(Schema.String, ValueTypeSchema)
export type Keys = typeof KeysSchema.Type

export const keyType = (keys: Keys, key: string): Option.Option<ValueType> =>
  pipe(
    Object.entries(keys),
    Array.findFirst(([name]) => name === key),
    Option.map(([, type]) => type),
  )

export const isList = (type: ValueType): type is { readonly list: ScalarType } =>
  typeof type === 'object' && 'list' in type

export const eachType = (type: ValueType): ScalarType => (isList(type) ? type.list : type)

export type Read = string | number | boolean

export type Unread =
  | { readonly wanted: 'number' }
  | { readonly wanted: 'locale' }
  | { readonly wanted: 'word'; readonly words: ReadonlyArray<string> }

type Choice = Extract<ScalarType, object>

const isChoice = (type: ScalarType): type is Choice => typeof type === 'object'

const unread = (wanted: Unread): Result.Result<never, Unread> => Result.fail(wanted)

const numeral = /^-?\d+(\.\d+)?$/

const wordAmong = (words: ReadonlyArray<string>, written: string): Result.Result<string, Unread> =>
  Array.contains(words, written) ? Result.succeed(written) : unread({ wanted: 'word', words })

const canonicalLocales = Option.liftThrowable((tag: string) => Intl.getCanonicalLocales(tag))

const localeNamed = (written: string): Result.Result<string, Unread> =>
  Option.match(Option.flatMap(canonicalLocales(written), Array.head), {
    onSome: (tag) => Result.succeed(tag),
    onNone: () => unread({ wanted: 'locale' }),
  })

export const readAs =
  (type: ScalarType) =>
  (written: string): Result.Result<Read, Unread> =>
    Match.value(type).pipe(
      Match.when(isChoice, (chosen) => wordAmong(chosen.choice, written)),
      Match.when('boolean', () =>
        Result.map(wordAmong(['true', 'false'], written), (word) => word === 'true'),
      ),
      Match.when('number', () =>
        numeral.test(written) ? Result.succeed(Number(written)) : unread({ wanted: 'number' }),
      ),
      Match.when('locale', () => localeNamed(written)),
      Match.whenOr('text', 'reference', () => Result.succeed(written)),
      Match.exhaustive,
    )

export const settleKind = 'To be settled'

export const moduleKind = 'Module'

export const anchorKinds: ReadonlyArray<string> = [settleKind, moduleKind]

export const formerAnchorKinds: ReadonlyArray<{ readonly was: string; readonly now: string }> = [
  { was: 'Reference', now: moduleKind },
]

export const renamedTo = (word: string): Option.Option<string> =>
  pipe(
    Array.findFirst(formerAnchorKinds, (kind) => Option.isSome(kindNamed([kind.was])(word))),
    Option.map((kind) => kind.now),
  )

export const anchorKeys: Keys = { kind: 'text', provides: { list: 'text' } }

export const tangleKind = 'Tangle'

export const conceptKind = 'Concept'

export const manifestKind = 'Manifest'

export const sectionKinds: ReadonlyArray<string> = [tangleKind, conceptKind, manifestKind]

export const headingKeys: Keys = { lang: 'text', kind: 'text' }

export const kindNamed =
  (kinds: ReadonlyArray<string>) =>
  (name: string): Option.Option<string> =>
    Array.findFirst(kinds, (kind) => kind.toLowerCase() === name.toLowerCase())

export const labelKey =
  (kinds: ReadonlyArray<string>) =>
  (label: string): 'kind' | 'lang' =>
    Option.isSome(kindNamed(kinds)(label)) ? 'kind' : 'lang'

export const headingLang = (held: ParametersToken): Option.Option<string> =>
  parameterValue(held, 'lang')

export const SinkOpenTokenSchema = loomNode('SinkOpen', {
  value: Schema.Literal('['),
}).annotate({
  [Probe]: /\[/g,
})
export type SinkOpenToken = typeof SinkOpenTokenSchema.Type

export const SinkCloseTokenSchema = loomNode('SinkClose', {
  value: Schema.Literal(']'),
}).annotate({
  [Probe]: /\]/g,
})
export type SinkCloseToken = typeof SinkCloseTokenSchema.Type

export const SinkFileLabelTokenSchema = loomNode('SinkFileLabel', {
  value: Schema.String,
}).check(
  Schema.makeFilter((t) => {
    if (t.value === '' && t.health.status === 'ok') {
      return 'empty `value` requires non-ok `health.status`'
    }
    if (t.value !== '' && !/^[a-zA-Z0-9_\-./]+$/.test(t.value)) {
      return `sink file label must match [a-zA-Z0-9_-./]+, got \`${t.value}\``
    }
    return undefined
  }),
)
export type SinkFileLabelToken = typeof SinkFileLabelTokenSchema.Type

export const SinkTokenSchema = loomNode('Sink', {
  open: SinkOpenTokenSchema,
  file: SinkFileLabelTokenSchema,
  close: SinkCloseTokenSchema,
}).annotate({
  [Probe]: /\[[^\]]*\]/g,
})
export type SinkToken = typeof SinkTokenSchema.Type

export const FrontmatterFenceTokenSchema = loomNode('FrontmatterFence', {}).annotate({
  [Probe]: /^---\s*$/,
})
export type FrontmatterFenceToken = typeof FrontmatterFenceTokenSchema.Type

export const FrontmatterPartTokenSchema = loomNode('FrontmatterPart', {
  value: Schema.String,
})
export type FrontmatterPartToken = typeof FrontmatterPartTokenSchema.Type

export const FrontmatterPartNameTokenSchema = loomNode('FrontmatterPartName', {
  value: Schema.String,
})
export type FrontmatterPartNameToken = typeof FrontmatterPartNameTokenSchema.Type

export const FrontmatterChapterTokenSchema = loomNode('FrontmatterChapter', {
  value: Schema.String,
})
export type FrontmatterChapterToken = typeof FrontmatterChapterTokenSchema.Type

export const FrontmatterDiscussionTokenSchema = loomNode('FrontmatterDiscussion', {
  value: Schema.String,
})
export type FrontmatterDiscussionToken = typeof FrontmatterDiscussionTokenSchema.Type

export const FrontmatterTropeTokenSchema = loomNode('FrontmatterTrope', {
  value: Schema.String,
})
export type FrontmatterTropeToken = typeof FrontmatterTropeTokenSchema.Type

export const FrontmatterEntryTokenSchema = loomNode('FrontmatterEntry', {
  value: Schema.String,
})
export type FrontmatterEntryToken = typeof FrontmatterEntryTokenSchema.Type

export const FrontmatterBookTokenSchema = loomNode('FrontmatterBook', {
  value: Schema.String,
})
export type FrontmatterBookToken = typeof FrontmatterBookTokenSchema.Type

export const FrontmatterTitleTokenSchema = loomNode('FrontmatterTitle', {
  value: Schema.String,
})
export type FrontmatterTitleToken = typeof FrontmatterTitleTokenSchema.Type

export const FrontmatterKeyTokenSchema = loomNode('FrontmatterKey', {
  value: Schema.String,
})
export type FrontmatterKeyToken = typeof FrontmatterKeyTokenSchema.Type

export const FrontmatterValueTokenSchema = loomNode('FrontmatterValue', {
  value: Schema.String,
})
export type FrontmatterValueToken = typeof FrontmatterValueTokenSchema.Type

export const ArrowTokenSchema = loomNode('Arrow', {}).annotate({
  [Probe]: /^\s*=>/,
})
export type ArrowToken = typeof ArrowTokenSchema.Type

export const TildeTokenSchema = loomNode('Tilde', {}).annotate({
  [Probe]: /^~(?=\s|$)/,
})
export type TildeToken = typeof TildeTokenSchema.Type

export const HeadingTitleTokenSchema = loomNode('HeadingTitle', {})
export type HeadingTitleToken = typeof HeadingTitleTokenSchema.Type

export const CodeTokenSchema = loomNode('Code', {}).annotate({
  [Probe]: /(?<=^\s*=>\s*)\S.*$/,
})
export type CodeToken = typeof CodeTokenSchema.Type

export const ProseTokenSchema = loomNode('Prose', {}).annotate({
  [Probe]: /(?<=^~\s+)\S.*$/,
})
export type ProseToken = typeof ProseTokenSchema.Type

export const CodeFenceTokenSchema = loomNode('CodeFence', {}).annotate({
  [Probe]: /^[ \t]*`{3,}/,
})
export type CodeFenceToken = typeof CodeFenceTokenSchema.Type

export const FenceLabelTokenSchema = loomNode('FenceLabel', {})
export type FenceLabelToken = typeof FenceLabelTokenSchema.Type

export type Fence = { readonly length: number; readonly column: number }

const fencePattern = /^([ \t]*)(`{3,})/

export const openingFence = (line: string): Option.Option<Fence> =>
  Option.map(Option.fromNullishOr(fencePattern.exec(line)), (m) => ({
    length: m[2]!.length,
    column: m[1]!.length,
  }))

export const closesFence =
  (fence: Fence) =>
  (line: string): boolean =>
    Option.exists(
      openingFence(line),
      (found) =>
        found.column === fence.column &&
        found.length >= fence.length &&
        line.slice(found.column + found.length).trim() === '',
    )

export const BoxFenceTokenSchema = loomNode('BoxFence', {}).annotate({
  [Probe]: /^[ \t]*:{3,}/,
})
export type BoxFenceToken = typeof BoxFenceTokenSchema.Type

export const BoxNameTokenSchema = loomNode('BoxName', {
  value: Schema.String,
})
export type BoxNameToken = typeof BoxNameTokenSchema.Type

export const BoxTokenSchema = loomNode('Box', {
  side: Schema.Literals(['open', 'close', 'stray']),
  fence: BoxFenceTokenSchema,
  name: Schema.optional(BoxNameTokenSchema),
  specifier: Schema.optional(Schema.Union([SpecifierTokenSchema, ParametersTokenSchema])),
})
export type BoxToken = typeof BoxTokenSchema.Type

export const noteKind = 'Note'

export const chapterKind = 'Chapter'

export const discussionKind = 'Discussion'

export const tropeKind = 'Trope'

export const conclusionKind = 'Conclusion'

export const boxKinds: ReadonlyArray<string> = [
  noteKind,
  chapterKind,
  discussionKind,
  tropeKind,
  conclusionKind,
]

export type LoomKind = typeof chapterKind | typeof discussionKind

export const isLoomKind = (kind: string): kind is LoomKind =>
  kind === chapterKind || kind === discussionKind

export type PointingKind = LoomKind | typeof tropeKind

export const isPointingKind = (kind: string): kind is PointingKind =>
  isLoomKind(kind) || kind === tropeKind

export const boxKeys: Keys = {
  kind: 'text',
  provides: { list: 'text' },
  anchors: 'reference',
}

export const specifierKind = (specifier: SpecifierToken | ParametersToken): Option.Option<string> =>
  Match.value(specifier).pipe(
    Match.when({ type: 'Specifier' }, (labelled) => Option.some(labelled.label.value)),
    Match.when({ type: 'Parameters' }, (held) => parameterValue(held, 'kind')),
    Match.exhaustive,
  )

const knownBoxKind = (kind: string): string =>
  Option.getOrElse(
    Array.findFirst(boxKinds, (known) => known.toLowerCase() === kind.toLowerCase()),
    () => kind,
  )

export const boxKind = (box: BoxToken): string =>
  pipe(
    Option.fromNullishOr(box.specifier),
    Option.flatMap(specifierKind),
    Option.map(knownBoxKind),
    Option.getOrElse(() => noteKind),
  )

export const DividerTokenSchema = loomNode('Divider', {}).annotate({
  [Probe]: /^-{3,}\s*$/,
})
export type DividerToken = typeof DividerTokenSchema.Type

export const WarpOpenTokenSchema = loomNode('WarpOpen', {
  value: Schema.Literal('{{'),
}).annotate({
  [Probe]: /\{\{/g,
})
export type WarpOpenToken = typeof WarpOpenTokenSchema.Type

export const WarpCloseTokenSchema = loomNode('WarpClose', {
  value: Schema.Literal('}}'),
}).annotate({
  [Probe]: /\}\}/g,
})
export type WarpCloseToken = typeof WarpCloseTokenSchema.Type

export const AnchorOpenTokenSchema = loomNode('AnchorOpen', {
  value: Schema.String,
}).annotate({
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
}).check(
  Schema.makeFilter((t) => {
    if (t.value === '' && t.health.status === 'ok') {
      return 'empty `value` requires non-ok `health.status`'
    }
    if (t.value !== '' && !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(t.value)) {
      return `warp name must be a TS identifier, got \`${t.value}\``
    }
    return undefined
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
}).check(
  Schema.makeFilter((t) => {
    if (t.value === '' && t.health.status === 'ok') {
      return 'empty `value` requires non-ok `health.status`'
    }
    if (t.value !== '' && t.value.includes(']')) {
      return `anchor name must not contain ], got \`${t.value}\``
    }
    return undefined
  }),
)
export type WarpAnchorNameToken = typeof WarpAnchorNameTokenSchema.Type

export const WarpAnchorTargetTokenSchema = loomNode('WarpAnchorTarget', {
  value: Schema.String,
})
export type WarpAnchorTargetToken = typeof WarpAnchorTargetTokenSchema.Type

export const WarpAnchorTokenSchema = loomNode('WarpAnchor', {
  open: AnchorOpenTokenSchema,
  name: WarpAnchorNameTokenSchema,
  close: AnchorCloseTokenSchema,
  target: Schema.optional(WarpAnchorTargetTokenSchema),
  specifier: Schema.optional(Schema.Union([SpecifierTokenSchema, ParametersTokenSchema])),
}).annotate({
  [Probe]: /::\[[^\]]*\](?:\([^)]*\))?/g,
})
export type WarpAnchorToken = typeof WarpAnchorTokenSchema.Type

export const WarpTokenSchema = loomNode('Warp', {
  open: WarpOpenTokenSchema,
  name: WarpNameTokenSchema,
  annotation: Schema.optional(WarpAnnotationTokenSchema),
  default: Schema.optional(WarpDefaultTokenSchema),
  close: WarpCloseTokenSchema,
}).annotate({
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
  EmptyAnchorDelims | IdenticalAnchorDelims | WhitespaceAnchorDelims | ReservedAnchorDelims

export const checkAnchorDelims = (
  delims: AnchorDelims,
): Effect.Effect<AnchorDelims, InvalidAnchorDelims> => {
  if (delims.open === '' || delims.close === '')
    return Effect.fail(new EmptyAnchorDelims({ open: delims.open, close: delims.close }))
  if (delims.open === delims.close)
    return Effect.fail(new IdenticalAnchorDelims({ delim: delims.open }))
  if (/\s/.test(delims.open) || /\s/.test(delims.close))
    return Effect.fail(new WhitespaceAnchorDelims({ open: delims.open, close: delims.close }))
  if (reservedOpen.includes(delims.open))
    return Effect.fail(new ReservedAnchorDelims({ marker: delims.open }))
  return Effect.succeed(delims)
}

export const LoomTokenSchema = Schema.Union([
  HeadingStartTokenSchema,
  SpecifierTokenSchema,
  SinkTokenSchema,
  FrontmatterFenceTokenSchema,
  FrontmatterPartTokenSchema,
  FrontmatterPartNameTokenSchema,
  FrontmatterChapterTokenSchema,
  FrontmatterTitleTokenSchema,
  FrontmatterKeyTokenSchema,
  FrontmatterValueTokenSchema,
  ArrowTokenSchema,
  TildeTokenSchema,
  HeadingTitleTokenSchema,
  CodeTokenSchema,
  ProseTokenSchema,
  CodeFenceTokenSchema,
  FenceLabelTokenSchema,
  BoxFenceTokenSchema,
  BoxNameTokenSchema,
  BoxTokenSchema,
  DividerTokenSchema,
  WarpTokenSchema,
  WarpAnchorTokenSchema,
])
export type LoomToken = typeof LoomTokenSchema.Type
