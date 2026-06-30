import { describe, expect, it } from '@effect/vitest'
import { Effect, Layer, Option } from 'effect'
import { DocumentSource } from '../src/LoomCompiler'
import { LoomCompiler } from '../src/LoomCompiler'
import { LoomMemo } from '../src/LoomMemo'
import { PackageConfig } from '../src/PackageConfig'
import { defaultAnchorDelims } from '@athrio/loom-ast/LoomTokens'

// Drives the corpus pipeline end-to-end over an in-memory DocumentSource:
// book.loom places The chapter — which lives in chapter.loom — through a
// higher-order sink, so the corpus reaches the chapter and a change to the chapter
// invalidates the book. That is the place graph the single-file editor projection
// can't see. DocumentSource is a free requirement, so the test injects a fake one
// without touching the filesystem; its `list` reports both looms as the corpus.

const files: Record<string, string> = {
  '/chapter.loom': `{{lang: TypeScript}}

# The chapter

=>

export const c = 1
`,
  '/book.loom': `{{lang: TypeScript}}

# The part [dist]

::[The chapter](chapter.loom)
`,
}

const TestDocs = Layer.succeed(
  DocumentSource,
  new DocumentSource({
    read: (path: string) => Effect.succeed(files[path] ?? ''),
    list: Option.some(() => Effect.succeed(Object.keys(files))),
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
        corpusDir: undefined,
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
  it.effect('reach reports the chapters a book places', () =>
    Effect.gen(function* () {
      const c = yield* LoomCompiler
      // book places The chapter, which lives in chapter.loom
      expect([...(yield* c.reach('/book.loom'))]).toEqual(['/chapter.loom'])
    }).pipe(Effect.provide(layer)),
  )

  it.effect('placed reports the chapters a book places', () =>
    Effect.gen(function* () {
      const c = yield* LoomCompiler
      // book.loom places The chapter, which lives in chapter.loom; so a tangle
      // skips chapter.loom as a standalone entry and emits it through the book
      expect([...(yield* c.placed('/book.loom'))]).toEqual(['/chapter.loom'])
    }).pipe(Effect.provide(layer)),
  )

  it.effect('invalidate names the file and the books that place it', () =>
    Effect.gen(function* () {
      const c = yield* LoomCompiler
      yield* c.reach('/book.loom') // warm the cache (loads book + chapter)
      const dirty = yield* c.invalidate('/chapter.loom')
      // the chapter itself, plus the book that places it
      expect([...dirty].sort()).toEqual(['/book.loom', '/chapter.loom'])
    }).pipe(Effect.provide(layer)),
  )

  it.effect('reuses built modules across requests (the memo)', () =>
    Effect.gen(function* () {
      const c = yield* LoomCompiler
      const memo = yield* LoomMemo
      yield* c.reach('/book.loom') // builds book + chapter — two misses
      const first = yield* memo.stats
      expect(first).toMatchObject({ misses: 2, size: 2 })

      yield* c.reach('/book.loom') // again — all hits, nothing rebuilt
      const second = yield* memo.stats
      expect(second.misses).toBe(2) // no new builds
      expect(second.hits).toBeGreaterThan(first.hits)
    }).pipe(Effect.provide(layer)),
  )
})
