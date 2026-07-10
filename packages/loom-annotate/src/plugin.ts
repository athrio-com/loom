import { Effect, Schema } from 'effect'
import type { IncomingMessage } from 'node:http'
import { FeedbackLog } from './feedback-log'
import { DraftSchema } from './entry'

const bodyJson = (req: IncomingMessage): Effect.Effect<unknown, unknown> =>
  Effect.gen(function* () {
    const raw = yield* Effect.tryPromise({ try: () => bodyText(req), catch: (e) => e })
    return yield* Effect.try({ try: () => JSON.parse(raw) as unknown, catch: (e) => e })
  })

const SeqBody = Schema.Struct({ seq: Schema.Number })
const EditBody = Schema.Struct({ seq: Schema.Number, text: Schema.String })

const captureProgram = (req: IncomingMessage) =>
  Effect.gen(function* () {
    const draft = yield* Schema.decodeUnknownEffect(DraftSchema)(yield* bodyJson(req))
    const log = yield* FeedbackLog
    return yield* log.record(draft)
  })

const feedProgram = Effect.gen(function* () {
  const log = yield* FeedbackLog
  return yield* log.list
})

const resolveProgram = (req: IncomingMessage) =>
  Effect.gen(function* () {
    const { seq } = yield* Schema.decodeUnknownEffect(SeqBody)(yield* bodyJson(req))
    const log = yield* FeedbackLog
    yield* log.resolve(seq)
    return { ok: true, seq }
  })

const discardProgram = (req: IncomingMessage) =>
  Effect.gen(function* () {
    const { seq } = yield* Schema.decodeUnknownEffect(SeqBody)(yield* bodyJson(req))
    const log = yield* FeedbackLog
    yield* log.discard(seq)
    return { ok: true, seq }
  })

const updateProgram = (req: IncomingMessage) =>
  Effect.gen(function* () {
    const { seq, text } = yield* Schema.decodeUnknownEffect(EditBody)(yield* bodyJson(req))
    const log = yield* FeedbackLog
    yield* log.edit(seq, text)
    return { ok: true, seq }
  })

const bodyText = (req: IncomingMessage): Promise<string> => {
  const chunks: Array<Uint8Array> = []
  return new Promise((settle, reject) => {
    req.on('data', (chunk: Uint8Array) => chunks.push(chunk))
    req.on('end', () => settle(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

import { Layer, ManagedRuntime, Match } from 'effect'
import { BunServices } from '@effect/platform-bun'
import type { Plugin } from 'vite'
import type { ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

export const loomAnnotate = (options?: { readonly path?: string }): Plugin => {
  const overlaySource = readFileSync(fileURLToPath(new URL('./overlay.ts', import.meta.url)), 'utf8')
  const overlayModule = new Bun.Transpiler({ loader: 'ts' }).transformSync(overlaySource)
  const runtime = ManagedRuntime.make(FeedbackLog.layer.pipe(Layer.provide(BunServices.layer)))

  const sendJson = (res: ServerResponse, value: unknown): void => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(value))
  }
  const sendError = (res: ServerResponse, error: unknown): void => {
    res.statusCode = 400
    res.setHeader('content-type', 'text/plain')
    res.end(String(error))
  }
  const run = (res: ServerResponse, program: Effect.Effect<unknown, unknown, FeedbackLog>): void =>
    void runtime.runPromise(program).then(
      (value) => sendJson(res, value),
      (error) => sendError(res, error),
    )

  return {
    name: 'loom-annotate',
    apply: 'serve',
    configResolved(config) {
      process.env.LOOM_ANNOTATE_LOG = resolve(config.root, options?.path ?? '.loom/feedback.jsonl')
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const request = { url: (req.url ?? '').split('?')[0], method: req.method ?? 'GET' }
        Match.value(request).pipe(
          Match.when({ url: '/__annotate/overlay.js', method: 'GET' }, () => {
            res.setHeader('content-type', 'text/javascript')
            res.end(overlayModule)
          }),
          Match.when({ url: '/__annotate/capture', method: 'POST' }, () => run(res, captureProgram(req))),
          Match.when({ url: '/__annotate/feed', method: 'GET' }, () => run(res, feedProgram)),
          Match.when({ url: '/__annotate/resolve', method: 'POST' }, () => run(res, resolveProgram(req))),
          Match.when({ url: '/__annotate/discard', method: 'POST' }, () => run(res, discardProgram(req))),
          Match.when({ url: '/__annotate/update', method: 'POST' }, () => run(res, updateProgram(req))),
          Match.orElse(() => next()),
        )
      })
    },
    transformIndexHtml() {
      return [
        {
          tag: 'script',
          attrs: { type: 'module', src: '/__annotate/overlay.js' },
          injectTo: 'body',
        },
      ]
    },
  }
}
