import { describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import { Loom } from '#ast/Loom'
import { resolve } from '#projectors/Resolver'
import { transduce } from '#projectors/Transducer'

// The Resolver projects the de re product: one document per Service, in its own
// language, with `{{…}}` transclusions inlined in composition order. The probes
// cover that a transcluded section is inlined ahead of its consumer, and that
// the inlined code maps back to the *originating* section (cross-section).

const parse = (src: string) =>
  Effect.runSync(
    Effect.gen(function* () {
      const loom = yield* Loom
      return yield* loom.ast(src)
    }).pipe(Effect.provide(Loom.Default)),
  )

const input = `{{lang: TypeScript}}

# Multiply [Mul]

=>

const mul = (x: number, y: number) => x * y

# Square [Sq]

{{m: Mul}}

=>

{{m}}
const square = (x: number) => mul(x, x)
`

describe('Resolver — de re product compositions', () => {
  const resolved = resolve(transduce(parse(input)), input)
  const byId = (id: string) => resolved.find((r) => r.id === id)!
  const at = (m: {
    source: { start: { offset: number }; end: { offset: number } }
  }) => input.slice(m.source.start.offset, m.source.end.offset)

  it('projects one document per product Service, in its language', () => {
    expect(resolved.map((r) => r.id).sort()).toEqual(['Mul', 'Sq'])
    expect(byId('Sq').languageId).toBe('typescript')
  })

  it('inlines a transcluded section ahead of the code that uses it', () => {
    const sq = byId('Sq')
    expect(sq.code).toContain('const mul = (x: number, y: number) => x * y')
    expect(sq.code).toContain('const square = (x: number) => mul(x, x)')
    // composition order: mul (transcluded) precedes square (its consumer)
    expect(sq.code.indexOf('const mul')).toBeLessThan(
      sq.code.indexOf('const square'),
    )
  })

  it('maps inlined code back to the section it came from (cross-section)', () => {
    const sq = byId('Sq')
    // a span of Sq's document maps into Mul's `.loom` definition…
    const fromMul = sq.mappings.find((m) => at(m).includes('const mul'))
    expect(fromMul).toBeDefined()
    expect(at(fromMul!)).not.toContain('square')
    // …and another maps into Sq's own definition.
    const fromSq = sq.mappings.find((m) => at(m).includes('const square'))
    expect(fromSq).toBeDefined()
  })

  it('a leaf section resolves to just its own code', () => {
    const mul = byId('Mul')
    expect(mul.code).toContain('const mul')
    expect(mul.code).not.toContain('square')
  })
})
