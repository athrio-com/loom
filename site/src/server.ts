import { Array, Context, Effect, FileSystem, Layer, Match, Option, pipe, Schema as S } from 'effect'
import { HttpServer, HttpServerRequest, HttpServerResponse } from 'effect/unstable/http'
import { BunHttpServer, BunRuntime } from '@effect/platform-bun'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  WovenCorpusSchema,
  type WovenPage,
  type WovenPart,
} from '@athrio/loom-lang/weave/WovenCorpus'

const root = dirname(fileURLToPath(import.meta.url))
const dataFile = join(root, 'data', 'site.json')
const distDir = join(root, '..', 'dist')

export class SiteData extends Context.Service<SiteData>()('SiteData', {
  make: Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const corpus = S.decodeUnknownSync(WovenCorpusSchema)(
      JSON.parse(yield* fs.readFileString(dataFile)),
    )
    const shell = yield* fs.readFileString(join(distDir, 'index.html'))
    const bySlug = new Map(corpus.pages.map((page) => [page.slug, page] as const))
    const schema = JSON.stringify(S.toJsonSchemaDocument(WovenCorpusSchema), null, 2)
    return { nav: corpus.nav, bySlug, shell, schema } as const
  }),
}) {
  static readonly layer = Layer.effect(this, this.make)
}

type Site = SiteData['Service']

const stripOrder = (segment: string): string => segment.replace(/^\d+-/, '')

const pathForSlug = (slug: string): string =>
  `/${pipe(slug.split('/'), Array.map(stripOrder), Array.join('/'))}`

const slugForPath = (
  nav: ReadonlyArray<WovenPart>,
  pathname: string,
): Option.Option<string> =>
  pipe(
    Array.flatMap(nav, (part) => part.chapters),
    Array.findFirst((chapter) => pathForSlug(chapter.slug) === pathname),
    Option.map((chapter) => chapter.slug),
  )

const slugFromDataPath = (pathname: string): string =>
  decodeURIComponent(pathname.slice('/data/pages/'.length).replace(/\.json$/, ''))

const inlineJson = (payload: unknown): string =>
  JSON.stringify(payload).replace(/</g, '\\u003c')

const withInlineData = (shell: string, payload: unknown): string =>
  shell.replace(
    '</head>',
    () => `<script id="loom-data" type="application/json">${inlineJson(payload)}</script></head>`,
  )

const notFound = Effect.succeed(
  HttpServerResponse.text('Not found', { status: 404 }),
)

const prerenderedPath = (pathname: string): string =>
  pathname === '/'
    ? join(distDir, 'prerendered', 'index.html')
    : join(distDir, 'prerendered', pathname, 'index.html')

const dynamicDoc = (data: Site, page: Option.Option<WovenPage>) =>
  Effect.succeed(
    HttpServerResponse.text(
      withInlineData(
        data.shell,
        Option.match(page, {
          onSome: (found) => ({ nav: data.nav, page: found }),
          onNone: () => ({ nav: data.nav }),
        }),
      ),
      { contentType: 'text/html' },
    ),
  )

const docResponse = (
  data: Site,
  pathname: string,
  page: Option.Option<WovenPage>,
) =>
  HttpServerResponse.file(prerenderedPath(pathname)).pipe(
    Effect.catchCause(() => dynamicDoc(data, page)),
  )

const asset = (pathname: string) =>
  HttpServerResponse.file(join(distDir, pathname)).pipe(Effect.catchCause(() => notFound))

const pageApi = (data: Site, pathname: string) =>
  Option.match(Option.fromNullishOr(data.bySlug.get(slugFromDataPath(pathname))), {
    onSome: (page) => HttpServerResponse.json(page),
    onNone: () => notFound,
  })

const docOrAsset = (data: Site, pathname: string) =>
  Option.match(slugForPath(data.nav, pathname), {
    onSome: (slug) =>
      docResponse(data, pathname, Option.fromNullishOr(data.bySlug.get(slug))),
    onNone: () => asset(pathname),
  })

const handle = (data: Site, pathname: string) =>
  Match.value(pathname).pipe(
    Match.when('/', () => docResponse(data, '/', Option.none())),
    Match.when('/data/nav.json', () => HttpServerResponse.json(data.nav)),
    Match.when('/data/schema.json', () =>
      Effect.succeed(HttpServerResponse.text(data.schema, { contentType: 'application/json' })),
    ),
    Match.when(
      (pathname) => pathname.startsWith('/data/pages/'),
      (pathname) => pageApi(data, pathname),
    ),
    Match.orElse((pathname) => docOrAsset(data, pathname)),
  )

const app = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  const data = yield* SiteData
  const pathname = new URL(request.url, 'http://localhost').pathname
  return yield* handle(data, pathname)
})

const port = Number(process.env.PORT ?? 4321)

const server = HttpServer.serve(app).pipe(
  Layer.provide(SiteData.layer),
  Layer.provide(BunHttpServer.layer({ port })),
)

BunRuntime.runMain(Layer.launch(server))
