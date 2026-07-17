import './browser-globals'
import { Context, Effect, FileSystem, Layer, Match } from 'effect'
import { HttpServer, HttpServerRequest, HttpServerResponse } from 'effect/unstable/http'
import { BunHttpServer, BunRuntime, BunServices } from '@effect/platform-bun'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PREHYDRATION_CAPTURE_SCRIPT } from '@athrio/foldkit-hydration'
import { FoldkitRender } from '@athrio/foldkit-ssr'
import { view } from '../app/view'
import { type Model } from '../app/model'

const root = dirname(fileURLToPath(import.meta.url))
const distDir = join(root, '..', '..', 'dist')

const seed: Model = {
  todos: [
    { id: '0', text: 'Read the Loom book', done: true },
    { id: '1', text: 'Render a view to an HTML string', done: false },
    { id: '2', text: 'Hydrate it in the browser', done: false },
  ],
  draft: '',
  filter: 'all',
  seq: 3,
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

export class TodoSite extends Context.Service<TodoSite>()('TodoSite', {
  make: Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const render = yield* FoldkitRender
    const shell = yield* fs.readFileString(join(distDir, 'index.html'))
    const body = yield* render.renderToString(view(seed).body)
    const page = withSeed(withBody(shell, body), seed)
    return { page } as const
  }),
}) {
  static readonly layer = Layer.effect(this, this.make).pipe(
    Layer.provide(FoldkitRender.layer),
    Layer.provide(BunServices.layer),
  )
}

const notFound = Effect.succeed(HttpServerResponse.text('Not found', { status: 404 }))

const asset = (pathname: string) =>
  HttpServerResponse.file(join(distDir, pathname)).pipe(Effect.catchCause(() => notFound))

const handle = (site: TodoSite['Service'], pathname: string) =>
  Match.value(pathname).pipe(
    Match.when('/', () =>
      Effect.succeed(HttpServerResponse.text(site.page, { contentType: 'text/html' })),
    ),
    Match.orElse((path) => asset(path)),
  )

const app = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  const site = yield* TodoSite
  const pathname = new URL(request.url, 'http://localhost').pathname
  return yield* handle(site, pathname)
})

const port = Number(process.env.PORT ?? 4390)

const server = HttpServer.serve(app).pipe(
  HttpServer.withLogAddress,
  Layer.provide(TodoSite.layer),
  Layer.provide(BunHttpServer.layer({ port })),
)

BunRuntime.runMain(Layer.launch(server))
