import { FileSystem } from '@effect/platform'
import { NodeContext } from '@effect/platform-node'
import { describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import { compose, tangle } from '#loom/core'

// The two runtime primitives the synthesised Frame imports from #loom/core.
// compose is pure text assembly; tangle is the one effectful sink — it writes
// the composed code to disk, creating parent directories.

describe('compose', () => {
  it('concatenates its parts in argument order, verbatim', () => {
    expect(compose('a', 'b', 'c')).toBe('abc')
  })

  it('inserts nothing between parts — fragments carry their own whitespace', () => {
    expect(compose('\nx = 1\n', 'y = 2\n')).toBe('\nx = 1\ny = 2\n')
  })

  it('is the empty string for a section with no code — compose()', () => {
    expect(compose()).toBe('')
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
