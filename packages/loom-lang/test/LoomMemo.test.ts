import { describe, expect, it } from '@effect/vitest'
import { Array, Effect, Ref } from 'effect'
import { parseDocument, ParseLayer } from './parse'
import { buildFrame } from '#ast/FrameAstBuilder'
import { type LoomModule } from '#ast/LoomCorpusAst'
import { LoomMemo } from '../src/LoomMemo'

// LoomMemo is the incremental build cache: a `get` is a hit (return the kept
// module, no rebuild) or a miss (run `build`, keep it, count it). These probes
// drive the intended use case — reuse on a hit, rebuild only after `evict`, keep
// a module per path — and the property that makes it correct under an editor's
// concurrent requests: `build` runs at most once per kept path. We count how many
// times `build` actually runs to tell a hit from a miss.

const parse = (src: string) =>
  Effect.runSync(parseDocument(src).pipe(Effect.provide(ParseLayer)))

// a real (tiny) module to cache; the parse/frame are shared, the path varies.
const text = `{{lang: TypeScript}}

# Bit [Bit]

=>

const x = 1
`
const doc = parse(text)
const frame = buildFrame(doc, '/Bit.loom')
const moduleAt = (path: string): LoomModule => ({
  path,
  text,
  doc,
  frame,
  imports: [],
})

describe('LoomMemo — the incremental build cache', () => {
  it.effect('a miss builds and keeps; a second get hits without rebuilding', () =>
    Effect.gen(function* () {
      const memo = yield* LoomMemo
      const calls = yield* Ref.make(0)
      const m = moduleAt('/a.loom')
      const build = Ref.update(calls, (n) => n + 1).pipe(Effect.as(m))

      const first = yield* memo.get('/a.loom', build)
      expect(first).toBe(m) // the built module
      expect(yield* Ref.get(calls)).toBe(1) // build ran — a miss

      const second = yield* memo.get('/a.loom', build)
      expect(second).toBe(m) // the same kept module
      expect(yield* Ref.get(calls)).toBe(1) // build did NOT run again — a hit

      expect(yield* memo.stats).toEqual({ hits: 1, misses: 1, size: 1 })
    }).pipe(Effect.provide(LoomMemo.Default)),
  )

  it.effect('keeps a module per path; entries reflects the kept set', () =>
    Effect.gen(function* () {
      const memo = yield* LoomMemo
      const a = moduleAt('/a.loom')
      const b = moduleAt('/b.loom')
      yield* memo.get('/a.loom', Effect.succeed(a))
      yield* memo.get('/b.loom', Effect.succeed(b))

      const entries = yield* memo.entries
      expect([...entries.keys()].sort()).toEqual(['/a.loom', '/b.loom'])
      expect(entries.get('/a.loom')).toBe(a) // each path keeps its own module
      expect(entries.get('/b.loom')).toBe(b)
      expect(yield* memo.stats).toEqual({ hits: 0, misses: 2, size: 2 })
    }).pipe(Effect.provide(LoomMemo.Default)),
  )

  it.effect('evict forgets a path, so the next get rebuilds it', () =>
    Effect.gen(function* () {
      const memo = yield* LoomMemo
      const calls = yield* Ref.make(0)
      const m = moduleAt('/a.loom')
      const build = Ref.update(calls, (n) => n + 1).pipe(Effect.as(m))

      yield* memo.get('/a.loom', build) // miss → build #1
      yield* memo.get('/a.loom', build) // hit
      expect(yield* Ref.get(calls)).toBe(1)

      yield* memo.evict(['/a.loom'])
      expect((yield* memo.entries).has('/a.loom')).toBe(false) // forgotten

      yield* memo.get('/a.loom', build) // miss again → build #2
      expect(yield* Ref.get(calls)).toBe(2)
      expect(yield* memo.stats).toMatchObject({ misses: 2, size: 1 })
    }).pipe(Effect.provide(LoomMemo.Default)),
  )

  it.effect('builds at most once under concurrent gets of a cold path', () =>
    Effect.gen(function* () {
      const memo = yield* LoomMemo
      const calls = yield* Ref.make(0)
      const m = moduleAt('/x.loom')
      // yieldNow makes the miss non-atomic: a cache that checked-then-built
      // without a lock would let several fibers all miss and all build.
      const build = Effect.yieldNow().pipe(
        Effect.zipRight(Ref.update(calls, (n) => n + 1)),
        Effect.as(m),
      )

      const results = yield* Effect.all(
        Array.replicate(memo.get('/x.loom', build), 12),
        { concurrency: 'unbounded' },
      )

      expect(results.every((r) => r === m)).toBe(true) // all saw the one module
      expect(yield* Ref.get(calls)).toBe(1) // built exactly once
      expect(yield* memo.stats).toEqual({ hits: 11, misses: 1, size: 1 })
    }).pipe(Effect.provide(LoomMemo.Default)),
  )
})
