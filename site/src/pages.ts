import { Array, Effect, FileSystem, Option, pipe, Schema as S } from 'effect'
import { basename, dirname, extname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { Server } from 'foldkit/experimental'
import { view } from './view'
import { Corpus, Model, pathOf, Route, routeOf } from './model'
import { chapterAt, chapterPath, docsChapterAt, docsCorpus, sliceOf } from './docs-page'

const here = dirname(fileURLToPath(import.meta.url))

export const seed: Model = {
  route: 'home',
  chapter: '',
  drawerOpen: false,
  runtime: 'bun',
  searchOpen: false,
  caret: 0,
  searching: false,
  found: [],
  activeSection: '',
  player: { struck: 0, beat: 0, playing: false, output: Option.none(), full: false },
  version: '0.0.15',
  query: '',
  exact: false,
  focus: 0,
  copied: '',
  book: Option.none(),
}

const bookFile = join(here, 'source.coloured.json')

const decodeBook = S.decodeUnknownOption(Corpus)

export const readBook = (fs: FileSystem.FileSystem): Effect.Effect<Option.Option<Corpus>> =>
  fs.readFileString(bookFile).pipe(
    Effect.map((text) =>
      Option.flatMap(Option.liftThrowable((json: string): unknown => JSON.parse(json))(text), decodeBook),
    ),
    Effect.catchCause(() => Effect.succeed(Option.none())),
  )

export const bookStampOf = (fs: FileSystem.FileSystem): Effect.Effect<string> =>
  fs.readFile(bookFile).pipe(
    Effect.map((bytes) => createHash('sha256').update(bytes).digest('hex').slice(0, 10)),
    Effect.catchCause(() => Effect.succeed('no-book')),
  )

const application = {
  Flags: Model,
  init: (model: Model) => ({ model }),
  view,
}

const ENTRY = /<script type="module"[^>]*\ssrc="([^"]+)"/

export const entryOf = (shell: string): Effect.Effect<string> =>
  Option.match(Option.fromNullishOr(ENTRY.exec(shell)?.[1]), {
    onNone: () => Effect.die(new Error('the shell loads no entry script')),
    onSome: Effect.succeed,
  })

export const pageOf = (shell: string, model: Model): Effect.Effect<string> =>
  Effect.gen(function* () {
    const buildId = yield* entryOf(shell)
    const rendered = yield* Server.renderToString(application, { flags: model, buildId })
    return Server.injectIntoTemplate(shell, rendered)
  }).pipe(Effect.orDie)

export const bodyOf = (route: Route): Effect.Effect<string> =>
  Server.renderToString(application, { flags: { ...seed, route }, buildId: 'search' }).pipe(
    Effect.map((rendered) => rendered.html),
    Effect.orDie,
  )

export type Place = { readonly route: Route; readonly chapter: string }

export const placeOf = (book: Option.Option<Corpus>, pathname: string): Option.Option<Place> =>
  pipe(
    routeOf(pathname),
    Option.filter((route) => route !== 'source' || Option.isSome(book)),
    Option.map((route): Place => ({ route, chapter: '' })),
    Option.orElse(() =>
      Option.map(docsChapterAt(pathname), (chapter): Place => ({ route: 'docs', chapter })),
    ),
    Option.orElse(() =>
      Option.flatMap(book, (corpus) =>
        Option.map(
          chapterAt(corpus, '/source', pathname),
          (chapter): Place => ({ route: 'source', chapter }),
        ),
      ),
    ),
  )

const bookFor = (book: Option.Option<Corpus>, place: Place): Option.Option<Corpus> =>
  place.route === 'source'
    ? Option.map(book, (corpus) => sliceOf(corpus, place.chapter))
    : Option.none()

export const modelAt = (book: Option.Option<Corpus>, place: Place): Model => ({
  ...seed,
  ...place,
  book: bookFor(book, place),
})

export const everyAddress = (book: Option.Option<Corpus>): ReadonlyArray<string> => [
  ...Array.map(Route.literals, pathOf),
  ...Array.map(docsCorpus.pages, (page) => chapterPath('/docs', page.slug)),
  ...Option.match(book, {
    onNone: () => [],
    onSome: (corpus) => Array.map(corpus.pages, (page) => chapterPath('/source', page.slug)),
  }),
]

export const distDir = join(here, '..', 'dist')

export const PAGES_DIR = join(distDir, 'pages')

export const pageFileOf = (buildId: string, bookStamp: string, address: string): string =>
  join(
    PAGES_DIR,
    `${basename(buildId, extname(buildId))}-${bookStamp}`,
    `${address === '/' ? 'index' : address.slice(1)}.html`,
  )
