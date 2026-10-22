import { Array, Data, Effect, FileSystem, Layer, Option, PubSub, Schedule, Stream } from 'effect'
import { HttpServer, HttpServerResponse } from 'effect/http'
import { ChildProcess } from 'effect/process'
import { BunHttpServer, BunRuntime, BunServices } from '@effect/platform-bun'
import { basename, dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const siteDir = join(dirname(fileURLToPath(import.meta.url)), '..')

const watcher = (
  command: string,
  args: ReadonlyArray<string>,
  env: Record<string, string> = {},
) =>
  Effect.scoped(
    Effect.flatMap(
      ChildProcess.make(command, args, {
        cwd: siteDir,
        env,
        extendEnv: true,
        detached: false,
        stdin: 'inherit',
        stdout: 'inherit',
        stderr: 'inherit',
      }),
      (running) => running.exitCode,
    ),
  )

const serverPort = Number(process.env.PORT ?? 5199)

const reloadPort = Number(process.env.RELOAD_PORT ?? 5198)

const reloadAddress = `http://localhost:${reloadPort}/`

const clientBuild = watcher(
  'bunx',
  ['--bun', 'vite', 'build', '--watch', '--emptyOutDir', 'false'],
  { VITE_RELOAD_URL: reloadAddress },
)

const server = watcher('bun', ['--watch', 'src/server.ts'])

const bookFile = join(siteDir, 'src', 'source.coloured.json')

const bookChanges = Stream.unwrap(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    return fs.watch(bookFile).pipe(Stream.debounce('250 millis'), Stream.catch(() => Stream.never))
  }),
)

class NotAnswering extends Data.TaggedError('NotAnswering')<{ readonly status: number }> {}

const serverAnswers = Effect.tryPromise(() => fetch(`http://localhost:${serverPort}/`)).pipe(
  Effect.flatMap((response) =>
    response.ok ? Effect.void : Effect.fail(new NotAnswering({ status: response.status })),
  ),
)

const announceWhenReady = (reloads: PubSub.PubSub<void>) =>
  serverAnswers.pipe(
    Effect.retry(Schedule.spaced('100 millis')),
    Effect.timeout('30 seconds'),
    Effect.andThen(PubSub.publish(reloads, undefined)),
    Effect.ignore,
  )

const restartingServer = (reloads: PubSub.PubSub<void>) =>
  Stream.succeed(undefined).pipe(
    Stream.concat(bookChanges),
    Stream.switchMap(() =>
      Stream.fromEffect(
        Effect.zipWith(server, announceWhenReady(reloads), (code) => code, { concurrent: true }),
      ),
    ),
    Stream.runHead,
    Effect.map(Option.getOrElse(() => 0)),
  )

const sourceDirs = Array.map(['corpus', 'docs'], (dir) => join(siteDir, '..', dir))

const loomChanges = Stream.unwrap(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    return Stream.mergeAll(
      Array.map(sourceDirs, (dir) =>
        fs.watch(dir, { recursive: true }).pipe(Stream.catch(() => Stream.never)),
      ),
      { concurrency: 'unbounded' },
    )
  }),
).pipe(
  Stream.filter((change) => extname(change.path) === '.loom'),
  Stream.debounce('300 millis'),
)

const reweaving = loomChanges.pipe(Stream.runForEach(() => watcher('bun', ['run', 'content'])))

const distDir = join(siteDir, 'dist')

const announceBuilds = (reloads: PubSub.PubSub<void>) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      return fs.watch(distDir).pipe(Stream.catch(() => Stream.never))
    }),
  ).pipe(
    Stream.filter((change) => basename(change.path) === 'index.html'),
    Stream.debounce('250 millis'),
    Stream.runForEach(() => announceWhenReady(reloads)),
  )

const encoder = new TextEncoder()

const opened = encoder.encode(': listening for reloads\n\n')

const reloadEvent = encoder.encode('event: reload\ndata:\n\n')

const reloadChannel = (reloads: PubSub.PubSub<void>) =>
  HttpServer.serve(
    Effect.sync(() =>
      HttpServerResponse.stream(
        Stream.succeed(opened).pipe(
          Stream.concat(Stream.fromPubSub(reloads).pipe(Stream.as(reloadEvent))),
        ),
        {
          contentType: 'text/event-stream',
          headers: { 'access-control-allow-origin': '*', 'cache-control': 'no-cache' },
        },
      ),
    ),
  ).pipe(Layer.provide(BunHttpServer.layer({ port: reloadPort, idleTimeout: 0 })))

const liveReload = (reloads: PubSub.PubSub<void>) =>
  Effect.all([Layer.launch(reloadChannel(reloads)), announceBuilds(reloads)], {
    concurrency: 'unbounded',
  }).pipe(Effect.catch((cause) => Effect.logWarning('live reload is off', cause)))

const development = Effect.scoped(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* fs.remove(distDir, { recursive: true, force: true })
    yield* fs.makeDirectory(distDir, { recursive: true })
    const reloads = yield* PubSub.unbounded<void>()
    yield* Effect.forkScoped(reweaving)
    yield* Effect.forkScoped(liveReload(reloads))
    const code = yield* Effect.raceFirst(clientBuild, restartingServer(reloads))
    yield* Effect.sync(() => void (process.exitCode = code))
  }),
)

BunRuntime.runMain(development.pipe(Effect.provide(BunServices.layer)))
