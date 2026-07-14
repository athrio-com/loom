import { Effect, Layer, Option, Schema } from 'effect'
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from 'effect/unstable/http'
import { McpServer } from 'effect/unstable/ai'
import { BunHttpServer } from '@effect/platform-bun'
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

const NameBody = Schema.Struct({ project: Schema.String, name: Schema.String })

const rename = Effect.gen(function* () {
  const store = yield* NoteStore
  const { project, name } = yield* HttpServerRequest.schemaBodyJson(NameBody)
  yield* store.rename(project, name)
  return yield* HttpServerResponse.json({ ok: true })
})

import { Data } from 'effect'

class GitError extends Data.TaggedError('GitError')<{
  readonly path: string
  readonly cause: unknown
}> {}

const branchAt = (path: string): Effect.Effect<string> =>
  path === ''
    ? Effect.succeed('')
    : Effect.tryPromise({
        try: async () => {
          const git = Bun.spawn(['git', '-C', path, 'rev-parse', '--abbrev-ref', 'HEAD'], {
            stdout: 'pipe',
            stderr: 'ignore',
          })
          const [out, code] = await Promise.all([new Response(git.stdout).text(), git.exited])
          return code === 0 ? out.trim() : ''
        },
        catch: (cause) => new GitError({ path, cause }),
      }).pipe(
        Effect.timeout('2 seconds'),
        Effect.catchCause((cause) =>
          Effect.logWarning('git branch lookup failed', cause).pipe(Effect.as('')),
        ),
      )

const context = Effect.gen(function* () {
  const store = yield* NoteStore
  const request = yield* HttpServerRequest.HttpServerRequest
  const project = new URL(request.url, 'http://localhost').searchParams.get('project')
  return yield* Option.match(Option.fromNullishOr(project), {
    onNone: () => Effect.succeed(HttpServerResponse.text('project is required', { status: 400 })),
    onSome: (id) =>
      store.find(id).pipe(
        Effect.flatMap((found) =>
          Option.match(found, {
            onNone: () => HttpServerResponse.json({ name: id, branch: '' }),
            onSome: (record) =>
              branchAt(record.path).pipe(
                Effect.flatMap((branch) => HttpServerResponse.json({ name: record.name, branch })),
              ),
          }),
        ),
      ),
  })
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
  HttpRouter.add('POST', '/notes/resolve', handling(resolve)),
  HttpRouter.add('POST', '/notes/discard', handling(discard)),
  HttpRouter.add('POST', '/notes/edit', handling(edit)),
  HttpRouter.add('POST', '/project/name', handling(rename)),
  HttpRouter.add('GET', '/project/context', handling(context)),
  HttpRouter.add('GET', '/notes.js', overlay),
)

const mcp = McpServer.toolkit(toolkit).pipe(
  Layer.provide(handlers),
  Layer.provide(McpServer.layerHttp({ name: 'loom', version: '0.9.0', path: '/mcp' })),
)

import { Logger } from 'effect'

export const devtoolsLogger = Logger.layer([Logger.consoleLogFmt])

const app = Layer.mergeAll(
  routes,
  mcp,
  HttpRouter.cors({ allowedMethods: ['GET', 'POST'], allowedHeaders: ['Content-Type'] }),
)

export const notesServer = (port: number) =>
  HttpRouter.serve(app).pipe(
    Layer.provide(NoteStore.layer),
    Layer.provide(BunHttpServer.layer({ port })),
  )
