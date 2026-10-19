import { Context, Effect, FileSystem, Layer, Option, pipe, Schema as S } from 'effect'
import { HttpServer, HttpServerRequest, HttpServerResponse } from 'effect/http'
import { BunHttpServer, BunRuntime, BunServices } from '@effect/platform-bun'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Server } from 'foldkit/experimental'
import { view } from './view'
import { Model, routeOf, type Route } from './model'
import { docsChapterAt } from './docs-page'

const distDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist')

const seed: Model = {
  route: 'home',
  chapter: '',
  drawerOpen: false,
  runtime: 'bun',
  searchOpen: false,
  caret: 0,
  searching: false,
  activeSection: '',
  player: { struck: 0, beat: 0, playing: false, output: Option.none(), full: false },
  version: '0.0.13',
  query: '',
  focus: 0,
  copied: '',
}

const NPM_LATEST = 'https://registry.npmjs.org/@athrio/loom/latest'

const Release = S.Struct({ version: S.String })

const latestVersion = (fallback: string): Effect.Effect<string> =>
  Effect.tryPromise(() =>
    fetch(NPM_LATEST)
      .then((response) => response.json())
      .then((body) => S.decodeUnknownSync(Release)(body).version),
  ).pipe(Effect.catchCause(() => Effect.succeed(fallback)))

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

const placeOf = (pathname: string): Option.Option<Place> =>
  pipe(
    routeOf(pathname),
    Option.map((route): Place => ({ route, chapter: '' })),
    Option.orElse(() =>
      Option.map(docsChapterAt(pathname), (chapter): Place => ({ route: 'docs', chapter })),
    ),
  )

export class Site extends Context.Service<Site>()('Site', {
  make: Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const version = yield* latestVersion(seed.version)
    const shell = fs.readFileString(join(distDir, 'index.html'))
    return {
      pageAt: (url: URL): Effect.Effect<Option.Option<string>> =>
        Option.match(placeOf(url.pathname), {
          onNone: () => Effect.succeed(Option.none()),
          onSome: (place) =>
            shell.pipe(
              Effect.matchEffect({
                onFailure: () => Effect.succeed(NOT_BUILT),
                onSuccess: (held) => pageOf(held, { ...seed, ...place, version }),
              }),
              Effect.map(Option.some),
            ),
        }),
      assetAt: (url: URL) =>
        HttpServerResponse.file(join(distDir, url.pathname)).pipe(
          Effect.catchCause(() => notFound),
        ),
    } as const
  }),
}) {
  static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(BunServices.layer))
}

const handle = (site: Site['Service'], url: URL) =>
  Effect.flatMap(
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
  Layer.provide(Site.layer),
  Layer.provide(BunHttpServer.layer({ port })),
)

BunRuntime.runMain(Layer.launch(server))
