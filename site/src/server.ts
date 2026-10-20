import { Cache, Context, Effect, Fiber, FileSystem, Layer, Option, pipe, Schema as S } from 'effect'
import { HttpServer, HttpServerRequest, HttpServerResponse } from 'effect/http'
import { BunHttpServer, BunRuntime, BunServices } from '@effect/platform-bun'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Server } from 'foldkit/experimental'
import { view } from './view'
import { Corpus, Model, routeOf, SearchGroup, type Route } from './model'
import { chapterAt, docsChapterAt, sliceOf } from './docs-page'
import { indexOf, searchIn } from './search'
import { colouredCorpus, makeHighlighter } from './colour'

const distDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist')

const seed: Model = {
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
  version: '0.0.14',
  query: '',
  focus: 0,
  copied: '',
  book: Option.none(),
}

const NPM_LATEST = 'https://registry.npmjs.org/@athrio/loom/latest'

const Release = S.Struct({ version: S.String })

const latestVersion = (fallback: string): Effect.Effect<string> =>
  Effect.tryPromise((signal) =>
    fetch(NPM_LATEST, { signal })
      .then((response) => response.json())
      .then((body) => S.decodeUnknownSync(Release)(body).version),
  ).pipe(
    Effect.timeout('2 seconds'),
    Effect.catchCause(() => Effect.succeed(fallback)),
  )

const bookFile = join(dirname(fileURLToPath(import.meta.url)), 'source.woven.json')

const decodeBook = S.decodeUnknownOption(Corpus)

const readBook = (fs: FileSystem.FileSystem): Effect.Effect<Option.Option<Corpus>> =>
  fs.readFileString(bookFile).pipe(
    Effect.map((text) =>
      Option.flatMap(Option.liftThrowable((json: string): unknown => JSON.parse(json))(text), decodeBook),
    ),
    Effect.catchCause(() => Effect.succeed(Option.none())),
  )

const application = {
  Flags: Model,
  init: (model: Model) => ({ model }),
  view,
}

const ENTRY = /<script type="module"[^>]*\ssrc="([^"]+)"/

const entryOf = (shell: string): Effect.Effect<string> =>
  Option.match(Option.fromNullishOr(ENTRY.exec(shell)?.[1]), {
    onNone: () => Effect.die(new Error('the shell loads no entry script')),
    onSome: Effect.succeed,
  })

const pageOf = (shell: string, model: Model): Effect.Effect<string> =>
  Effect.gen(function* () {
    const buildId = yield* entryOf(shell)
    const rendered = yield* Server.renderToString(application, { flags: model, buildId })
    return Server.injectIntoTemplate(shell, rendered)
  }).pipe(Effect.orDie)

const bodyOf =
  (version: string) =>
  (route: Route): Effect.Effect<string> =>
    Server.renderToString(application, { flags: { ...seed, route, version }, buildId: 'search' }).pipe(
      Effect.map((rendered) => rendered.html),
      Effect.orDie,
    )

const PAGE_STYLE = `
      :root { --paper: #F7F4EC; --ink: #14130F; --ink-3: #7C6F64; --rule: #E4DCCB; }
      body {
        margin: 0;
        min-height: 100vh;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 24px;
        padding: 40px;
        background: var(--paper);
        color: var(--ink);
        font-family: 'Lilex', 'IBM Plex Mono', ui-monospace, monospace;
        text-align: center;
      }
      .number { font-size: 46px; letter-spacing: 0.02em; }
      .headline { font-size: 24px; letter-spacing: 0.01em; }
      .line { margin: 0; max-width: 52ch; line-height: 1.7; color: var(--ink-3); }
      .line code { color: var(--ink); }
      .back {
        color: var(--ink);
        text-decoration: none;
        padding-bottom: 3px;
        border-bottom: 1px solid var(--rule);
      }
      .back:hover { color: var(--ink-3); }
`

const standalone = (title: string, body: string): string => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <style>${PAGE_STYLE}</style>
  </head>
  <body>${body}
  </body>
</html>
`

const MISSING = standalone(
  'Not found — Loom',
  `
    <img src="/mark.svg" alt="Loom" width="140" height="60" />
    <div class="number">404</div>
    <p class="line">There is no page at this address.</p>
    <a class="back" href="/">Back to Loom</a>`,
)

const notFound = Effect.succeed(
  HttpServerResponse.text(MISSING, { status: 404, contentType: 'text/html' }),
)

const NOT_BUILT = standalone(
  'Not built — Loom',
  `
    <div class="headline">The site is not built</div>
    <p class="line">The server renders from <code>dist</code>, and nothing is there yet. Run <code>bun run build</code>, or <code>bun run dev</code> to keep it building.</p>`,
)

type Place = { readonly route: Route; readonly chapter: string }

const placeOf = (book: Option.Option<Corpus>, pathname: string): Option.Option<Place> =>
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

export class Site extends Context.Service<Site>()('Site', {
  make: Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const book = yield* readBook(fs)
    const latest = yield* Effect.forkScoped(latestVersion(seed.version))
    const highlighter = yield* Effect.forkScoped(makeHighlighter)
    const index = yield* Effect.cached(
      Effect.flatMap(Fiber.join(latest), (version) => indexOf(book, bodyOf(version))),
    )
    const slices = yield* Cache.make({
      capacity: Option.match(book, { onNone: () => 1, onSome: (corpus) => corpus.pages.length + 1 }),
      lookup: (chapter: string) =>
        Effect.map(Fiber.join(highlighter), (shiki) =>
          Option.map(book, (corpus) => colouredCorpus(shiki, sliceOf(corpus, chapter))),
        ),
    })
    const bookFor = (place: Place): Effect.Effect<Option.Option<Corpus>> =>
      place.route === 'source' ? Cache.get(slices, place.chapter) : Effect.succeed(Option.none())
    const shell = fs.readFileString(join(distDir, 'index.html'))
    return {
      pageAt: (url: URL): Effect.Effect<Option.Option<string>> =>
        Option.match(placeOf(book, url.pathname), {
          onNone: () => Effect.succeed(Option.none()),
          onSome: (place) =>
            shell.pipe(
              Effect.matchEffect({
                onFailure: () => Effect.succeed(NOT_BUILT),
                onSuccess: (held) =>
                  Effect.gen(function* () {
                    const version = yield* Fiber.join(latest)
                    const slice = yield* bookFor(place)
                    return yield* pageOf(held, { ...seed, ...place, version, book: slice })
                  }),
              }),
              Effect.map(Option.some),
            ),
        }),
      assetAt: (url: URL) =>
        HttpServerResponse.file(join(distDir, url.pathname)).pipe(
          Effect.catchCause(() => notFound),
        ),
      searchAt: (url: URL): Effect.Effect<HttpServerResponse.HttpServerResponse> =>
        Effect.flatMap(index, (entries) =>
          HttpServerResponse.schemaJson(S.Array(SearchGroup))(
            searchIn(entries, url.searchParams.get('q') ?? ''),
          ),
        ).pipe(Effect.orDie),
    } as const
  }),
}) {
  static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(BunServices.layer))
}

const SEARCH = '/search'

const handle = (site: Site['Service'], url: URL) =>
  url.pathname === SEARCH
    ? site.searchAt(url)
    : Effect.flatMap(
        site.pageAt(url),
        Option.match({
          onSome: (page) => Effect.succeed(HttpServerResponse.text(page, { contentType: 'text/html' })),
          onNone: () => site.assetAt(url),
        }),
      )

const app = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  const site = yield* Site
  return yield* handle(site, new URL(request.url, 'http://localhost'))
})

const port = Number(process.env.PORT ?? 5199)

const server = HttpServer.serve(app).pipe(
  HttpServer.withLogAddress,
  Layer.provide(BunHttpServer.layer({ port })),
  Layer.provide(Site.layer),
)

BunRuntime.runMain(Layer.launch(server))
