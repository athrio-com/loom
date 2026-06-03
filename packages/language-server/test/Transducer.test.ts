import { describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import { Loom } from '#ast/Loom'
import type {
  CodeRef,
  EffectfulBody,
  EmbeddedCode,
  ServiceClass,
  StaticBody,
} from '#projectors/FrameAst'
import { transduce } from '#projectors/Transducer'

// transduce over the trivial fixture: one tagged, static section, no Warps.
// Assertions are structural (no renderer yet) — the right nodes, fields, and
// source mappings.

const input = `{{lang: TypeScript}}

# Adder [Add]

Adds two integers.

=>

export const add = (x: number, y: number): number => x + y
`

const parse = (src: string) =>
  Effect.runSync(
    Effect.gen(function* () {
      const loom = yield* Loom
      return yield* loom.ast(src)
    }).pipe(Effect.provide(Loom.Default)),
  )

describe('transduce — trivial section → FrameModule', () => {
  const frame = transduce(parse(input))

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

  it('maps title → name, preamble → preamble + TSDoc, code → compose', () => {
    const svc = frame.members[0]!.value as ServiceClass
    expect(svc.docPreamble.text).toContain('Adds two integers.')
    expect(svc.body.type).toBe('StaticBody')
    const body = svc.body as StaticBody
    expect(body.name.text).toBe('Adder')
    expect(body.preamble.text).toContain('Adds two integers.')
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

  it('maps the class name to the [Add] tag and the field name to the title', () => {
    const svc = frame.members[0]!.value as ServiceClass
    const body = svc.body as StaticBody
    // class identifier ⇒ the tag label inside `[Add]`, not the title "Adder"
    expect(svc.name.position.start.offset).toBe(input.indexOf('[Add]') + 1)
    // the `name:` field ⇒ the heading title
    expect(body.name.position.start.offset).toBe(input.indexOf('Adder'))
  })
})

describe('transduce — mapped spans hug the inner payload, not delimiters', () => {
  const src = `{{lang: TypeScript}}

# Helper [Help]

=>

export const help = 1

# Main [Main]

{{h: Help}}

=>

main = {{h}}
`
  const frame = transduce(parse(src))
  const main = frame.members
    .map((m) => m.value)
    .find(
      (v): v is ServiceClass =>
        v.type === 'ServiceClass' && v.name.text === 'Main',
    )!
  const body = main.body as EffectfulBody
  const at = (p: { start: { offset: number }; end: { offset: number } }) =>
    src.slice(p.start.offset, p.end.offset)

  it('a Warp binds name and annotation to the inner spans of {{name: Tag}}', () => {
    expect(body.head.name.text).toBe('h')
    expect(at(body.head.name.position)).toBe('h') // not "{{h: Help}}"
    expect(body.head.tag.text).toBe('Help')
    expect(at(body.head.tag.position)).not.toMatch(/[{}]/) // no delimiters
    expect(at(body.head.tag.position)).toContain('Help')
  })

  it('a code anchor binds to the inner name of {{name}}, not the braces', () => {
    const args = [body.code.head, ...body.code.tail.map((t) => t.value)]
    const ref = args.find((a) => a?.type === 'CodeRef') as CodeRef
    expect(ref.binding.text).toBe('h')
    expect(at(ref.binding.position)).toBe('h') // not "{{h}}"
    expect(ref.binding.position.start.offset).toBe(src.lastIndexOf('{{h}}') + 2)
  })
})
