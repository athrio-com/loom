import { Array, Effect, FileSystem, Option, pipe, Schedule } from 'effect'
import { BunRuntime, BunServices } from '@effect/platform-bun'
import { dirname } from 'node:path'
import { bodyOf, readBook } from './pages'
import { indexOf } from './search'
import {
  Embeddings,
  embedAll,
  encodeVector,
  keyOf,
  passageOf,
  readStore,
  type Store,
  storePath,
} from './meaning'

const keptFor = (store: Option.Option<Store>, revision: string): Store =>
  Option.getOrElse(
    Option.filter(store, (kept) => kept.revision === revision),
    (): Store => ({ revision, vectors: {} }),
  )

const embedIndex = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const embeddings = yield* Embeddings
  const revision = yield* embeddings.revision.pipe(Effect.retry(WAITING))
  const kept = keptFor(yield* readStore(fs), revision)
  const index = yield* indexOf(yield* readBook(fs), bodyOf)
  const keyed = pipe(
    Array.map(index, (entry) => ({ entry, key: keyOf(entry) })),
    Array.dedupeWith((one, other) => one.key === other.key),
  )
  const missing = Array.filter(keyed, ({ key }) => !(key in kept.vectors))
  const vectors = yield* embedAll(embeddings, Array.map(missing, ({ entry }) => passageOf(entry)))
  const made = Object.fromEntries(Array.zip(Array.map(missing, ({ key }) => key), Array.map(vectors, encodeVector)))
  const all = { ...kept.vectors, ...made }
  const store: Store = {
    revision,
    vectors: Object.fromEntries(Array.map(keyed, ({ key }) => [key, all[key] ?? ''] as const)),
  }
  yield* fs.makeDirectory(dirname(storePath), { recursive: true })
  yield* fs.writeFileString(storePath, JSON.stringify(store))
  yield* Effect.log(`embedded ${missing.length} of ${keyed.length} entries, kept the rest`)
})

const strict = process.argv.includes('--strict')

const WAITING = strict ? { times: 120, schedule: Schedule.spaced('5 seconds') } : { times: 0 }

const program = strict
  ? embedIndex
  : embedIndex.pipe(
      Effect.catchCause(() =>
        Effect.log('the embedding service is not answering, so the index keeps the vectors it had'),
      ),
    )

program.pipe(Effect.provide(Embeddings.layer), Effect.provide(BunServices.layer), BunRuntime.runMain)
