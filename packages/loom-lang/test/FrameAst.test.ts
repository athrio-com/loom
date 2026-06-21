import { describe, expect, it } from '@effect/vitest'
import { Option, Schema, SchemaAST } from 'effect'
import * as FrameAst from '#ast/FrameAst'
import {
  ComposeArgItemSchema,
  ComposeSchema,
  EmbeddedCodeSchema,
  FrameAuthoredTokenSchema,
  FrameModuleSchema,
  FrameSynthTokenSchema,
  MemberItemSchema,
  ProseFragmentSchema,
  renderOrderOf,
  RootSchema,
  ServiceClassSchema,
  StaticBodySchema,
  WeaveArgItemSchema,
  WeaveSchema,
} from '#ast/FrameAst'

// Probe: the Frame AST constructs from the holes alone — every synth token and
// `health` auto-fills — and every child is a typed node (no bare strings).
// Separated lists are built bottom-up: an Item's `sep` fills at its own `.make`.
// The runnable frame's leaves are positioned core calls, so a fragment carries an
// `origin` literal and a compose call its identity and language.

const pos = (start: number, end: number) => ({
  start: { line: 1, offset: start },
  end: { line: 1, offset: end },
})

const tok = (text: string) => FrameSynthTokenSchema.make({ text })

const id = (text: string) =>
  FrameAuthoredTokenSchema.make({
    text,
    position: pos(0, text.length),
    kind: 'name',
  })

const prose = (text: string) =>
  FrameAuthoredTokenSchema.make({
    text,
    position: pos(0, text.length),
    kind: 'prose',
  })

const embedded = (text: string) =>
  EmbeddedCodeSchema.make({
    text,
    position: pos(0, text.length),
    origin: tok('{}'),
  })

const compose = (...args: ReadonlyArray<ReturnType<typeof embedded>>) =>
  ComposeSchema.make({
    origin: tok('{ path: "/x", name: "Add" }'),
    lang: tok('"typescript"'),
    args: args.map((value) => ComposeArgItemSchema.make({ value })),
  })

const weave = (text: string) =>
  WeaveSchema.make({
    origin: tok('{ path: "/x", name: "Add" }'),
    args: [
      WeaveArgItemSchema.make({
        value: ProseFragmentSchema.make({
          text,
          position: pos(0, text.length),
          origin: tok('{}'),
        }),
      }),
    ],
  })

describe('FrameAst — construction', () => {
  it('auto-fills type and health on an authored leaf', () => {
    const t = id('Add')
    expect(t.type).toBe('FrameAuthoredToken')
    expect(t.health.status).toBe('ok')
  })

  it('auto-fills synth tokens as typed siblings', () => {
    const c = compose(embedded('x'))
    expect(c.open.type).toBe('FrameSynthToken')
    expect(c.open.text).toBe('core.compose(')
    expect(c.close.text).toBe(')')
    expect(embedded('x').open.text).toBe('core.fragment(`') // a fragment is a core call
  })

  it('auto-fills the separator inside an Item built bottom-up', () => {
    const item = ComposeArgItemSchema.make({ value: embedded('y') })
    expect(item.sep.type).toBe('FrameSynthToken')
    expect(item.sep.text).toBe(', ')
  })

  it('pins an explicit render order on each node (not field position)', () => {
    expect(Option.getOrThrow(renderOrderOf(ComposeSchema))).toEqual([
      'open',
      'origin',
      'mid',
      'lang',
      'args',
      'close',
    ])
    expect(Option.getOrThrow(renderOrderOf(EmbeddedCodeSchema))).toEqual([
      'open',
      'text',
      'mid',
      'origin',
      'close',
    ])
    // position / kind are metadata — excluded from the render order.
    expect(Option.getOrThrow(renderOrderOf(FrameAuthoredTokenSchema))).toEqual([
      'text',
    ])
  })

  it('RenderOrder covers exactly the renderable fields of every node', () => {
    const META = new Set(['type', 'health', 'position', 'kind', 'languageId'])
    // Effect schemas are callable (typeof 'function') with an `.ast`.
    const isSchema = (v: unknown): v is Schema.Schema<any, any, never> =>
      v != null &&
      (typeof v === 'object' || typeof v === 'function') &&
      'ast' in v
    const schemas = (Object.values(FrameAst) as ReadonlyArray<unknown>).filter(
      isSchema,
    )
    let checked = 0
    for (const schema of schemas) {
      const order = renderOrderOf(schema)
      if (Option.isNone(order)) continue // unions / literals are not frameNodes
      const ast = schema.ast as SchemaAST.TypeLiteral
      const renderable = ast.propertySignatures
        .map((p) => String(p.name))
        .filter((f) => !META.has(f))
      expect([...order.value].sort()).toEqual([...renderable].sort())
      checked += 1
    }
    expect(checked).toBeGreaterThan(15) // it actually visited the nodes
  })

  it('constructs a complete trivial FrameModule', () => {
    const body = StaticBodySchema.make({
      name: prose('Adder'),
      code: compose(embedded('export const add = …')),
      prose: weave('Adds two integers.'),
    })
    const service = ServiceClassSchema.make({
      modifier: FrameSynthTokenSchema.make({ text: 'export ' }),
      name: id('Add'),
      nameType: id('Add'),
      nameTag: id('Add'),
      body,
      languageId: 'typescript',
    })
    const root = RootSchema.make({
      services: tok('{ Add: { layer: Add.Default, deps: [] } }'),
      run: tok('Effect.gen(function* () {})'),
    })
    const frame = FrameModuleSchema.make({
      imports: [],
      members: [MemberItemSchema.make({ value: service })],
      root,
    })

    expect(frame.type).toBe('FrameModule')
    expect(frame.header.text).toContain('#loom/core')
    expect(frame.root?.open.text).toContain('__services')
    expect(frame.members[0].value.type).toBe('ServiceClass')
    expect(frame.members[0].sep.text).toBe('\n\n')
  })

  it('renders empty code as compose(id, "lang") — no arguments', () => {
    const c = compose()
    expect(c.args).toEqual([])
    expect(c.open.text).toBe('core.compose(')
    expect(c.lang.text).toBe('"typescript"')
  })

  it('a service-less file is valid — no root', () => {
    const empty = FrameModuleSchema.make({ imports: [], members: [] })
    expect(empty.root).toBeUndefined()
    expect(empty.members).toEqual([])
    expect(empty.header.text).toContain('#loom/core')
  })
})
