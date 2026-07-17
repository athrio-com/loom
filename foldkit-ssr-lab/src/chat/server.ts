import '../server/browser-globals'

import { Context, Effect, FileSystem, Layer, Match, Schema as S, Stream } from 'effect'
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
import { messageFeed, view } from './view'
import { ChatMessage, Feed, Model } from './model'
import { messagesOf, sessions } from './conversations'

const root = dirname(fileURLToPath(import.meta.url))
const distDir = join(root, '..', '..', 'dist')

const openChannel = 'general'

const shellModel: Model = {
  sessions,
  activeSessionId: openChannel,
  messages: Feed.Loading(),
  draft: '',
}

const inlineJson = (value: unknown): string => JSON.stringify(value).replace(/</g, '\\u003c')

const encodeModel = S.encodeSync(Model)
const encodeMessages = S.encodeSync(S.Array(ChatMessage))

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

export class ChatSite extends Context.Service<ChatSite>()('ChatSite', {
  make: Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const render = yield* FoldkitRender
    const shell = yield* fs.readFileString(join(distDir, 'chat.html'))
    const shellBody = yield* render.renderToString(view(shellModel).body)
    const [head, tail] = splitOnce(withShell(shell, shellBody), '</body>')

    const messages = messagesOf(openChannel)
    const feedHtml = yield* render.renderToString(messageFeed(messages))
    const fill = boundaryFillChunk(
      'messages',
      feedHtml,
      inlineJson({ sessionId: openChannel, messages: encodeMessages(messages) }),
    )
    return { head, tail, fill } as const
  }),
}) {
  static readonly layer = Layer.effect(this, this.make).pipe(
    Layer.provide(FoldkitRender.layer),
    Layer.provide(BunServices.layer),
  )
}

const encoder = new TextEncoder()

const pageStream = (site: ChatSite['Service']): Stream.Stream<Uint8Array> =>
  Stream.concat(
    Stream.make(encoder.encode(site.head)),
    Stream.fromEffect(
      Effect.as(Effect.sleep('700 millis'), encoder.encode(site.fill + site.tail)),
    ),
  )

const notFound = Effect.succeed(HttpServerResponse.text('Not found', { status: 404 }))

const asset = (pathname: string) =>
  HttpServerResponse.file(join(distDir, pathname)).pipe(Effect.catchCause(() => notFound))

const handle = (site: ChatSite['Service'], pathname: string) =>
  Match.value(pathname).pipe(
    Match.when('/', () =>
      Effect.succeed(HttpServerResponse.stream(pageStream(site), { contentType: 'text/html' })),
    ),
    Match.orElse((path) => asset(path)),
  )

const app = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  const site = yield* ChatSite
  const pathname = new URL(request.url, 'http://localhost').pathname
  return yield* handle(site, pathname)
})

const port = Number(process.env.PORT ?? 4391)

const server = HttpServer.serve(app).pipe(
  HttpServer.withLogAddress,
  Layer.provide(ChatSite.layer),
  Layer.provide(BunHttpServer.layer({ port })),
)

BunRuntime.runMain(Layer.launch(server))
