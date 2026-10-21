import { Array, Effect, FileSystem, Option } from 'effect'
import { BunRuntime, BunServices } from '@effect/platform-bun'
import { dirname, join } from 'node:path'
import type { Corpus } from './model'
import {
  bookStampOf,
  distDir,
  entryOf,
  everyAddress,
  modelAt,
  PAGES_DIR,
  pageFileOf,
  pageOf,
  placeOf,
  readBook,
  type Place,
} from './pages'

type Page = { readonly address: string; readonly place: Place }

const pagesOf = (book: Option.Option<Corpus>): ReadonlyArray<Page> =>
  Array.getSomes(
    Array.map(everyAddress(book), (address) =>
      Option.map(placeOf(book, address), (place): Page => ({ address, place })),
    ),
  )

const renderAhead = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const shell = yield* fs.readFileString(join(distDir, 'index.html'))
  const buildId = yield* entryOf(shell)
  const book = yield* readBook(fs)
  const bookStamp = yield* bookStampOf(fs)
  yield* fs.remove(PAGES_DIR, { recursive: true, force: true })
  const written = yield* Effect.forEach(pagesOf(book), ({ address, place }) =>
    Effect.gen(function* () {
      const file = pageFileOf(buildId, bookStamp, address)
      const page = yield* pageOf(shell, modelAt(book, place))
      yield* fs.makeDirectory(dirname(file), { recursive: true })
      yield* fs.writeFileString(file, page)
    }),
  )
  yield* Effect.log(`rendered ${written.length} pages ahead for ${buildId} and book ${bookStamp}`)
})

renderAhead.pipe(Effect.provide(BunServices.layer), BunRuntime.runMain)
