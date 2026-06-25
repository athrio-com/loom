import { describe, expect, it } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { DocumentSource } from '../src/LoomCompiler'
import { LoomCompiler } from '../src/LoomCompiler'
import { LoomMemo } from '../src/LoomMemo'
import { PackageConfig } from '../src/PackageConfig'
import { defaultAnchorDelims } from '#ast/LoomTokens'

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

{{n = Neg}}

=>

::[n]
const negDouble = (x: number) => negate(x) * 2
`,
}

const TestDocs = Layer.succeed(
  DocumentSource,
  new DocumentSource({
    read: (path: string) => Effect.succeed(files[path] ?? ''),
  }),
)

// a stub config: this probe drives the corpus over in-memory paths, so it never
// touches disk — every file resolves to the default `::[` delimiters and no
// configured primary language.
const TestConfig = Layer.succeed(
  PackageConfig,
  new PackageConfig({
    resolve: () =>
      Effect.succeed({ delims: defaultAnchorDelims, primaryLanguage: undefined }),
  }),
)

// merge LoomMemo into the provided context (the same instance the compiler uses,
// by Effect's layer memoisation) so a probe can read its hit/miss stats.
const layer = Layer.provide(
  Layer.merge(LoomCompiler.Default, LoomMemo.Default),
  Layer.merge(TestDocs, TestConfig),
)

describe('LoomCompiler — cross-file de re through the corpus', () => {
  it.effect('inlines an imported section into the consuming product', () =>
    Effect.gen(function* () {
      const c = yield* LoomCompiler
      const docs = yield* c.code('/Fun.loom')
      const negd = docs.find((d) => d.id === 'negd')
      expect(negd).toBeDefined()
      expect(negd!.code).toContain('const negate = (x: number) => -x') // from Sad
      expect(negd!.code).toContain('const negDouble') // Fun's own
    }).pipe(Effect.provide(layer)),
  )

  it.effect('carries the frame per module; the de re comes from running the corpus', () =>
    Effect.gen(function* () {
      const c = yield* LoomCompiler
      const { corpus, output } = yield* c.composed('/Fun.loom')
      // both files loaded along the import edge, each carrying its de dicto frame
      expect([...corpus.modules.keys()].sort()).toEqual([
        '/Fun.loom',
        '/Sad.loom',
      ])
      expect(corpus.modules.get('/Sad.loom')!.frame.type).toBe('FrameModule')
      // the de re is the run's output — Sad's Neg, Fun's Negd
      expect([...output.code.get('/Sad.loom')!.keys()]).toEqual(['Neg'])
      expect([...output.code.get('/Fun.loom')!.keys()]).toEqual(['Negd'])
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
