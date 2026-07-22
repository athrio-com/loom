import './browser-globals'
import { Context, Effect, FileSystem, Layer, Match, Schema as S } from 'effect'
import {
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from 'effect/unstable/http'
import { BunHttpServer, BunRuntime, BunServices } from '@effect/platform-bun'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderStatic } from 'foldkit/html'
import { PREHYDRATION_CAPTURE_SCRIPT } from '@athrio/foldkit-hydration/prehydration'
import { FoldkitRender } from '@athrio/foldkit-ssr'
import { view } from './view'
import { type Model } from './model'
import * as Gomoku from '../../examples/gomoku/gomoku'

const distDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist')

const seed: Model = {
  rotatorIndex: 0,
  rotatorPhase: 'normal',
  activeSection: '',
  exampleTab: 'loom',
  loomView: 'preview',
  exampleExpanded: false,
  game: Gomoku.newGame(),
  version: '0.0.9',
  query: '',
  focus: 0,
  copied: '',
}

const inlineJson = (value: unknown): string =>
  JSON.stringify(value).replace(/</g, '\\u003c')

const withBody = (shell: string, body: string): string =>
  shell.replace('<div id="root"></div>', () => `<div id="root">${body}</div>`)

const withSeed = (shell: string, model: Model): string =>
  shell.replace(
    '</head>',
    () =>
      `<script>${PREHYDRATION_CAPTURE_SCRIPT}</script>` +
      `<script id="foldkit-model" type="application/json">${inlineJson(model)}</script></head>`,
  )

const NPM_LATEST = 'https://registry.npmjs.org/@athrio/loom/latest'

const Release = S.Struct({ version: S.String })

const latestVersion = (fallback: string): Effect.Effect<string> =>
  Effect.tryPromise(() =>
    fetch(NPM_LATEST)
      .then((response) => response.json())
      .then((body) => S.decodeUnknownSync(Release)(body).version),
  ).pipe(Effect.catchCause(() => Effect.succeed(fallback)))

export class LandingSite extends Context.Service<LandingSite>()('LandingSite', {
  make: Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const render = yield* FoldkitRender
    const shell = yield* fs.readFileString(join(distDir, 'index.html'))
    const version = yield* latestVersion(seed.version)
    const model = { ...seed, version }
    const body = yield* render.renderToString(renderStatic(() => view(model).body))
    return { page: withSeed(withBody(shell, body), model) } as const
  }),
}) {
  static readonly layer = Layer.effect(this, this.make).pipe(
    Layer.provide(FoldkitRender.layer),
    Layer.provide(BunServices.layer),
  )
}

const notFound = Effect.succeed(
  HttpServerResponse.text('Not found', { status: 404 }),
)

const asset = (pathname: string) =>
  HttpServerResponse.file(join(distDir, pathname)).pipe(
    Effect.catchCause(() => notFound),
  )

const handle = (site: LandingSite['Service'], pathname: string) =>
  Match.value(pathname).pipe(
    Match.when('/', () =>
      Effect.succeed(
        HttpServerResponse.text(site.page, { contentType: 'text/html' }),
      ),
    ),
    Match.orElse((path) => asset(path)),
  )

const app = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  const site = yield* LandingSite
  const pathname = new URL(request.url, 'http://localhost').pathname
  return yield* handle(site, pathname)
})

const port = Number(process.env.PORT ?? 5199)

const server = HttpServer.serve(app).pipe(
  HttpServer.withLogAddress,
  Layer.provide(LandingSite.layer),
  Layer.provide(BunHttpServer.layer({ port })),
)

BunRuntime.runMain(Layer.launch(server))
