import { Array, Cache, Data, Effect, Layer, ManagedRuntime, Option, Schema, pipe } from 'effect'
import {
  createConnection,
  createServer,
  createTypeScriptProject,
  type LanguageServer,
  type LanguageServerProject,
  type LanguageServicePlugin,
  loadTsdkByPath,
} from '@volar/language-server/node'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { URI } from 'vscode-uri'
import { LoomCompiler, DocumentSource } from './LoomCompiler'
import { LoomFormatter } from './LoomFormatter'
import { PackageConfig } from './PackageConfig'
import { LoomConfig } from '@athrio/loom-config/LoomConfig'
import { workspaceOf, workspaceRoot } from '@athrio/loom-lang-services/LoomStore'
import { loomLanguagePlugin, loomServicePlugins } from './LoomLanguagePlugin'

const EditorTsdkSchema = Schema.Struct({
  typescript: Schema.Struct({ tsdk: Schema.String }),
})

const editorTsdk = (options: unknown): Option.Option<string> =>
  Option.map(
    Schema.decodeUnknownOption(EditorTsdkSchema)(options),
    (decoded) => decoded.typescript.tsdk,
  )

const installedTsdk = (from: string): Option.Option<string> =>
  Option.map(
    Option.liftThrowable(() => createRequire(from).resolve('typescript/lib/typescript.js'))(),
    dirname,
  )

export class MissingTypeScript extends Data.TaggedError('MissingTypeScript')<{
  readonly root: string
}> {
  get message(): string {
    return `Loom's language server needs TypeScript 6 or earlier, and found none in ${this.root} or beside Loom. TypeScript 7 has no JavaScript API for it to load. Install one in the project with \`bun add -d typescript@6\`, or have the editor send its path as \`initializationOptions.typescript.tsdk\`.`
  }
}

const tsdkFor = (options: unknown, root: string): Effect.Effect<string, MissingTypeScript> =>
  pipe(
    editorTsdk(options),
    Option.orElse(() => installedTsdk(join(root, 'package.json'))),
    Option.orElse(() => installedTsdk(import.meta.url)),
    Option.match({
      onNone: () => Effect.fail(new MissingTypeScript({ root })),
      onSome: (tsdk) => Effect.succeed(tsdk),
    }),
  )

const workspaceFor = (home: string, uri: URI): string =>
  uri.scheme === 'file' ? Option.getOrElse(workspaceOf(dirname(uri.fsPath)), () => home) : home

type Tsdk = ReturnType<typeof loadTsdkByPath>

const projectOver = (
  server: LanguageServer,
  tsdk: Tsdk,
  plugins: ReadonlyArray<LanguageServicePlugin>,
): LanguageServerProject => {
  const project = createTypeScriptProject(tsdk.typescript, tsdk.diagnosticMessages, () => ({
    languagePlugins: [loomLanguagePlugin(runtime)],
  }))
  project.setup({ ...server, languageServicePlugins: [...plugins] })
  return project
}

const workspaceProject = (
  home: string,
  projects: Cache.Cache<string, LanguageServerProject>,
): LanguageServerProject => ({
  setup: () => undefined,
  getLanguageService: (uri) =>
    runtime.runPromise(
      Cache.get(projects, workspaceFor(home, uri)).pipe(
        Effect.flatMap((project) => Effect.promise(async () => project.getLanguageService(uri))),
      ),
    ),
  getExistingLanguageServices: () =>
    runtime.runPromise(
      Cache.values(projects).pipe(
        Effect.flatMap((all) =>
          Effect.forEach(all, (project) =>
            Effect.promise(async () => (await project.getExistingLanguageServices()) ?? []),
          ),
        ),
        Effect.map(Array.flatten),
      ),
    ),
  reload: () =>
    runtime.runSync(
      Cache.values(projects).pipe(
        Effect.flatMap((all) =>
          Effect.forEach(all, (project) => Effect.sync(() => project.reload()), { discard: true }),
        ),
      ),
    ),
})

const runtime = ManagedRuntime.make(
  Layer.mergeAll(LoomCompiler.layer, LoomFormatter.layer, LoomConfig.layer).pipe(
    Layer.provide(DocumentSource.layer),
    Layer.provide(PackageConfig.layer),
    Layer.provide(LoomConfig.layer),
  ),
)

export const startLanguageServer = (): void => {
  const connection = createConnection()
  const server = createServer(connection)

  connection.onInitialize(async (params) => {
    const folder = params.workspaceFolders?.[0]?.uri
    const root = folder ? fileURLToPath(folder) : process.cwd()
    const home = workspaceRoot(root)
    const { projects, plugins } = await runtime.runPromise(
      Effect.gen(function* () {
        const path = yield* tsdkFor(params.initializationOptions, root)
        const tsdk = yield* Effect.sync(() => loadTsdkByPath(path, params.locale))
        const services = yield* Cache.make({
          capacity: Infinity,
          lookup: (workspace: string) => loomServicePlugins(runtime, tsdk.typescript, workspace),
        })
        const projects = yield* Cache.make({
          capacity: Infinity,
          lookup: (workspace: string) =>
            Cache.get(services, workspace).pipe(
              Effect.flatMap((plugins) => Effect.sync(() => projectOver(server, tsdk, plugins))),
            ),
        })
        const plugins = yield* Cache.get(services, home)
        return { projects, plugins }
      }),
    )
    return server.initialize(params, workspaceProject(home, projects), [...plugins])
  })
  connection.onInitialized(() => {
    server.initialized()
    void server.fileWatcher.watchFiles(['**/tsconfig.json', '**/jsconfig.json'])
  })
  connection.onShutdown(server.shutdown)
  connection.listen()
}
