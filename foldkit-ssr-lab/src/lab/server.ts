import '../server/browser-globals'
import { Array, Context, Duration, Effect, FileSystem, Layer, Match, Schema as S, Stream } from 'effect'
import { HttpServer, HttpServerRequest, HttpServerResponse } from 'effect/unstable/http'
import { BunHttpServer, BunRuntime, BunServices } from '@effect/platform-bun'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PREHYDRATION_CAPTURE_SCRIPT,
  STREAMING_FILL_SCRIPT,
  boundaryFillChunk,
} from '@athrio/foldkit-hydration'
import { FoldkitRender } from '@athrio/foldkit-ssr'
import { loadedBody, view } from './view'
import { Model } from './model'
import { bodyOf, initialCards } from './cards'

const root = dirname(fileURLToPath(import.meta.url))
const distDir = join(root, '..', '..', 'dist')

const shellModel: Model = { cards: initialCards, log: [] }

const streamingPlan: ReadonlyArray<{ readonly id: string; readonly deltaMs: number }> = [
  { id: 'feed', deltaMs: 300 },
  { id: 'reco', deltaMs: 400 },
]

const inlineJson = (value: unknown): string => JSON.stringify(value).replace(/</g, '\\u003c')

const encodeModel = S.encodeSync(Model)

const bootScripts =
  `<script>${PREHYDRATION_CAPTURE_SCRIPT}</script>` +
  `<script>${STREAMING_FILL_SCRIPT}</script>`

const withShell = (shell: string, body: string): string =>
  shell
    .replace('<div id="root"></div>', () => `<div id="root">${body}</div>`)
    .replace(
      '</head>',
      () =>
        `${bootScripts}<script id="foldkit-model" type="application/json">${inlineJson(
          encodeModel(shellModel),
        )}</script></head>`,
    )

const splitOnce = (text: string, marker: string): readonly [string, string] => {
  const index = text.indexOf(marker)
  return index < 0 ? [text, ''] : [text.slice(0, index), text.slice(index)]
}

export class LabSite extends Context.Service<LabSite>()('LabSite', {
  make: Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const render = yield* FoldkitRender
    const shell = yield* fs.readFileString(join(distDir, 'lab.html'))
    const shellBody = yield* render.renderToString(view(shellModel).body)
    const [head, tail] = splitOnce(withShell(shell, shellBody), '</body>')

    const fills = yield* Effect.forEach(streamingPlan, (plan) =>
      Effect.gen(function* () {
        const body = bodyOf(plan.id)
        const html = yield* render.renderToString(loadedBody(body))
        return { deltaMs: plan.deltaMs, chunk: boundaryFillChunk(plan.id, html, inlineJson(body)) }
      }),
    )
    return { head, tail, fills } as const
  }),
}) {
  static readonly layer = Layer.effect(this, this.make).pipe(
    Layer.provide(FoldkitRender.layer),
    Layer.provide(BunServices.layer),
  )
}

const encoder = new TextEncoder()

const pageStream = (site: LabSite['Service']): Stream.Stream<Uint8Array> => {
  const withFills = Array.reduce(
    site.fills,
    Stream.make(encoder.encode(site.head)),
    (stream, fill) =>
      Stream.concat(
        stream,
        Stream.fromEffect(
          Effect.as(Effect.sleep(Duration.millis(fill.deltaMs)), encoder.encode(fill.chunk)),
        ),
      ),
  )
  return Stream.concat(withFills, Stream.make(encoder.encode(site.tail)))
}

const notFound = Effect.succeed(HttpServerResponse.text('Not found', { status: 404 }))

const asset = (pathname: string) =>
  HttpServerResponse.file(join(distDir, pathname)).pipe(Effect.catchCause(() => notFound))

const handle = (site: LabSite['Service'], pathname: string) =>
  Match.value(pathname).pipe(
    Match.when('/', () =>
      Effect.succeed(HttpServerResponse.stream(pageStream(site), { contentType: 'text/html' })),
    ),
    Match.orElse((path) => asset(path)),
  )

const app = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  const site = yield* LabSite
  const pathname = new URL(request.url, 'http://localhost').pathname
  return yield* handle(site, pathname)
})

const port = Number(process.env.PORT ?? 4394)

const server = HttpServer.serve(app).pipe(
  HttpServer.withLogAddress,
  Layer.provide(LabSite.layer),
  Layer.provide(BunHttpServer.layer({ port })),
)

BunRuntime.runMain(Layer.launch(server))
