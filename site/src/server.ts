import { Cache, Context, Effect, FileSystem, Layer, Option, Schema as S } from 'effect'
import { HttpServer, HttpServerRequest, HttpServerResponse } from 'effect/http'
import { BunHttpServer, BunRuntime, BunServices } from '@effect/platform-bun'
import { join } from 'node:path'
import { Route, SearchGroup } from './model'
import { docsCorpus } from './docs-page'
import { type Entry, groupsOf, indexOf, searchIn } from './search'
import { Meaning } from './meaning'
import {
  bodyOf,
  distDir,
  entryOf,
  modelAt,
  pageFileOf,
  pageOf,
  placeOf,
  readBook,
  type Place,
} from './pages'

const PAGE_STYLE = `
      :root { color-scheme: light dark; --paper: #F7F4EC; --ink: #14130F; --ink-3: #7C6F64; --rule: #E4DCCB; }
      @media (prefers-color-scheme: dark) {
        :root { --paper: #141821; --ink: #E6E9EF; --ink-3: #8790A3; --rule: #2F384A; }
      }
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
    <link rel="icon" type="image/svg+xml" href="/languages/loom.svg" />
    <style>${PAGE_STYLE}</style>
  </head>
  <body>${body}
  </body>
</html>
`

const MISSING = standalone(
  'Not found — Loom',
  `
    <picture>
      <source srcset="/mark-dark.svg" media="(prefers-color-scheme: dark)" />
      <img src="/mark.svg" alt="Loom" width="140" height="60" />
    </picture>
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

type PageKey = { readonly place: Place; readonly shell: string }

const decodeRoute = S.decodeUnknownOption(Route)

export class Site extends Context.Service<Site>()('Site', {
  make: Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const meaning = yield* Meaning
    const book = yield* readBook(fs)
    const bookChapters = Option.match(book, {
      onNone: () => 0,
      onSome: (corpus) => corpus.pages.length,
    })
    const index = yield* Effect.cached(indexOf(book, bodyOf))
    const rendered = yield* Cache.make({
      capacity: Route.literals.length + docsCorpus.pages.length + bookChapters,
      lookup: (key: PageKey) => pageOf(key.shell, modelAt(book, key.place)),
    })
    const pageIn = (shell: string, place: Place, address: string): Effect.Effect<string> =>
      Effect.flatMap(entryOf(shell), (buildId) =>
        fs
          .readFileString(pageFileOf(buildId, address))
          .pipe(Effect.catchCause(() => Cache.get(rendered, { place, shell }))),
      )
    const shell = fs.readFileString(join(distDir, 'index.html'))
    return {
      pageAt: (url: URL): Effect.Effect<Option.Option<string>> =>
        Option.match(placeOf(book, url.pathname), {
          onNone: () => Effect.succeed(Option.none()),
          onSome: (place) =>
            shell.pipe(
              Effect.matchEffect({
                onFailure: () => Effect.succeed(NOT_BUILT),
                onSuccess: (held) => pageIn(held, place, url.pathname),
              }),
              Effect.map(Option.some),
            ),
        }),
      assetAt: (url: URL) =>
        HttpServerResponse.file(join(distDir, url.pathname)).pipe(
          Effect.catchCause(() => notFound),
        ),
      searchAt: (url: URL): Effect.Effect<HttpServerResponse.HttpServerResponse> => {
        const query = url.searchParams.get('q') ?? ''
        const from = Option.getOrElse(decodeRoute(url.searchParams.get('from')), (): Route => 'home')
        const byWords = (entries: ReadonlyArray<Entry>) => Effect.succeed(searchIn(entries, query, from))
        const byMeaning = (entries: ReadonlyArray<Entry>) =>
          Effect.map(
            meaning.rank(entries, query),
            Option.match({
              onNone: () => searchIn(entries, query, from),
              onSome: (results) => groupsOf(results, from),
            }),
          )
        return Effect.flatMap(index, (entries) =>
          url.searchParams.get('exact') === '1' ? byWords(entries) : byMeaning(entries),
        ).pipe(
          Effect.flatMap(HttpServerResponse.schemaJson(S.Array(SearchGroup))),
          Effect.orDie,
        )
      },
    } as const
  }),
}) {
  static readonly layer = Layer.effect(this, this.make).pipe(
    Layer.provide(BunServices.layer),
    Layer.provide(Meaning.layer),
  )
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
