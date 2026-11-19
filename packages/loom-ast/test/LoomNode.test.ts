import { describe, expect, it } from 'bun:test'
import { Result, Schema } from 'effect'
import { loomNode, nodeOf, okHealth, type Position } from '#ast/LoomNode'

const at: Position = { start: { line: 1, offset: 0 }, end: { line: 1, offset: 4 } }

const WordSchema = loomNode('Word', { value: Schema.String })

const ShortWordSchema = loomNode('ShortWord', { value: Schema.String }).check(
  Schema.makeFilter((word) =>
    word.value.length <= 4 ? undefined : 'a short word has four letters at most',
  ),
)

const fieldsOf = (value: string) => ({ position: at, source: value, health: okHealth, value })

describe('nodeOf', () => {
  it('gives the node its schema would make', () => {
    const word = nodeOf(WordSchema, fieldsOf('loom'))
    expect(word).toEqual({ type: 'Word', ...fieldsOf('loom') })
    expect(word).toEqual(WordSchema.make(fieldsOf('loom')))
  })

  it('reads the tag of a schema that carries a check', () => {
    expect(nodeOf(ShortWordSchema, fieldsOf('warp')).type).toBe('ShortWord')
  })

  it("writes the schema's tag over a tag its fields carry", () => {
    const word = nodeOf(WordSchema, fieldsOf('weft'))
    expect(nodeOf(ShortWordSchema, { ...word }).type).toBe('ShortWord')
  })

  it('runs no check, where decoding does', () => {
    const long = nodeOf(ShortWordSchema, fieldsOf('tapestry'))
    expect(long.value).toBe('tapestry')
    expect(Result.isFailure(Schema.decodeUnknownResult(ShortWordSchema)(long))).toBe(true)
  })
})

import { byType, byTypeOr } from '#ast/LoomNode'

type Circle = { readonly type: 'Circle'; readonly radius: number }

type Square = { readonly type: 'Square'; readonly side: number }

type Dot = { readonly type: 'Dot' }

type Shape = Circle | Square | Dot

const areaOf = byType<Shape>()({
  Circle: (circle) => Math.PI * circle.radius ** 2,
  Square: (square) => square.side ** 2,
  Dot: () => 0,
})

const scaled = byType<Shape, [factor: number]>()({
  Circle: (circle, factor): Shape => ({ ...circle, radius: circle.radius * factor }),
  Square: (square, factor): Shape => ({ ...square, side: square.side * factor }),
  Dot: (dot): Shape => dot,
})

const roundness = byTypeOr<Shape>()({ Circle: () => 'round' }, () => 'not round')

describe('byType', () => {
  it("calls the case under the node's tag, with that node", () => {
    expect(areaOf({ type: 'Square', side: 3 })).toBe(9)
    expect(areaOf({ type: 'Dot' })).toBe(0)
  })

  it('hands a case the further arguments after the node', () => {
    expect(scaled({ type: 'Square', side: 3 }, 2)).toEqual({ type: 'Square', side: 6 })
  })
})

describe('byTypeOr', () => {
  it('takes the default for a tag with no case', () => {
    expect(roundness({ type: 'Circle', radius: 1 })).toBe('round')
    expect(roundness({ type: 'Dot' })).toBe('not round')
  })

  it('takes the default for a tag that matches an inherited name', () => {
    const stray = { type: 'constructor' } as unknown as Shape
    expect(roundness(stray)).toBe('not round')
  })
})
