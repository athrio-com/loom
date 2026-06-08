import { describe, expect, it } from '@effect/vitest'
import { Effect, Layer, Option } from 'effect'
import { dirname, resolve as resolvePath } from 'node:path'
import { DocumentSource } from '../src/LoomCompiler'
import { LoomCompiler } from '../src/LoomCompiler'
import { LoomMemo } from '../src/LoomMemo'

// Drives the corpus pipeline end-to-end over an in-memory DocumentSource:
// Fun.loom imports Neg from Sad.loom and transcludes it, so the de re of Fun's
// section must inline Sad's code across the file boundary — the path the
// single-file editor projection can't take. DocumentSource is a free
// requirement, so the test injects a fake one without touching the filesystem.

const files: Record<string, string> = {
  '/Sad.loom': `{{lang: TypeScript}}

# Negate [Neg]

=>

const negate = (x: number) => -x
`,
  '/Fun.loom': `{{lang: TypeScript}}

# Imports {Loom}

=>

import { Neg } from "./Sad.loom"

# Negated double [Negd]

{{n: Neg}}

=>

{{n}}
const negDouble = (x: number) => negate(x) * 2
`,
}

const TestDocs = Layer.succeed(
  DocumentSource,
  new DocumentSource({
    read: (path: string) => Effect.succeed(files[path] ?? ''),
    resolve: (from: string, specifier: string) =>
      specifier.endsWith('.loom')
        ? Option.some(resolvePath(dirname(from), specifier))
        : Option.none(),
  }),
)

// merge LoomMemo into the provided context (the same instance the compiler uses,
// by Effect's layer memoisation) so a probe can read its hit/miss stats.
const layer = Layer.provide(
  Layer.merge(LoomCompiler.Default, LoomMemo.Default),
  TestDocs,
)

describe('LoomCompiler — cross-file de re through the corpus', () => {
  it.effect('inlines an imported section into the consuming product', () =>
    Effect.gen(function* () {
      const c = yield* LoomCompiler
      const docs = yield* c.code('/Fun.loom')
      const negd = docs.find((d) => d.id === 'Negd')
      expect(negd).toBeDefined()
      expect(negd!.code).toContain('const negate = (x: number) => -x') // from Sad
      expect(negd!.code).toContain('const negDouble') // Fun's own
    }).pipe(Effect.provide(layer)),
  )

  it.effect('carries both planes as data — modules with frame + code', () =>
    Effect.gen(function* () {
      const c = yield* LoomCompiler
      const corpus = yield* c.corpus('/Fun.loom')
      // both files loaded along the import edge
      expect([...corpus.modules.keys()].sort()).toEqual([
        '/Fun.loom',
        '/Sad.loom',
      ])
      // each module carries its own de re `code` — Sad's Neg, Fun's Negd
      expect([...corpus.modules.get('/Sad.loom')!.code.keys()]).toEqual(['Neg'])
      expect([...corpus.modules.get('/Fun.loom')!.code.keys()]).toEqual(['Negd'])
    }).pipe(Effect.provide(layer)),
  )

  it.effect('reports dependents to refresh when a dependency changes', () =>
    Effect.gen(function* () {
      const c = yield* LoomCompiler
      yield* c.corpus('/Fun.loom') // warm the cache (loads Fun + Sad)
      const dirty = yield* c.change('/Sad.loom')
      // Sad itself, plus Fun which transcluded it
      expect([...dirty].sort()).toEqual(['/Fun.loom', '/Sad.loom'])
    }).pipe(Effect.provide(layer)),
  )

  it.effect('reuses built modules across requests (the memo)', () =>
    Effect.gen(function* () {
      const c = yield* LoomCompiler
      const memo = yield* LoomMemo
      yield* c.corpus('/Fun.loom') // builds Fun + Sad — two misses
      const first = yield* memo.stats
      expect(first).toMatchObject({ misses: 2, size: 2 })

      yield* c.corpus('/Fun.loom') // again — all hits, nothing rebuilt
      const second = yield* memo.stats
      expect(second.misses).toBe(2) // no new builds
      expect(second.hits).toBeGreaterThan(first.hits)
    }).pipe(Effect.provide(layer)),
  )
})
