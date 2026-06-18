import { Option, Schema, SchemaAST } from 'effect'
import { HealthSchema, okHealth, PositionSchema } from '#ast/LoomNode'

export const RenderOrder: unique symbol = Symbol.for('loom/RenderOrder')

export const renderOrderOf = (
  schema: Schema.Schema.Any,
): Option.Option<ReadonlyArray<string>> =>
  SchemaAST.getAnnotation<ReadonlyArray<string>>(RenderOrder)(schema.ast)

const frameNode = <Tag extends string, Fields extends Schema.Struct.Fields>(
  tag: Tag,
  fields: Fields,
  order: ReadonlyArray<keyof Fields>,
) =>
  Schema.Struct({
    type: Schema.Literal(tag).pipe(
      Schema.propertySignature,
      Schema.withConstructorDefault(() => tag),
    ),
    health: HealthSchema.pipe(
      Schema.propertySignature,
      Schema.withConstructorDefault(() => okHealth),
    ),
    ...fields,
  }).annotations({ [RenderOrder]: order })

export const FrameSynthTokenSchema = frameNode(
  'FrameSynthToken',
  { text: Schema.String },
  ['text'],
)
export type FrameSynthToken = typeof FrameSynthTokenSchema.Type

const synth = (text: string) =>
  FrameSynthTokenSchema.pipe(
    Schema.propertySignature,
    Schema.withConstructorDefault(() => FrameSynthTokenSchema.make({ text })),
  )

export const SpanKindSchema = Schema.Literal('name', 'prose')
export type SpanKind = typeof SpanKindSchema.Type

export const FrameAuthoredTokenSchema = frameNode(
  'FrameAuthoredToken',
  { text: Schema.String, position: PositionSchema, kind: SpanKindSchema },
  ['text'],
)
export type FrameAuthoredToken = typeof FrameAuthoredTokenSchema.Type

export const FrameCodeSchema = frameNode(
  'FrameCode',
  { text: Schema.String, position: PositionSchema },
  ['text'],
)
export type FrameCode = typeof FrameCodeSchema.Type

export const ServiceNameSchema = Schema.Union(
  FrameAuthoredTokenSchema,
  FrameSynthTokenSchema,
)
export type ServiceName = typeof ServiceNameSchema.Type

export const EmbeddedCodeSchema = frameNode(
  'EmbeddedCode',
  { open: synth('`'), text: Schema.String, position: PositionSchema, close: synth('`') },
  ['open', 'text', 'close'],
)
export type EmbeddedCode = typeof EmbeddedCodeSchema.Type

export const ProseFragmentSchema = frameNode(
  'ProseFragment',
  { open: synth('`'), text: Schema.String, position: PositionSchema, close: synth('`') },
  ['open', 'text', 'close'],
)
export type ProseFragment = typeof ProseFragmentSchema.Type

export const CodeRefSchema = frameNode(
  'CodeRef',
  { binding: FrameAuthoredTokenSchema, dot: synth('.code') },
  ['binding', 'dot'],
)
export type CodeRef = typeof CodeRefSchema.Type

export const ProseRefSchema = frameNode(
  'ProseRef',
  { binding: FrameAuthoredTokenSchema, dot: synth('.prose') },
  ['binding', 'dot'],
)
export type ProseRef = typeof ProseRefSchema.Type

const ComposeArgSchema = Schema.Union(EmbeddedCodeSchema, CodeRefSchema)

export const ComposeArgItemSchema = frameNode(
  'ComposeArgItem',
  { sep: synth(', '), value: ComposeArgSchema },
  ['sep', 'value'],
)
export type ComposeArgItem = typeof ComposeArgItemSchema.Type

export const ComposeSchema = frameNode(
  'Compose',
  {
    open: synth('core.compose('),
    head: Schema.optional(ComposeArgSchema),
    tail: Schema.Array(ComposeArgItemSchema),
    close: synth(')'),
  },
  ['open', 'head', 'tail', 'close'],
)
export type Compose = typeof ComposeSchema.Type

const WeaveArgSchema = Schema.Union(ProseFragmentSchema, ProseRefSchema)

export const WeaveArgItemSchema = frameNode(
  'WeaveArgItem',
  { sep: synth(', '), value: WeaveArgSchema },
  ['sep', 'value'],
)
export type WeaveArgItem = typeof WeaveArgItemSchema.Type

export const WeaveSchema = frameNode(
  'Weave',
  {
    open: synth('core.weave('),
    head: Schema.optional(WeaveArgSchema),
    tail: Schema.Array(WeaveArgItemSchema),
    close: synth(')'),
  },
  ['open', 'head', 'tail', 'close'],
)
export type Weave = typeof WeaveSchema.Type

export const BindingSchema = frameNode(
  'Binding',
  {
    kw1: synth('const '),
    name: FrameAuthoredTokenSchema,
    kw2: synth(' = yield* '),
    tag: FrameAuthoredTokenSchema,
  },
  ['kw1', 'name', 'kw2', 'tag'],
)
export type Binding = typeof BindingSchema.Type

export const BindingItemSchema = frameNode(
  'BindingItem',
  { sep: synth('\n    '), value: BindingSchema },
  ['sep', 'value'],
)
export type BindingItem = typeof BindingItemSchema.Type

export const StaticBodySchema = frameNode(
  'StaticBody',
  {
    open: synth('{ succeed: { name: `'),
    name: FrameAuthoredTokenSchema,
    mid1: synth('`, code: '),
    code: ComposeSchema,
    mid2: synth(', prose: '),
    prose: WeaveSchema,
    close: synth(' } }'),
  },
  ['open', 'name', 'mid1', 'code', 'mid2', 'prose', 'close'],
)
export type StaticBody = typeof StaticBodySchema.Type

export const EffectfulBodySchema = frameNode(
  'EffectfulBody',
  {
    open: synth('{\n  effect: Effect.gen(function* () {'),
    bindings: Schema.Array(BindingItemSchema),
    mid1: synth('\n    return { name: `'),
    name: FrameAuthoredTokenSchema,
    mid2: synth('`, code: '),
    code: ComposeSchema,
    mid3: synth(', prose: '),
    prose: WeaveSchema,
    close: synth(' }\n  }),\n}'),
  },
  ['open', 'bindings', 'mid1', 'name', 'mid2', 'code', 'mid3', 'prose', 'close'],
)
export type EffectfulBody = typeof EffectfulBodySchema.Type

export const TangleBodySchema = frameNode(
  'TangleBody',
  {
    open: synth('{\n  effect: Effect.gen(function* () {'),
    bindings: Schema.Array(BindingItemSchema),
    mid1: synth('\n    return core.tangle("'),
    path: FrameAuthoredTokenSchema,
    mid2: synth('", '),
    code: ComposeSchema,
    close: synth(')\n  }),\n}'),
  },
  ['open', 'bindings', 'mid1', 'path', 'mid2', 'code', 'close'],
)
export type TangleBody = typeof TangleBodySchema.Type

export const ServiceBodySchema = Schema.Union(
  StaticBodySchema,
  EffectfulBodySchema,
  TangleBodySchema,
)
export type ServiceBody = typeof ServiceBodySchema.Type

export const ServiceClassSchema = frameNode(
  'ServiceClass',
  {
    doc1: synth('/** '),
    docPreamble: FrameAuthoredTokenSchema,
    doc2: synth(' */\n'),
    modifier: FrameSynthTokenSchema,
    kw1: synth('class '),
    name: ServiceNameSchema,
    kw2: synth(' extends Effect.Service<'),
    nameType: ServiceNameSchema,
    kw3: synth('>()("'),
    nameTag: ServiceNameSchema,
    kw4: synth('", '),
    body: ServiceBodySchema,
    kw5: synth(') {}'),
    languageId: Schema.String,
  },
  [
    'doc1', 'docPreamble', 'doc2', 'modifier', 'kw1', 'name', 'kw2',
    'nameType', 'kw3', 'nameTag', 'kw4', 'body', 'kw5',
  ],
)
export type ServiceClass = typeof ServiceClassSchema.Type

export const LayerRefSchema = frameNode(
  'LayerRef',
  { name: ServiceNameSchema, dot: synth('.Default') },
  ['name', 'dot'],
)
export type LayerRef = typeof LayerRefSchema.Type

export const LayerRefItemSchema = frameNode(
  'LayerRefItem',
  { sep: synth(',\n  '), value: LayerRefSchema },
  ['sep', 'value'],
)
export type LayerRefItem = typeof LayerRefItemSchema.Type

export const SinkRefSchema = frameNode(
  'SinkRef',
  { kw: synth('yield* '), name: ServiceNameSchema },
  ['kw', 'name'],
)
export type SinkRef = typeof SinkRefSchema.Type

export const SinkItemSchema = frameNode(
  'SinkItem',
  { sep: synth('\n    '), value: SinkRefSchema },
  ['sep', 'value'],
)
export type SinkItem = typeof SinkItemSchema.Type

export const RootSchema = frameNode(
  'Root',
  {
    open: synth('\n\nconst layers = Layer.mergeAll(\n  '),
    head: LayerRefSchema,
    tail: Schema.Array(LayerRefItemSchema),
    mid: synth(
      '\n)\n\nexport const LoomMain = Effect.provide(\n  Effect.gen(function* () {',
    ),
    sinks: Schema.Array(SinkItemSchema),
    close: synth('\n  }),\n  Layer.provide(layers, layers),\n)\n'),
  },
  ['open', 'head', 'tail', 'mid', 'sinks', 'close'],
)
export type Root = typeof RootSchema.Type

const MemberSchema = Schema.Union(ServiceClassSchema, FrameCodeSchema)

export const MemberItemSchema = frameNode(
  'MemberItem',
  { sep: synth('\n\n'), value: MemberSchema },
  ['sep', 'value'],
)
export type MemberItem = typeof MemberItemSchema.Type

export const FrameModuleSchema = frameNode(
  'FrameModule',
  {
    header: synth(
      'import * as core from "#loom/core"\nimport { Effect, Layer } from "effect"\n',
    ),
    imports: Schema.Array(FrameCodeSchema),
    members: Schema.Array(MemberItemSchema),
    root: Schema.optional(RootSchema),
  },
  ['header', 'imports', 'members', 'root'],
)
export type FrameModule = typeof FrameModuleSchema.Type