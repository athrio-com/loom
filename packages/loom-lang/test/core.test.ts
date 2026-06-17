import { FileSystem } from '@effect/platform'
import { NodeContext } from '@effect/platform-node'
import { describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import { compose, tangle, weave } from '#loom/core'

// The runtime primitives the generated Frame imports from #loom/core. compose
// assembles a code target and weave assembles a prose target — one join under two
// names, since a section exposes its code and prose as separate fields. tangle is
// the one effectful sink: it writes the assembled result to disk, creating parent
// directories.

describe('compose', () => {
  it('joins its parts in order, verbatim', () => {
    expect(compose('a', 'b', 'c')).toBe('abc')
  })

  it('inserts nothing between parts — fragments carry their own whitespace', () => {
    expect(compose('\nx = 1\n', 'y = 2\n')).toBe('\nx = 1\ny = 2\n')
  })

  it('is the empty string for a section with no code', () => {
    expect(compose()).toBe('')
  })
})

describe('weave', () => {
  it('joins its prose parts in order, verbatim', () => {
    expect(weave('## Title\n', 'a paragraph')).toBe('## Title\na paragraph')
  })

  it('mirrors compose — the same join under a prose-shaped name', () => {
    expect(weave('a', 'b')).toBe(compose('a', 'b'))
  })

  it('is the empty string for a section with no prose', () => {
    expect(weave()).toBe('')
  })
})

describe('tangle', () => {
  it.effect('emits the composed code to the path, creating parent dirs', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectory()
      const path = `${dir}/main/scala/Arithmetic.scala`

      const written = yield* tangle(path, compose('object A ', '{ }'))

      expect(written).toBe(path)
      expect(yield* fs.readFileString(path)).toBe('object A { }')
    }).pipe(Effect.provide(NodeContext.layer)),
  )
})
