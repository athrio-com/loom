import { Array, Effect, FileSystem, pipe, Schema as S } from 'effect'
import { BunRuntime, BunServices } from '@effect/platform-bun'
import { chromium, type Page } from 'playwright-core'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WovenCorpusSchema } from '@athrio/loom-lang/weave/WovenCorpus'

const root = dirname(fileURLToPath(import.meta.url))
const distDir = join(root, '..', 'dist')
const dataFile = join(root, 'data', 'site.json')
const port = 4390
const origin = `http://localhost:${port}`

const stripOrder = (segment: string): string => segment.replace(/^\d+-/, '')

const pathForSlug = (slug: string): string =>
  `/${pipe(slug.split('/'), Array.map(stripOrder), Array.join('/'))}`

const outPath = (route: string): string =>
  route === '/'
    ? join(distDir, 'prerendered', 'index.html')
    : join(distDir, 'prerendered', route, 'index.html')

const backend = Effect.acquireRelease(
  Effect.sync(() =>
    Bun.spawn(['bun', join(root, 'server.ts')], {
      env: { ...process.env, PORT: String(port) },
      stdout: 'inherit',
      stderr: 'inherit',
    }),
  ),
  (process) => Effect.sync(() => process.kill()),
)

const waitReady = (tries: number): Effect.Effect<void> =>
  tries <= 0
    ? Effect.void
    : Effect.tryPromise(() =>
        fetch(`${origin}/data/nav.json`).then((response) => {
          if (!response.ok) throw new Error('not ready')
        }),
      ).pipe(
        Effect.catchCause(() =>
          Effect.sleep('200 millis').pipe(Effect.andThen(waitReady(tries - 1))),
        ),
      )

const browser = Effect.acquireRelease(
  Effect.promise(() => chromium.launch({ channel: 'chrome' })),
  (instance) => Effect.promise(() => instance.close()),
)

const reroot = () => {
  const app = document.body.firstElementChild
  if (app && app.id !== 'root') {
    const root = document.createElement('div')
    root.id = 'root'
    app.replaceWith(root)
    root.appendChild(app)
  }
}

const render = (fs: FileSystem.FileSystem, page: Page, route: string) =>
  Effect.gen(function* () {
    yield* Effect.promise(() => page.goto(`${origin}${route}`, { waitUntil: 'load' }))
    yield* Effect.promise(() => page.waitForSelector('.loom-app', { timeout: 15000 }))
    yield* Effect.promise(() => page.evaluate(reroot))
    const html = yield* Effect.promise(() => page.content())
    const file = outPath(route)
    yield* fs.makeDirectory(dirname(file), { recursive: true })
    yield* fs.writeFileString(file, html)
    yield* Effect.log(`pre-rendered ${route}`)
  })

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const corpus = S.decodeUnknownSync(WovenCorpusSchema)(
    JSON.parse(yield* fs.readFileString(dataFile)),
  )
  const routes = [
    '/',
    ...pipe(
      Array.flatMap(corpus.nav, (part) => part.chapters),
      Array.map((chapter) => pathForSlug(chapter.slug)),
    ),
  ]

  yield* fs
    .remove(join(distDir, 'prerendered'), { recursive: true })
    .pipe(Effect.catchCause(() => Effect.void))
  yield* backend
  yield* waitReady(80)
  const instance = yield* browser
  const page = yield* Effect.promise(() => instance.newPage())
  yield* Effect.sync(() =>
    page.on('pageerror', (error) => console.error(`[pageerror] ${error.message}`)),
  )

  yield* Effect.forEach(routes, (route) =>
    render(fs, page, route).pipe(
      Effect.catchCause(() => Effect.logWarning(`skipped ${route}`)),
    ),
  )
  yield* Effect.log(`pre-rendered ${routes.length} routes`)
}).pipe(Effect.scoped, Effect.provide(BunServices.layer))

BunRuntime.runMain(program)
