import { describe, expect, it } from 'bun:test'
import { Effect, Layer, ManagedRuntime } from 'effect'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LoomConfig } from '@athrio/loom-config/LoomConfig'
import { DocumentSource, LoomCompiler } from '../src/LoomCompiler'
import { PackageConfig } from '../src/PackageConfig'

const runtime = ManagedRuntime.make(
  LoomCompiler.layer.pipe(
    Layer.provide(DocumentSource.layer),
    Layer.provide(PackageConfig.layer),
    Layer.provide(LoomConfig.layer),
  ),
)

const lines = (...rows: ReadonlyArray<string>): string => `${rows.join('\n')}\n`

const anchor = (name: string): string => `::${'['}${name}]`

const chapter = (title: string, code: string): string =>
  lines('---', 'Language: TypeScript', '---', '', `# ${title}`, '', '=>', '', code)

describe('LoomCompiler — what an edit evicts', () => {
  it('names a held file and its dependents once, and nothing for a file it does not hold', async () => {
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'loom-invalidate-')))
    const book = join(folder, 'book.loom')
    const answer = join(folder, 'answer.loom')
    writeFileSync(book, chapter('Book', `${anchor('Answer')}(answer.loom)`))
    writeFileSync(answer, chapter('Answer', 'const answer = 42'))
    const invalidate = (path: string) =>
      runtime.runPromise(LoomCompiler.pipe(Effect.flatMap((compiler) => compiler.invalidate(path))))
    await runtime.runPromise(LoomCompiler.pipe(Effect.flatMap((compiler) => compiler.reach(book))))
    expect([...(await invalidate(answer))].sort()).toEqual([answer, book].sort())
    expect(await invalidate(answer)).toEqual([])
    expect(await invalidate(join(folder, 'nowhere.loom'))).toEqual([])
  })

  it('evicts every held file under a folder and nothing beside it', async () => {
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'loom-invalidate-')))
    const inside = join(folder, 'inside', 'answer.loom')
    const beside = join(folder, 'beside.loom')
    mkdirSync(join(folder, 'inside'))
    writeFileSync(inside, chapter('Answer', 'const answer = 42'))
    writeFileSync(beside, chapter('Beside', 'const beside = 1'))
    const run = <A>(use: (compiler: LoomCompiler['Service']) => Effect.Effect<A>) =>
      runtime.runPromise(LoomCompiler.pipe(Effect.flatMap(use)))
    await run((compiler) => compiler.reach(inside))
    await run((compiler) => compiler.reach(beside))
    expect(await run((compiler) => compiler.invalidateWithin(join(folder, 'inside')))).toEqual([
      inside,
    ])
    expect(await run((compiler) => compiler.invalidate(inside))).toEqual([])
    expect(await run((compiler) => compiler.invalidate(beside))).toEqual([beside])
  })
})
