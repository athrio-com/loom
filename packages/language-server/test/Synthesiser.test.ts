import { describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import { Loom } from '#ast/Loom'
import { synthesise } from '#projectors/Synthesiser'
import { transduce } from '#projectors/Transducer'

// synthesise over the trivial frame: parse → transduce → render → assert the
// generated TypeScript and one source mapping. Closes the end-to-end loop.

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

describe('synthesise — trivial frame → genCode', () => {
  const { genCode, mappings } = synthesise(transduce(parse(input)))

  it('opens with the #loom/core + effect header', () => {
    expect(
      genCode.startsWith('import * as core from "#loom/core"'),
    ).toBe(true)
    expect(genCode).toContain('import { Effect, Layer } from "effect"')
  })

  it('emits an exported Service class named after the tag', () => {
    expect(genCode).toContain(
      'export class Add extends Effect.Service<Add>()("Add", ',
    )
    expect(genCode).toContain(') {}')
  })

  it('carries title → name, preamble, and product code via compose', () => {
    expect(genCode).toContain('name: `Adder`')
    expect(genCode).toContain('preamble: `')
    expect(genCode).toContain('Adds two integers.')
    expect(genCode).toContain('code: core.compose(`')
    expect(genCode).toContain(
      'export const add = (x: number, y: number): number => x + y',
    )
  })

  it('emits the self-provided composition root', () => {
    expect(genCode).toContain('const layers = Layer.mergeAll(')
    expect(genCode).toContain('Add.Default')
    expect(genCode).toContain('export const LoomMain = Effect.provide(')
    expect(genCode).toContain('Layer.provide(layers, layers)')
  })

  it('maps a generated `Add` back to the [Add] tag span', () => {
    const at = genCode.indexOf('export class Add') + 'export class '.length
    const mapping = mappings.find(
      (m) => m.genStart <= at && at < m.genStart + m.genLength,
    )
    expect(mapping?.kind).toBe('identifier')
    expect(mapping?.source.start.offset).toBe(input.indexOf('[Add]') + 1)
    // and the source span is the tag label "Add" in the .loom
    expect(
      input.slice(
        mapping!.source.start.offset,
        mapping!.source.end.offset,
      ),
    ).toBe('Add')
  })

  it('escapes ` and ${ in the field and product code; TSDoc stays raw', () => {
    const escInput =
      '{{lang: TypeScript}}\n\n# Escapes [Esc]\n\nMentions `pow` in prose.\n\n=>\n\nconst greeting = `Hi ${name}`\n'
    const out = synthesise(transduce(parse(escInput))).genCode
    expect(out).toContain('\\`pow\\`') // field: escaped backticks
    expect(out).toContain('`pow`') // TSDoc: raw (a comment may contain backticks)
    expect(out).toContain('\\${name}') // product code: escaped ${
  })
})
