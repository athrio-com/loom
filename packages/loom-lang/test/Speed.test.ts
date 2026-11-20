import { describe, expect, it } from 'bun:test'
import { Array, Duration, Effect, Layer, ManagedRuntime, Option, Order } from 'effect'
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { LoomConfig } from '@athrio/loom-config/LoomConfig'
import { reach } from '@athrio/loom-ast/LoomCorpusAst'
import { DocumentSource, LoomCompiler } from '../src/LoomCompiler'
import { LoomDiskCache } from '../src/LoomDiskCache'
import { FileSystemSettings } from '../src/WorkspaceSettings'
import { FileSystemSource, WorkspaceSource } from '../src/WorkspaceSource'

const fromNothing = LoomCompiler.layer.pipe(
  Layer.provideMerge(DocumentSource.layer),
  Layer.provideMerge(Layer.mergeAll(FileSystemSource, FileSystemSettings, LoomDiskCache.none)),
  Layer.provideMerge(LoomConfig.layer),
)

const millis = <A, E, R>(work: Effect.Effect<A, E, R>): Effect.Effect<readonly [number, A], E, R> =>
  Effect.timed(work).pipe(
    Effect.map(([spent, result]) => [Duration.toMillis(spent), result] as const),
  )

const recorded = (measure: string, value: number): void =>
  Option.match(Option.fromNullishOr(process.env.LOOM_SPEED), {
    onNone: () => undefined,
    onSome: (file) => appendFileSync(file, `${JSON.stringify({ measure, value })}\n`),
  })

const root = resolve(import.meta.dir, '../../..')

const book = join(root, 'corpus', 'book.loom')

const linesIn = (loom: string): number => readFileSync(loom, 'utf8').split('\n').length

const bookCompiler = ManagedRuntime.make(fromNothing)

const handled = (compiler: LoomCompiler['Service'], loom: string) =>
  compiler.tangle(loom).pipe(Effect.andThen(compiler.diagnose(loom)))

const bookBuilt = Effect.gen(function* () {
  const source = yield* WorkspaceSource
  const compiler = yield* LoomCompiler
  const looms = yield* source.corpusOf(book)
  const [spent] = yield* millis(Effect.forEach(looms, (loom) => handled(compiler, loom)))
  const thousands = looms.reduce((sum, loom) => sum + linesIn(loom), 0) / 1000
  return { looms: looms.length, thousands, spent }
})

describe('the book', () => {
  it('is built from nothing within its budget', async () => {
    const { looms, thousands, spent } = await bookCompiler.runPromise(bookBuilt)
    console.log(
      `speed: the book, ${looms} looms and ${Math.round(thousands)} thousand lines, was built from nothing in ${Math.round(spent)} ms, ${(spent / thousands).toFixed(1)} ms for each thousand lines`,
    )
    recorded('the book, in milliseconds for each thousand lines', spent / thousands)
    expect(spent / thousands).toBeLessThan(65)
  }, 120_000)
})

const typedInto = (documents: DocumentSource['Service'], loom: string, text: string) => ({
  read: (path: string) => (path === loom ? Effect.succeed(text) : documents.read(path)),
  list: documents.list,
})

const keystrokes = Effect.gen(function* () {
  const source = yield* WorkspaceSource
  const compiler = yield* LoomCompiler
  const documents = yield* DocumentSource
  const looms = yield* source.corpusOf(book)
  const longest = looms.reduce(
    (found, loom) => (linesIn(loom) > linesIn(found) ? loom : found),
    book,
  )
  const saved = readFileSync(longest, 'utf8')
  yield* compiler.compile(documents, longest)
  return yield* Effect.forEach(Array.range(1, 5), (stroke) =>
    millis(
      compiler.compile(
        typedInto(documents, longest, saved.replace('\n\n', `\n\nA word ${stroke}. `)),
        longest,
      ),
    ).pipe(Effect.map(([spent]) => spent)),
  )
})

describe('a keystroke in the longest loom of the book', () => {
  it('is answered within its budget', async () => {
    const times = Array.sort(await bookCompiler.runPromise(keystrokes), Order.Number)
    const middle = times[2] ?? Infinity
    console.log(`speed: a keystroke was answered in ${Math.round(middle)} ms`)
    recorded('a keystroke, in milliseconds', middle)
    expect(middle).toBeLessThan(180)
  }, 120_000)
})

const steps = 12

const lines = (...rows: ReadonlyArray<string>): string => `${rows.join('\n')}\n`

const anchor = (name: string): string => `::${'['}${name}]`

const stepName = (batch: number, step: number): string => `Step ${step} of batch ${batch}`

const stepOf = (batch: number, step: number): ReadonlyArray<string> => [
  `## ${stepName(batch, step)}`,
  '',
  `Step ${step} of batch ${batch} adds ${step} to the number it is given.`,
  '',
  '=>',
  '',
  `export const step${batch}x${step} = (given: number): number => given + ${step}`,
  '',
]

const batchOf = (batch: number): string =>
  lines(
    `# Batch ${batch}`,
    '',
    `Batch ${batch} holds ${steps} steps and the file that composes them.`,
    '',
    ...Array.range(1, steps).flatMap((step) => stepOf(batch, step)),
    `## The file of batch ${batch} [src/batch${batch}.ts]`,
    '',
    '=>',
    '',
    ...Array.range(1, steps).flatMap((step) => [anchor(stepName(batch, step)), '']),
    ...(batch > 1 ? [anchor(`Batch 1, ${stepName(1, 1)}`)] : []),
  )

const generated = (count: number): ReadonlyArray<string> => {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'loom-speed-')))
  mkdirSync(join(workspace, '.loom'))
  mkdirSync(join(workspace, 'corpus'))
  writeFileSync(join(workspace, '.loom', 'config.yaml'), 'corpus: corpus\nprimary: typescript\n')
  return Array.range(1, count).map((batch) => {
    const loom = join(workspace, 'corpus', `batch-${batch}.loom`)
    writeFileSync(loom, batchOf(batch))
    return loom
  })
}

const perLoom = (count: number): Promise<number> => {
  const looms = generated(count)
  return Effect.runPromise(
    LoomCompiler.pipe(
      Effect.flatMap((compiler) =>
        millis(Effect.forEach(looms, (loom) => handled(compiler, loom))),
      ),
      Effect.map(([spent]) => spent / count),
      Effect.provide(fromNothing),
    ),
  )
}

describe('a corpus eight times the size', () => {
  it('costs no more for each loom', async () => {
    await perLoom(10)
    const small = await perLoom(50)
    const large = await perLoom(400)
    console.log(
      `speed: a loom took ${small.toFixed(1)} ms among 50 looms and ${large.toFixed(1)} ms among 400`,
    )
    recorded('a loom among 400, in milliseconds', large)
    expect(large / small).toBeLessThan(1.5)
  }, 120_000)
})

const moduleAt = (place: number): string => `/chain/module-${place}.loom`

const chained = (length: number): ((module: string) => ReadonlyArray<string>) => {
  const next = new Map(
    Array.range(1, length - 1).map((place) => [moduleAt(place), [moduleAt(place + 1)]] as const),
  )
  return (module) => next.get(module) ?? []
}

const perLevel = (length: number): Promise<number> => {
  const step = chained(length)
  return Effect.runPromise(
    Effect.forEach(Array.range(1, 7), () =>
      millis(Effect.sync(() => reach([moduleAt(1)], step))),
    ).pipe(
      Effect.map((walks) => Array.sort(walks.map(([spent]) => spent), Order.Number)),
      Effect.map((times) => (times[3] ?? Infinity) / length),
    ),
  )
}

describe('a chain eight times as long', () => {
  it('costs no more for each level', async () => {
    await perLevel(100)
    const short = await perLevel(500)
    const long = await perLevel(4000)
    console.log(
      `speed: a level of a chain took ${(short * 1000).toFixed(2)} µs among 500 levels and ${(long * 1000).toFixed(2)} µs among 4,000`,
    )
    expect(long / short).toBeLessThan(3)
  }, 120_000)
})
