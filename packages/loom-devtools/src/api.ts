import { Effect, Layer, Option, PubSub, Schema } from 'effect'
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from 'effect/unstable/http'
import { McpServer } from 'effect/unstable/ai'
import { NodeHttpServer } from '@effect/platform-node'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DraftSchema } from './note'
import { NoteStore } from './store'
import { handlers, toolkit } from './mcp'

const SeqBody = Schema.Struct({ project: Schema.String, seq: Schema.Number })
const EditBody = Schema.Struct({ project: Schema.String, seq: Schema.Number, text: Schema.String })

const notFound = Effect.succeed(HttpServerResponse.text('Not found', { status: 404 }))

const root = dirname(fileURLToPath(import.meta.url))

const capture = Effect.gen(function* () {
  const store = yield* NoteStore
  const draft = yield* HttpServerRequest.schemaBodyJson(DraftSchema)
  const note = yield* store.record(draft)
  return yield* HttpServerResponse.json(note)
})

const resolve = Effect.gen(function* () {
  const store = yield* NoteStore
  const { project, seq } = yield* HttpServerRequest.schemaBodyJson(SeqBody)
  yield* store.resolve(project, seq)
  return yield* HttpServerResponse.json({ ok: true })
})

const discard = Effect.gen(function* () {
  const store = yield* NoteStore
  const { project, seq } = yield* HttpServerRequest.schemaBodyJson(SeqBody)
  yield* store.discard(project, seq)
  return yield* HttpServerResponse.json({ ok: true })
})

const edit = Effect.gen(function* () {
  const store = yield* NoteStore
  const { project, seq, text } = yield* HttpServerRequest.schemaBodyJson(EditBody)
  yield* store.edit(project, seq, text)
  return yield* HttpServerResponse.json({ ok: true })
})

const feed = Effect.gen(function* () {
  const store = yield* NoteStore
  const request = yield* HttpServerRequest.HttpServerRequest
  const project = new URL(request.url, 'http://localhost').searchParams.get('project')
  return yield* Option.match(Option.fromNullishOr(project), {
    onNone: () => Effect.succeed(HttpServerResponse.text('project is required', { status: 400 })),
    onSome: (found) =>
      store.list(found).pipe(Effect.flatMap((notes) => HttpServerResponse.json(notes))),
  })
})

const noCache = { 'cache-control': 'no-store' }

const overlay = HttpServerResponse.file(join(root, '..', 'dist', 'overlay.js'), {
  headers: noCache,
}).pipe(
  Effect.catchCause((cause) =>
    Effect.logWarning('could not read the overlay script', cause).pipe(Effect.andThen(notFound)),
  ),
)

const page = HttpServerResponse.file(join(root, 'ui.html'), {
  headers: noCache,
}).pipe(
  Effect.catchCause((cause) =>
    Effect.logWarning('could not read the setup page', cause).pipe(Effect.andThen(notFound)),
  ),
)

const uiScript = HttpServerResponse.file(join(root, '..', 'dist', 'ui.js'), {
  headers: noCache,
}).pipe(
  Effect.catchCause((cause) =>
    Effect.logWarning('could not read the setup script', cause).pipe(Effect.andThen(notFound)),
  ),
)

const live = Effect.gen(function* () {
  const store = yield* NoteStore
  const request = yield* HttpServerRequest.HttpServerRequest
  const project = new URL(request.url, 'http://localhost').searchParams.get('project')
  return yield* Option.match(Option.fromNullishOr(project), {
    onNone: () => Effect.succeed(HttpServerResponse.text('project is required', { status: 400 })),
    onSome: (found) =>
      Effect.gen(function* () {
        const socket = yield* request.upgrade
        const write = yield* socket.writer
        const subscription = yield* PubSub.subscribe(store.changes)
        const pushMatching = Effect.forever(
          PubSub.take(subscription).pipe(
            Effect.flatMap((note) =>
              note.project === found ? write(JSON.stringify(note)) : Effect.void,
            ),
          ),
        )
        yield* Effect.race(pushMatching, socket.run(() => Effect.void))
        return HttpServerResponse.empty()
      }).pipe(
        Effect.catchCause((cause) => Effect.logDebug('a live notes socket closed', cause)),
        Effect.as(HttpServerResponse.empty()),
      ),
  })
})

const handling = <R>(
  work: Effect.Effect<HttpServerResponse.HttpServerResponse, unknown, R>,
): Effect.Effect<HttpServerResponse.HttpServerResponse, never, R> =>
  work.pipe(
    Effect.catchCause((cause) =>
      Effect.logError('a notes request failed', cause).pipe(
        Effect.as(HttpServerResponse.text('The notes store failed', { status: 500 })),
      ),
    ),
  )

const routes = Layer.mergeAll(
  HttpRouter.add('POST', '/notes/capture', handling(capture)),
  HttpRouter.add('GET', '/notes/feed', handling(feed)),
  HttpRouter.add('GET', '/notes/live', live),
  HttpRouter.add('POST', '/notes/resolve', handling(resolve)),
  HttpRouter.add('POST', '/notes/discard', handling(discard)),
  HttpRouter.add('POST', '/notes/edit', handling(edit)),
  HttpRouter.add('GET', '/notes.js', overlay),
  HttpRouter.add('GET', '/ui.js', uiScript),
  HttpRouter.add('GET', '/', page),
)

const mcp = McpServer.toolkit(toolkit).pipe(
  Layer.provide(handlers),
  Layer.provide(McpServer.layerHttp({ name: 'loom', version: '0.0.9', path: '/mcp' })),
)

import { Logger } from 'effect'

export const devtoolsLogger = Logger.layer([Logger.consoleLogFmt])

const app = Layer.mergeAll(
  routes,
  mcp,
  HttpRouter.cors({ allowedMethods: ['GET', 'POST'], allowedHeaders: ['Content-Type'] }),
)

export const notesServer = (
  port: number,
  store: Layer.Layer<NoteStore> = NoteStore.layer,
) =>
  HttpRouter.serve(app).pipe(
    Layer.provide(store),
    Layer.provide(NodeHttpServer.layer(() => createServer(), { port })),
  )
