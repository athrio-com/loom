import { describe, expect, it as it_ } from 'bun:test'
import { effectify } from '@athrio/effect-test'
import { Effect, Layer, Option } from 'effect'
import { DocumentSource, LoomCompiler } from '../src/LoomCompiler'
import { LoomMemo } from '../src/LoomMemo'
import { WorkspaceSettings } from '../src/WorkspaceSettings'
import { LoomDiskCache } from '../src/LoomDiskCache'
import { FileSystemSource } from '../src/WorkspaceSource'
import { defaultAnchorDelims } from '@athrio/loom-ast/LoomTokens'

const it = effectify(it_)

const lines = (...rows: ReadonlyArray<string>): string => `${rows.join('\n')}\n`

const anchor = (name: string): string => `::${'['}${name}]`

const files: Record<string, string> = {
  '/chapter.loom': lines(
    '---',
    'Language: TypeScript',
    '---',
    '',
    '# The chapter',
    '',
    '=>',
    '',
    'export const c = 1',
  ),
  '/book.loom': lines(
    '---',
    'Language: TypeScript',
    '---',
    '',
    '# The part',
    '',
    anchor('The chapter'),
  ),
}

const TestDocs = Layer.succeed(DocumentSource, {
  read: (path: string) => Effect.succeed(files[path] ?? ''),
  list: Option.some(() => Effect.succeed(Object.keys(files))),
  hold: () => Effect.void,
  forget: () => Effect.void,
})

const TestConfig = Layer.succeed(WorkspaceSettings, {
  manifest: () => Effect.succeed(Option.none()),
  resolve: () =>
    Effect.succeed({
      delims: defaultAnchorDelims,
      primaryLanguage: undefined,
      variables: {},
      width: 100,
    }),
})

const layer = Layer.provide(
  Layer.merge(LoomCompiler.layer, LoomMemo.layer),
  Layer.mergeAll(TestDocs, TestConfig, FileSystemSource, LoomDiskCache.none),
)

describe('LoomCompiler — the chain projected for each consumer', () => {
  it.effect('reach reports the chapters a book places', () =>
    Effect.gen(function* () {
      const c = yield* LoomCompiler
      expect([...(yield* c.reach('/book.loom'))]).toEqual(['/chapter.loom'])
    }).pipe(Effect.provide(layer)),
  )

  it.effect('invalidate names the file and the books that place it', () =>
    Effect.gen(function* () {
      const c = yield* LoomCompiler
      yield* c.reach('/book.loom')
      const dirty = yield* c.invalidate('/chapter.loom')
      expect([...dirty].sort()).toEqual(['/book.loom', '/chapter.loom'])
    }).pipe(Effect.provide(layer)),
  )

  it.effect('builds each module once, and keeps the corpus between requests', () =>
    Effect.gen(function* () {
      const c = yield* LoomCompiler
      const memo = yield* LoomMemo
      yield* c.reach('/book.loom')
      const first = yield* memo.stats
      expect(first).toMatchObject({ misses: 2, size: 2 })

      yield* c.reach('/book.loom')
      expect(yield* memo.stats).toEqual(first)

      yield* c.reach('/chapter.loom')
      expect(yield* memo.stats).toMatchObject({ misses: 2, size: 2 })
    }).pipe(Effect.provide(layer)),
  )
})

import { Context, Ref } from 'effect'
import { LoomCorpusAstBuilder } from '#ast/LoomCorpusAstBuilder'
import { WeaveBuilder } from '../src/weave/WeaveBuilder'

type Step = 'parsed' | 'finished' | 'built'

class Steps extends Context.Service<Steps>()('Steps', {
  make: Effect.map(Ref.make<Record<Step, number>>({ parsed: 0, finished: 0, built: 0 }), (counts) => ({
    counts,
  })),
}) {
  static readonly layer = Layer.effect(this, this.make)
}

const CountedBuilder = Layer.effect(
  LoomCorpusAstBuilder,
  Effect.gen(function* () {
    const builder = yield* LoomCorpusAstBuilder
    const { counts } = yield* Steps
    const counted =
      <Args extends ReadonlyArray<unknown>, A>(
        step: Step,
        run: (...args: Args) => Effect.Effect<A>,
      ) =>
      (...args: Args): Effect.Effect<A> =>
        Ref.update(counts, (was) => ({ ...was, [step]: was[step] + 1 })).pipe(
          Effect.andThen(run(...args)),
        )
    return {
      parse: counted('parsed', builder.parse),
      finish: counted('finished', builder.finish),
      build: counted('built', builder.build),
    }
  }),
).pipe(Layer.provide(Layer.merge(LoomCorpusAstBuilder.layer, Steps.layer)))

const withTrope: Record<string, string> = {
  ...files,
  '/mermaid.loom': lines(
    '---',
    'Trope Chapter: Mermaid',
    '---',
    '',
    '# Mermaid',
    '',
    '## What it declares {Manifest}',
    '',
    '=>',
    JSON.stringify({
      contract: '1',
      contributes: { kinds: { box: [{ kind: 'Mermaid', body: 'text' }] } },
    }),
  ),
}

const TropeDocs = Layer.succeed(DocumentSource, {
  read: (path: string) => Effect.succeed(withTrope[path] ?? ''),
  list: Option.some(() => Effect.succeed(Object.keys(withTrope))),
  hold: () => Effect.void,
  forget: () => Effect.void,
})

const countedLayer = Layer.provide(
  Layer.merge(
    Layer.effect(LoomCompiler, LoomCompiler.make).pipe(
      Layer.provide(Layer.mergeAll(CountedBuilder, LoomMemo.layer, WeaveBuilder.layer)),
    ),
    Steps.layer,
  ),
  Layer.mergeAll(TropeDocs, TestConfig, FileSystemSource, LoomDiskCache.none),
)

describe('LoomCompiler — a corpus nobody has built', () => {
  it.effect('parses each loom once and finishes it once', () =>
    Effect.gen(function* () {
      const c = yield* LoomCompiler
      const { counts } = yield* Steps
      yield* c.reach('/book.loom')
      expect(yield* Ref.get(counts)).toEqual({ parsed: 3, finished: 4, built: 0 })

      yield* c.invalidate('/chapter.loom')
      yield* c.reach('/book.loom')
      expect(yield* Ref.get(counts)).toEqual({ parsed: 4, finished: 5, built: 0 })
    }).pipe(Effect.provide(countedLayer)),
  )
})

const crossImport: Record<string, string> = {
  '/a.loom': lines(
    '---',
    'Language: TypeScript',
    'Package: a.ts',
    '---',
    '',
    '# A {Tangle}',
    '',
    '=>',
    '',
    "import { b } from './b.js'",
    'export const a = b + 1',
  ),
  '/b.loom': lines(
    '---',
    'Language: TypeScript',
    'Package: b.ts',
    '---',
    '',
    '# B {Tangle}',
    '',
    '=>',
    '',
    'export const b = 2',
  ),
}

const crossLayer = Layer.provide(
  Layer.merge(LoomCompiler.layer, LoomMemo.layer),
  Layer.mergeAll(
    FileSystemSource,
    LoomDiskCache.none,
    Layer.succeed(DocumentSource, {
      read: (path: string) => Effect.succeed(crossImport[path] ?? ''),
      list: Option.some(() => Effect.succeed(Object.keys(crossImport))),
      hold: () => Effect.void,
      forget: () => Effect.void,
    }),
    TestConfig,
  ),
)

describe('LoomCompiler — composition projects the de re as a filesystem', () => {
  it.effect('returns every root at its output path, with content and origin', () =>
    Effect.gen(function* () {
      const c = yield* LoomCompiler
      const files = yield* c.composition('/a.loom')
      const byId = new Map(files.map((file) => [file.rootId, file]))
      const a = byId.get('a')
      const b = byId.get('b')
      expect(a?.path).toBe('/a.ts')
      expect(a?.loomPath).toBe('/a.loom')
      expect(a?.content).toContain("import { b } from './b.js'")
      expect(b?.path).toBe('/b.ts')
      expect(b?.content).toContain('export const b = 2')
      expect(a?.heading.path).toBe('/a.loom')
      expect(a?.heading.range.start).toEqual({ line: 5, character: 2 })
    }).pipe(Effect.provide(crossLayer)),
  )
})

const editable: Record<string, string> = {
  '/book.loom': lines(
    '---',
    'Language: TypeScript',
    'Package: book.ts',
    '---',
    '',
    '# The book {Tangle}',
    '',
    '=>',
    '',
    anchor('The chapter'),
  ),
  '/chapter.loom': lines(
    '---',
    'Language: TypeScript',
    '---',
    '',
    '# The chapter',
    '',
    '=>',
    '',
    'export const c = 1',
  ),
  '/aside.loom': lines(
    '---',
    'Language: TypeScript',
    'Package: aside.ts',
    '---',
    '',
    '# The aside {Tangle}',
    '',
    '=>',
    '',
    'export const aside = 0',
  ),
}

const editableLayer = Layer.provide(
  Layer.merge(LoomCompiler.layer, LoomMemo.layer),
  Layer.mergeAll(
    FileSystemSource,
    LoomDiskCache.none,
    Layer.succeed(DocumentSource, {
      read: (path: string) => Effect.succeed(editable[path] ?? ''),
      list: Option.some(() => Effect.succeed(Object.keys(editable))),
      hold: () => Effect.void,
      forget: () => Effect.void,
    }),
    TestConfig,
  ),
)

const byRoot = <F extends { readonly rootId: string }>(files: ReadonlyArray<F>) =>
  new Map(files.map((file) => [file.rootId, file]))

describe('LoomCompiler — composition recomposes only what changed', () => {
  it.effect('gives back the same files when nothing changed', () =>
    Effect.gen(function* () {
      const c = yield* LoomCompiler
      const first = byRoot(yield* c.composition('/book.loom'))
      const second = byRoot(yield* c.composition('/book.loom'))
      expect(first.get('thebook')).toBeDefined()
      expect(second.get('thebook')).toBe(first.get('thebook'))
      expect(second.get('theaside')).toBe(first.get('theaside'))
    }).pipe(Effect.provide(editableLayer)),
  )

  it.effect('recomposes a file that inlines an edited section, and keeps the rest', () =>
    Effect.gen(function* () {
      const c = yield* LoomCompiler
      const before = byRoot(yield* c.composition('/book.loom'))
      expect(before.get('thebook')?.content).toContain('export const c = 1')

      editable['/chapter.loom'] = editable['/chapter.loom']!.replace('c = 1', 'c = 2')
      yield* c.invalidate('/chapter.loom')
      const after = byRoot(yield* c.composition('/book.loom'))

      expect(after.get('thebook')?.content).toContain('export const c = 2')
      expect(before.get('theaside')).toBeDefined()
      expect(after.get('theaside')).toBe(before.get('theaside'))
    }).pipe(Effect.provide(editableLayer)),
  )
})
