import { describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import { parseDocument, ParseLayer } from './parse'
import type {
  CodeRef,
  EffectfulBody,
  EmbeddedCode,
  FrameAuthoredToken,
  ProseFragment,
  ServiceClass,
  StaticBody,
} from '#ast/FrameAst'
import { buildFrame } from '#ast/FrameAstBuilder'

// A ServiceName is authored (tagged → mapped to the `[Tag]`) or synth (tagless →
// the title-derived name, unmapped). Tests asserting a mapped position narrow to
// the authored case first.
const asAuthored = (t: ServiceClass['name']): FrameAuthoredToken => {
  if (t.type !== 'FrameAuthoredToken') {
    throw new Error(`expected an authored token, got ${t.type}`)
  }
  return t
}

// buildFrame over the trivial fixture: one tagged, static section, no Warps.
// Assertions are structural (no renderer yet) — the right nodes, fields, and
// source mappings.

const input = `{{lang: TypeScript}}

# Adder [Add]

Adds two integers.

=>

export const add = (x: number, y: number): number => x + y
`

const parse = (src: string) =>
  Effect.runSync(parseDocument(src).pipe(Effect.provide(ParseLayer)))

describe('buildFrame — trivial section → FrameModule', () => {
  const frame = buildFrame(parse(input))

  it('produces one exported ServiceClass named after the tag', () => {
    expect(frame.type).toBe('FrameModule')
    expect(frame.members).toHaveLength(1)
    const member = frame.members[0]!.value
    expect(member.type).toBe('ServiceClass')
    const svc = member as ServiceClass
    expect(svc.modifier.text).toBe('export ')
    expect(svc.name.text).toBe('Add')
    expect(svc.nameType.text).toBe('Add')
    expect(svc.nameTag.text).toBe('Add')
  })

  it('maps title → name, preamble → woven prose, code → compose', () => {
    const svc = frame.members[0]!.value as ServiceClass
    expect(svc.body.type).toBe('StaticBody')
    const body = svc.body as StaticBody
    expect(body.name.text).toBe('Adder')
    const proseHead = body.prose.head as ProseFragment
    expect(proseHead.type).toBe('ProseFragment')
    expect(proseHead.text).toContain('Adds two integers.')
    expect(body.code.head?.type).toBe('EmbeddedCode')
    const head = body.code.head as EmbeddedCode
    expect(head.text).toContain('export const add = (x: number, y: number)')
    expect(body.code.tail).toHaveLength(0)
  })

  it('synthesises a Root merging the one service, no sinks', () => {
    expect(frame.root?.type).toBe('Root')
    expect(frame.root?.head.name.text).toBe('Add')
    expect(frame.root?.tail).toHaveLength(0)
    expect(frame.root?.sinks).toHaveLength(0)
  })

  it('maps the class name to the [Add] tag; the field name is a synth display string', () => {
    const svc = frame.members[0]!.value as ServiceClass
    const body = svc.body as StaticBody
    // class name ⇒ the tag label inside `[Add]`, not the title "Adder"
    expect(asAuthored(svc.name).position.start.offset).toBe(
      input.indexOf('[Add]') + 1,
    )
    // the `name:` field carries the title text but is unmapped — a display
    // string, not a navigation target (mapping it self-references the heading)
    expect(body.name.type).toBe('FrameSynthToken')
    expect(body.name.text).toBe('Adder')
  })
})

describe('buildFrame — mapped spans hug the inner payload, not delimiters', () => {
  const src = `{{lang: TypeScript}}

# Helper [Help]

=>

export const help = 1

# Main [Main]

{{h: Help}}

=>

main = {{h}}
`
  const frame = buildFrame(parse(src))
  const main = frame.members
    .map((m) => m.value)
    .find(
      (v): v is ServiceClass =>
        v.type === 'ServiceClass' && v.name.text === 'Main',
    )!
  const body = main.body as EffectfulBody
  const binding = body.bindings[0]!.value // the one Warp, `{{h: Help}}`
  const at = (p: { start: { offset: number }; end: { offset: number } }) =>
    src.slice(p.start.offset, p.end.offset)

  it('a Warp binds name and annotation to the inner spans of {{name: Tag}}', () => {
    expect(binding.name.text).toBe('h')
    expect(at(binding.name.position)).toBe('h') // not "{{h: Help}}"
    // a Warp's tag is authored — it maps to the `Help` annotation span
    const tag = binding.tag
    expect(tag.type).toBe('FrameAuthoredToken')
    if (tag.type !== 'FrameAuthoredToken') return
    expect(tag.text).toBe('Help')
    expect(at(tag.position)).not.toMatch(/[{}]/) // no delimiters
    expect(at(tag.position)).toContain('Help')
  })

  it('a code anchor binds to the inner name of {{name}}, not the braces', () => {
    const args = [body.code.head, ...body.code.tail.map((t) => t.value)]
    const ref = args.find((a) => a?.type === 'CodeRef') as CodeRef
    expect(ref.binding.text).toBe('h')
    expect(at(ref.binding.position)).toBe('h') // not "{{h}}"
    expect(ref.binding.position.start.offset).toBe(src.lastIndexOf('{{h}}') + 2)
  })
})

describe('buildFrame — inline-arrow and multi-chunk code reach the compose', () => {
  // `=> code` inline, and a `=> … ~ … => …` body (Code/Prose alternation) must
  // both compose — the chunks join, the interleaved prose drops.
  const src = `{{lang: TypeScript}}

# Inline [Inline]

=> export const a = 1

# Multi [Multi]

=>
const b = 2
~
prose between — not code
=>
const c = 3
`
  const frame = buildFrame(parse(src))
  const composed = (name: string): string => {
    const svc = frame.members
      .map((m) => m.value)
      .find(
        (v): v is ServiceClass =>
          v.type === 'ServiceClass' && v.name.text === name,
      )!
    const { code } = svc.body as StaticBody
    const args =
      code.head === undefined
        ? code.tail.map((t) => t.value)
        : [code.head, ...code.tail.map((t) => t.value)]
    return args
      .filter((a): a is EmbeddedCode => a.type === 'EmbeddedCode')
      .map((e) => e.text)
      .join('')
  }

  it('takes an inline `=>` payload into the compose', () => {
    expect(composed('Inline')).toContain('export const a = 1')
  })

  it('composes every `=>` chunk and drops the interleaved prose', () => {
    const code = composed('Multi')
    expect(code).toContain('const b = 2')
    expect(code).toContain('const c = 3')
    expect(code).not.toContain('prose between')
  })
})

describe('buildFrame — an anchor refers to its section heading; a tangle is language-agnostic', () => {
  // A tagless section's class name is synthetic glue (no source span). A name
  // anchor reaches the section through the hoisted `const _N = yield* N` binding:
  // the alias maps to the heading (the definition), `yield* N` is synth glue, and
  // each `_N.code` reference maps to the anchor (the referencer). A tangle has no
  // language of its own; it is marked `Loom`, never the `{{lang}}` default nor the path.
  const src = `{{lang: TypeScript}}

# Helper

=>

const helper = 1

# Bundle it {dist/bundle.sh}

=>

{{Helper}}
`
  const services = buildFrame(parse(src))
    .members.map((m) => m.value)
    .filter((v): v is ServiceClass => v.type === 'ServiceClass')
  const helper = services.find((v) => v.body.type === 'StaticBody')!
  const tangle = services.find((v) => v.body.type === 'TangleBody')!

  it('names a tagless section with a synth name (glue, unmapped)', () => {
    expect(helper.name.type).toBe('FrameSynthToken')
    expect(helper.name.text).toBe('Helper')
    expect('position' in helper.name).toBe(false)
    // the type parameter and string tag repeat the name; both synth
    expect(helper.nameType.type).toBe('FrameSynthToken')
    expect(helper.nameTag.type).toBe('FrameSynthToken')
  })

  it('binds the anchor: alias maps to the heading (definition), `yield*` tag synth', () => {
    const body = tangle.body
    expect(body.type).toBe('TangleBody')
    if (body.type !== 'TangleBody') return
    const binding = body.bindings[0]!.value
    expect(binding.name.text).toBe('_Helper')
    // the alias is the definition: mapped to the `# Helper` heading title,
    // and kind `heading` — locate-only, so hover stays off the heading
    expect(binding.name.position.start.offset).toBe(src.indexOf('Helper'))
    expect(binding.name.kind).toBe('heading')
    expect(binding.tag.type).toBe('FrameSynthToken')
  })

  it('marks a tangle language-agnostic (Loom), neither the doc default nor the path', () => {
    expect(tangle.languageId).toBe('Loom') // agnostic — not `typescript`, not `bash`
    expect(tangle.name.type).toBe('FrameSynthToken') // tagless — glue, unmapped
  })
})

describe('buildFrame — a name anchor to a duplicated title is an ambiguous-anchor diagnostic', () => {
  // Two sections share the title "Helper"; a third anchors it by name. A name
  // anchor resolves exactly one local section, so the clash is reported on the
  // anchor — error health — rather than silently resolved to the last section.
  const src = `{{lang: TypeScript}}

# Helper

=>

export const a = 1

# Helper

=>

export const b = 2

# Main [Main]

=>

main = {{Helper}}
`
  const frame = buildFrame(parse(src))
  const main = frame.members
    .map((m) => m.value)
    .find(
      (v): v is ServiceClass =>
        v.type === 'ServiceClass' && v.name.text === 'Main',
    )!
  const code = (main.body as StaticBody).code
  const args = [code.head, ...code.tail.map((t) => t.value)]
  const ref = args.find((a) => a?.type === 'CodeRef') as CodeRef

  it('flags the anchor with error health naming the clash', () => {
    expect(ref.binding.text).toBe('Helper') // the anchor span, not an alias
    expect(ref.binding.kind).toBe('anchor') // referencer span — navigation, no hover
    expect(ref.binding.health.status).toBe('error')
    expect(ref.binding.health.diagnostics[0]!.message).toMatch(
      /Ambiguous anchor: 2 sections are named `Helper`/,
    )
  })

  it('hoists no binding for the ambiguous anchor — the body stays static', () => {
    expect(main.body.type).toBe('StaticBody')
  })
})
