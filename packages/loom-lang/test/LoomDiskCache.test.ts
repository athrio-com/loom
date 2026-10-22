import { describe, expect, it } from 'bun:test'
import { Effect, Layer, ManagedRuntime, Option } from 'effect'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LoomConfig } from '@athrio/loom-config/LoomConfig'
import type { LoomModule } from '@athrio/loom-ast/LoomCorpusAst'
import { DocumentSource, LoomCompiler } from '../src/LoomCompiler'
import { LoomMemo } from '../src/LoomMemo'
import { PackageConfig } from '../src/PackageConfig'
import type { Source } from '#ast/LoomCorpusAstBuilder'
import { ReadError } from '#ast/LoomCorpusAstBuilder'

// LoomDiskCache keeps every module the compiler builds under .loom/cache, so a
// fresh process reads the corpus back instead of parsing it again. These cases
// copy real chapters of the book into a scratch workspace, so the modules hold
// every kind of node the parser makes. Each "process" is a fresh runtime: a new
// in-memory build cache over the same disk.

const repoCorpus = join(import.meta.dir, '..', '..', '..', 'corpus')

const workspace = (): string => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'loom-disk-cache-')))
  mkdirSync(join(root, '.loom'), { recursive: true })
  writeFileSync(
    join(root, '.loom', 'config.yaml'),
    'languages:\n  typescript: {}\ncorpus: corpus\nprimary: typescript\n',
  )
  cpSync(join(repoCorpus, '02-the-shape-of-a-loom'), join(root, 'corpus', 'shape'), {
    recursive: true,
  })
  cpSync(join(repoCorpus, '05-tangling'), join(root, 'corpus', 'tangling'), { recursive: true })
  return root
}

const freshProcess = () =>
  ManagedRuntime.make(
    Layer.merge(LoomCompiler.layer, LoomMemo.layer).pipe(
      Layer.provide(DocumentSource.layer),
      Layer.provide(PackageConfig.layer),
      Layer.provide(LoomConfig.layer),
    ),
  )

type Process = ReturnType<typeof freshProcess>

const modulesOf = (process: Process, entry: string): ReadonlyMap<string, LoomModule> =>
  process.runSync(
    LoomCompiler.pipe(
      Effect.flatMap((compiler) => compiler.reach(entry)),
      Effect.andThen(LoomMemo.pipe(Effect.flatMap((memo) => memo.entries))),
    ),
  )

const keptFiles = (root: string): ReadonlyArray<string> =>
  readdirSync(join(root, '.loom', 'cache', 'modules')).filter((name) => name.endsWith('.json'))

describe('LoomDiskCache — modules kept on disk between processes', () => {
  it('reads back every module exactly as it was built', () => {
    const root = workspace()
    const entry = join(root, 'corpus', 'tangling', '01-the-compiler.loom')
    const built = modulesOf(freshProcess(), entry)
    expect(built.size).toBeGreaterThan(10)
    expect(keptFiles(root).length).toBe(built.size)
    expect(readFileSync(join(root, '.loom', 'cache', '.gitignore'), 'utf8')).toBe('*\n')

    const recalled = modulesOf(freshProcess(), entry)
    expect(recalled.size).toBe(built.size)
    for (const [path, module] of built) {
      expect(Bun.deepEquals(recalled.get(path), module, false)).toBe(true)
    }
    const refs = [...recalled.values()].flatMap((module) =>
      module.product.code.flatMap((code) =>
        code.fragments.flatMap((part) => (part.type === 'NameRef' ? [part.target] : [])),
      ),
    )
    expect(refs.length).toBeGreaterThan(0)
    expect(refs.every(Option.isOption)).toBe(true)
  }, 60_000)

  it('takes a module from disk rather than building it again', () => {
    const root = workspace()
    const entry = join(root, 'corpus', 'tangling', '06-the-build-cache.loom')
    modulesOf(freshProcess(), entry)
    const kept = join(root, '.loom', 'cache', 'modules', keptFiles(root)[0]!)
    const file = JSON.parse(readFileSync(kept, 'utf8'))
    writeFileSync(kept, JSON.stringify({ ...file, module: { ...file.module, marked: true } }))

    const recalled = modulesOf(freshProcess(), entry)
    expect(recalled.get(file.module.path)).toMatchObject({ marked: true })
  }, 60_000)

  it('builds a loom again once its text changes', () => {
    const root = workspace()
    const chapter = join(root, 'corpus', 'tangling', '06-the-build-cache.loom')
    modulesOf(freshProcess(), chapter)
    writeFileSync(chapter, `${readFileSync(chapter, 'utf8')}\nA closing line.\n`)

    const recalled = modulesOf(freshProcess(), chapter)
    expect(recalled.get(chapter)?.text).toContain('A closing line.')
  }, 60_000)

  it('never keeps a module built from text that was not saved', () => {
    const root = workspace()
    const chapter = join(root, 'corpus', 'tangling', '06-the-build-cache.loom')
    const unsaved: Source = {
      read: (path) =>
        Effect.try({
          try: () =>
            path === chapter
              ? `${readFileSync(path, 'utf8')}\nAn unsaved line.\n`
              : readFileSync(path, 'utf8'),
          catch: (cause) => new ReadError({ path, cause }),
        }),
      list: Option.none(),
    }
    freshProcess().runSync(
      LoomCompiler.pipe(Effect.flatMap((compiler) => compiler.compile(unsaved, chapter))),
    )
    const keptTexts = existsSync(join(root, '.loom', 'cache', 'modules'))
      ? keptFiles(root).map(
          (name) =>
            JSON.parse(readFileSync(join(root, '.loom', 'cache', 'modules', name), 'utf8')).module
              .text as string,
        )
      : []
    expect(keptTexts.some((text) => text.includes('An unsaved line.'))).toBe(false)
  }, 60_000)
})
