import { Effect, Layer, Match, Option, Schema } from 'effect'
import {
  HttpMiddleware,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from 'effect/unstable/http'
import { BunHttpServer } from '@effect/platform-bun'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DraftSchema } from '@athrio/loom-notes/note'
import { NoteStore } from './store'

const SeqBody = Schema.Struct({ project: Schema.String, seq: Schema.Number })
const EditBody = Schema.Struct({ project: Schema.String, seq: Schema.Number, text: Schema.String })

const notFound = Effect.succeed(HttpServerResponse.text('Not found', { status: 404 }))

const root = dirname(fileURLToPath(import.meta.url))

type Store = NoteStore['Service']

const capture = (store: Store) =>
  HttpServerRequest.schemaBodyJson(DraftSchema).pipe(
    Effect.flatMap((draft) => store.record(draft)),
    Effect.flatMap((note) => HttpServerResponse.json(note)),
  )

const resolve = (store: Store) =>
  HttpServerRequest.schemaBodyJson(SeqBody).pipe(
    Effect.flatMap(({ project, seq }) => store.resolve(project, seq)),
    Effect.flatMap(() => HttpServerResponse.json({ ok: true })),
  )

const discard = (store: Store) =>
  HttpServerRequest.schemaBodyJson(SeqBody).pipe(
    Effect.flatMap(({ project, seq }) => store.discard(project, seq)),
    Effect.flatMap(() => HttpServerResponse.json({ ok: true })),
  )

const edit = (store: Store) =>
  HttpServerRequest.schemaBodyJson(EditBody).pipe(
    Effect.flatMap(({ project, seq, text }) => store.edit(project, seq, text)),
    Effect.flatMap(() => HttpServerResponse.json({ ok: true })),
  )

const feed = (store: Store, url: URL) =>
  Option.match(Option.fromNullishOr(url.searchParams.get('project')), {
    onNone: () => Effect.succeed(HttpServerResponse.text('project is required', { status: 400 })),
    onSome: (project) =>
      store.list(project).pipe(Effect.flatMap((notes) => HttpServerResponse.json(notes))),
  })

const overlay = HttpServerResponse.file(join(root, '..', 'dist', 'overlay.js')).pipe(
  Effect.catchCause(() => notFound),
)

const handle = (store: Store, method: string, url: URL) =>
  Match.value({ method, path: url.pathname }).pipe(
    Match.when({ method: 'POST', path: '/notes/capture' }, () => capture(store)),
    Match.when({ method: 'GET', path: '/notes/feed' }, () => feed(store, url)),
    Match.when({ method: 'POST', path: '/notes/resolve' }, () => resolve(store)),
    Match.when({ method: 'POST', path: '/notes/discard' }, () => discard(store)),
    Match.when({ method: 'POST', path: '/notes/edit' }, () => edit(store)),
    Match.when({ method: 'GET', path: '/notes.js' }, () => overlay),
    Match.orElse(() => notFound),
  )

const app = Effect.gen(function* () {
  const store = yield* NoteStore
  const request = yield* HttpServerRequest.HttpServerRequest
  const url = new URL(request.url, 'http://localhost')
  return yield* handle(store, request.method, url)
}).pipe(
  HttpMiddleware.cors({
    allowedOrigins: () => true,
    allowedMethods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type'],
  }),
)

export const notesServer = (port: number) =>
  HttpServer.serve(app).pipe(
    Layer.provide(NoteStore.layer),
    Layer.provide(BunHttpServer.layer({ port })),
  )
