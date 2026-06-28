import { describe, expect, it } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { DocumentSource } from '../src/LoomCompiler'
import { LoomCompiler } from '../src/LoomCompiler'
import { LoomMemo } from '../src/LoomMemo'
import { PackageConfig } from '../src/PackageConfig'
import { defaultAnchorDelims } from '@athrio/loom-ast/LoomTokens'

// Drives the corpus pipeline end-to-end over an in-memory DocumentSource:
// Fun.loom imports Negate from Sad.loom in a {Loom} section, so the corpus walk
// reaches Sad and a change to Sad invalidates Fun — the import graph the
// single-file editor projection can't see. DocumentSource is a free requirement,
// so the test injects a fake one without touching the filesystem.

const files: Record<string, string> = {
  '/Sad.loom': `{{lang: TypeScript}}

# Negate

=>

const negate = (x: number) => -x
`,
  '/Fun.loom': `{{lang: TypeScript}}

# Imports {Loom}

=>

import { Negate } from "./Sad.loom"

# Negated double

=>

const negDouble = (x: number) => -x * 2
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
      Effect.succeed({
        delims: defaultAnchorDelims,
        primaryLanguage: undefined,
        packageRoot: undefined,
        workspaceRoot: undefined,
      }),
  }),
)

// merge LoomMemo into the provided context (the same instance the compiler uses,
// by Effect's layer memoisation) so a probe can read its hit/miss stats.
const layer = Layer.provide(
  Layer.merge(LoomCompiler.Default, LoomMemo.Default),
  Layer.merge(TestDocs, TestConfig),
)

describe('LoomCompiler — the chain projected for each consumer', () => {
  it.effect('reach reports the files an entry pulls in along the import edge', () =>
    Effect.gen(function* () {
      const c = yield* LoomCompiler
      // Fun imports Neg from Sad, so the corpus walk reaches Sad
      expect([...(yield* c.reach('/Fun.loom'))]).toEqual(['/Sad.loom'])
    }).pipe(Effect.provide(layer)),
  )

  it.effect('invalidate names the file and the dependents that import it', () =>
    Effect.gen(function* () {
      const c = yield* LoomCompiler
      yield* c.reach('/Fun.loom') // warm the cache (loads Fun + Sad)
      const dirty = yield* c.invalidate('/Sad.loom')
      // Sad itself, plus Fun which imports it
      expect([...dirty].sort()).toEqual(['/Fun.loom', '/Sad.loom'])
    }).pipe(Effect.provide(layer)),
  )

  it.effect('reuses built modules across requests (the memo)', () =>
    Effect.gen(function* () {
      const c = yield* LoomCompiler
      const memo = yield* LoomMemo
      yield* c.reach('/Fun.loom') // builds Fun + Sad — two misses
      const first = yield* memo.stats
      expect(first).toMatchObject({ misses: 2, size: 2 })

      yield* c.reach('/Fun.loom') // again — all hits, nothing rebuilt
      const second = yield* memo.stats
      expect(second.misses).toBe(2) // no new builds
      expect(second.hits).toBeGreaterThan(first.hits)
    }).pipe(Effect.provide(layer)),
  )
})
