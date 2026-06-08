import { Option, Schema, SchemaAST } from 'effect'
import { HealthSchema, okHealth, PositionSchema } from '#ast/LoomNode'

// =============================================================================
// FrameAst — the Frame AST: output of the `FrameAstBuilder` pass, input to `fromFrame`.
//
// LoomAst is parsed (source → tree); FrameAst is generated (tree → TypeScript
// frame + source mappings). Every byte of the frame is a *typed token* — there
// are no bare-string siblings.
//
// Tokens, by origin:
//   - FrameSynthToken  { text }                predefined glue; no position, never
//                                              mapped. Written `synth('…')`; the
//                                              constructor fills it, so the pass
//                                              supplies only the holes.
//   - FrameAuthoredToken { text, position, kind } frame token (name / prose), mapped
//   - FrameCode          { text, position }       frame raw block ({Loom}), mapped
//   - EmbeddedCode  `text` position               product block (=> code), mapped
//
// Mapping belongs to authored leaves: a leaf maps iff it carries `position`.
// `kind` (name | prose) selects which features the LSP forwards. A `name` is a
// const/class identifier the frame generates; it maps back to the source `label`
// (a tag, an anchor) or name (a Warp local) that introduced it. `prose` is title
// / preamble text.
//
// Render order is *explicit*, not positional: each node carries a `RenderOrder`
// annotation — the ordered list of fields the renderer emits. Fields absent from
// it are metadata (`type`, `health`, `position`, `kind`, `languageId`): never
// emitted, though a
// leaf's `text` maps via its sibling `position`. Reordering a struct cannot change
// output; the order is written by hand (metadata simply omitted), and the test
// suite checks it covers exactly the renderable fields.
//
// Health is two-tier: grammatical health lives on the Loom AST (parse); the
// `health` here carries semantic findings discovered by the frame pass (tag-on-
// {Loom}, cross-specifier edge, cycle, unresolved anchor) and rides the mapping
// back to source. It defaults to ok.
//
// Offsets are derived, not stored: the `fromFrame` walk threads a cursor; a token's
// gen range is [cursor, cursor + text.length).
//
// Separators are schema-owned, never renderer-applied. A separated list is a
// `head` plus a `tail` of Item nodes, each carrying its `sep` synth before the
// `value`; a possibly-empty list is an array of Item nodes whose leading `sep`
// also detaches it from what precedes. `.make` fills a node's own synth defaults
// but not those of nested array elements, so Items are built bottom-up.
//
// The hierarchy is a DAG — FrameModule → ServiceClass → body → Compose → leaves
// — defined bottom-up, no recursion, no `suspend`. Synth literals are
// single-quoted: frame fragments routinely contain `"` (tags, imports).
// =============================================================================

// RenderOrder — the ordered list of a node's renderable fields. Read by the
// renderer (`fromFrame`); attached by `frameNode`.
export const RenderOrder: unique symbol = Symbol.for('loom/RenderOrder')

export const renderOrderOf = (
  schema: Schema.Schema.Any,
): Option.Option<ReadonlyArray<string>> =>
  SchemaAST.getAnnotation<ReadonlyArray<string>>(RenderOrder)(schema.ast)

// frameNode — adds `type` and `health` (semantic, default ok), and pins the
// explicit `order` of renderable fields as a `RenderOrder` annotation. The order
// is written by hand; metadata (`position`, `kind`, `languageId`) is simply left
// out of it. That the order lists *exactly* the renderable fields — all of them,
// none of the metadata — is checked by the test suite (FrameAst.test.ts), the one
// guard that matters; the param type only keeps entries to real field names.
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

// =============================================================================
// FrameSynthToken — a predefined glue token. `synth(text)` is a field of this
// type whose value the constructor fills, so the frame pass omits it entirely.
// =============================================================================

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

// =============================================================================
// Authored leaves — text lifted from the .loom, mapped back to it.
// =============================================================================

export const SpanKindSchema = Schema.Literal('name', 'prose')
export type SpanKind = typeof SpanKindSchema.Type

// FrameAuthoredToken — a generated frame token (a const/class `name`, or a prose
// span) resolved from the .loom. `kind` selects which LSP features Volar forwards.
export const FrameAuthoredTokenSchema = frameNode(
  'FrameAuthoredToken',
  { text: Schema.String, position: PositionSchema, kind: SpanKindSchema },
  ['text'],
)
export type FrameAuthoredToken = typeof FrameAuthoredTokenSchema.Type

// FrameCode — a {Loom} block: raw de dicto frame code, spliced verbatim and
// undelimited; always TypeScript, mapping into the frame virtual code.
export const FrameCodeSchema = frameNode(
  'FrameCode',
  { text: Schema.String, position: PositionSchema },
  ['text'],
)
export type FrameCode = typeof FrameCodeSchema.Type

// ServiceName — a service's name wherever it appears in the frame: the
// class name, the `<…>` type param, the `"…"` service tag, and each `.Default` /
// `yield*` reference. Authored when the section is tagged — the name is the
// `[Tag]` label, mapped to that span; a FrameSynthToken when tagless — the name
// is a synthesised hash, pure glue with no `.loom` origin, so it is never mapped.
// (A by-name *anchor* is different: its ref maps to the author-written label, so
// it stays a FrameAuthoredToken even when the resolved text is a hash.)
export const ServiceNameSchema = Schema.Union(
  FrameAuthoredTokenSchema,
  FrameSynthTokenSchema,
)
export type ServiceName = typeof ServiceNameSchema.Type

// EmbeddedCode — a => block: de re product code, backtick-delimited as a compose
// argument; maps into the section's product virtual code. The backticks are
// FrameSynthToken siblings; `text`/`position` are the mapped product span.
export const EmbeddedCodeSchema = frameNode(
  'EmbeddedCode',
  {
    open: synth('`'),
    text: Schema.String,
    position: PositionSchema,
    close: synth('`'),
  },
  ['open', 'text', 'close'],
)
export type EmbeddedCode = typeof EmbeddedCodeSchema.Type

// =============================================================================
// Code composition.
// =============================================================================

// CodeRef — a resolved anchor: `m.code`. `binding` maps back to the anchor.
export const CodeRefSchema = frameNode(
  'CodeRef',
  { binding: FrameAuthoredTokenSchema, dot: synth('.code') },
  ['binding', 'dot'],
)
export type CodeRef = typeof CodeRefSchema.Type

// Compose — `compose(arg, arg, …)`: quoted product fragments (EmbeddedCode) or
// resolved references (CodeRef), in source order, comma-separated. Empty —
// `compose()`, `head` absent — for a section with no code (prose-only).
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

// =============================================================================
// Effectful plumbing — one lazy `yield*` per dependency (no `dependencies`
// array; order-independent).
// =============================================================================

// Binding — `const m = yield* Mul`. Both names map back to the Warp.
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

// =============================================================================
// Service bodies — the argument to Effect.Service(). Synth literals own the
// surrounding punctuation and the backticks around `name` / `preamble`.
// =============================================================================

// StaticBody — no Warps: a `succeed` object.
export const StaticBodySchema = frameNode(
  'StaticBody',
  {
    open: synth('{ succeed: { name: `'),
    name: FrameAuthoredTokenSchema,
    mid1: synth('`, preamble: `'),
    preamble: FrameAuthoredTokenSchema,
    mid2: synth('`, code: '),
    code: ComposeSchema,
    close: synth(' } }'),
  },
  ['open', 'name', 'mid1', 'preamble', 'mid2', 'code', 'close'],
)
export type StaticBody = typeof StaticBodySchema.Type

// EffectfulBody — has dependencies: `Effect.gen` yielding each, then returning
// the triple. `bindings` is a `0..n` list (each `BindingItem` owns its leading
// `\n    `, so `open` ends at the brace and the binding-less shape is moot here —
// a section with no binding is a `StaticBody`).
export const EffectfulBodySchema = frameNode(
  'EffectfulBody',
  {
    open: synth('{\n  effect: Effect.gen(function* () {'),
    bindings: Schema.Array(BindingItemSchema),
    mid1: synth('\n    return { name: `'),
    name: FrameAuthoredTokenSchema,
    mid2: synth('`, preamble: `'),
    preamble: FrameAuthoredTokenSchema,
    mid3: synth('`, code: '),
    code: ComposeSchema,
    close: synth(' }\n  }),\n}'),
  },
  ['open', 'bindings', 'mid1', 'name', 'mid2', 'preamble', 'mid3', 'code', 'close'],
)
export type EffectfulBody = typeof EffectfulBodySchema.Type

// TangleBody — a {path} sink: yields its dependencies (a `0..n` binding list —
// a literal-only or all-resolved tangle has none), returns `tangle(path, …)`.
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

// =============================================================================
// ServiceClass — one Section → one Effect.Service class. The preamble emits
// twice from one source: a `/** … */` TSDoc block above the class, and the
// `name` / `preamble` fields in the body. `modifier` is a FrameSynthToken the
// frame pass fills with `export ` (tagged) or `` (tagless). `name` appears three
// times (class name, type param, service tag) as a `ServiceName`: each a distinct
// generated occurrence mapping back to the `[Tag]` label when the section is
// tagged, or a synth hash (unmapped) when tagless.
// =============================================================================

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
    // languageId — metadata: the section's product language (the `{{lang}}`
    // default or a `{specifier}`), carried for the de re ProductAstBuilder. Never
    // emitted into the frame (excluded from the render order).
    languageId: Schema.String,
  },
  [
    'doc1', 'docPreamble', 'doc2', 'modifier', 'kw1', 'name', 'kw2',
    'nameType', 'kw3', 'nameTag', 'kw4', 'body', 'kw5',
  ],
)
export type ServiceClass = typeof ServiceClassSchema.Type

// =============================================================================
// Composition root — generated for any file with Services; absent for a
// service-less file (empty, or only {Loom} blocks). `layers` merges every
// Service's `.Default`; `LoomMain` runs the tangle sinks and provides the merge
// to itself (self-wiring; order-free). Service and sink names map back to their
// sections. A library file with no sinks still merges and self-provides —
// `sinks` empty.
// =============================================================================

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

// =============================================================================
// FrameModule — the root node. `header` is the fixed import preamble; `imports`
// are the cross-file lines hoisted from {Loom} sections (each a FrameCode line
// ending in a newline); `members` are the Services and {Loom} blocks in document
// order, blank-line separated; `root` is the composition root, absent when the
// file has no Services (an empty or {Loom}-only file). An empty `.loom` is a
// valid file — header and nothing else.
// =============================================================================

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
