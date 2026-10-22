import { Array, Cache, Data, Effect, Layer, ManagedRuntime, Option, Schema, pipe } from 'effect'
import {
  createConnection,
  createServer,
  createTypeScriptProject,
  FileChangeType,
  type FileEvent,
  type Language,
  type LanguageServer,
  type LanguageServerProject,
  type LanguageServicePlugin,
  loadTsdkByPath,
} from '@volar/language-server/node'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { URI } from 'vscode-uri'
import { LoomCompiler, DocumentSource } from './LoomCompiler'
import { LoomFormatter } from './LoomFormatter'
import { PackageConfig } from './PackageConfig'
import { LoomConfig } from '@athrio/loom-config/LoomConfig'
import {
  installTypeScript,
  standalone,
  storeDir,
  storeTypeScript,
  typeScriptRange,
  workspaceOf,
  workspaceRoot,
} from '@athrio/loom-lang-services/LoomStore'
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

const besideLoom = (): Option.Option<string> =>
  standalone ? Option.none() : installedTsdk(import.meta.url)

const foundTsdk = (options: unknown, root: string): Option.Option<string> =>
  pipe(
    editorTsdk(options),
    Option.orElse(() => installedTsdk(join(root, 'package.json'))),
    Option.orElse(besideLoom),
    Option.orElse(() => Option.map(storeTypeScript(root), dirname)),
  )

export class MissingTypeScript extends Data.TaggedError('MissingTypeScript')<{
  readonly root: string
  readonly failedInstall: Option.Option<string>
}> {
  get message(): string {
    const why = Option.match(this.failedInstall, {
      onNone: () =>
        `${this.root} lies in no Loom workspace, so there is no store to install one into; run \`loom init\` there`,
      onSome: (cause) => `installing one into the workspace's store failed: ${cause}`,
    })
    return `Loom's language server needs TypeScript 6 or earlier, and found none in ${this.root} or beside Loom. TypeScript 7 has no JavaScript API for it to load. ${why}. You can also install one in the project with \`bun add -d typescript@6\`, or have the editor send its path as \`initializationOptions.typescript.tsdk\`.`
  }
}

const fetchedTsdk = (root: string): Effect.Effect<string, MissingTypeScript> =>
  Option.match(workspaceOf(root), {
    onNone: () => Effect.fail(new MissingTypeScript({ root, failedInstall: Option.none() })),
    onSome: (workspace) =>
      Effect.logInfo(`installing TypeScript ${typeScriptRange} into ${storeDir(workspace)}`).pipe(
        Effect.andThen(installTypeScript(workspace)),
        Effect.map(dirname),
        Effect.mapError(
          (error) =>
            new MissingTypeScript({ root, failedInstall: Option.some(String(error.cause)) }),
        ),
      ),
  })

const tsdkFor = (options: unknown, root: string): Effect.Effect<string, MissingTypeScript> =>
  Option.match(foundTsdk(options, root), {
    onNone: () => fetchedTsdk(root),
    onSome: Effect.succeed,
  })

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
  services: Cache.Cache<string, ReadonlyArray<LanguageServicePlugin>>,
  projects: Cache.Cache<string, LanguageServerProject>,
): LanguageServerProject => ({
  setup: (server) => {
    watchConfigs(server, services, projects)
    watchLooms(server, home, projects)
  },
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

const reconfiguredWorkspaces = (changes: ReadonlyArray<FileEvent>): ReadonlyArray<string> =>
  pipe(
    changes,
    Array.filter((change) => change.uri.endsWith('/.loom/config.yaml')),
    Array.map((change) => dirname(dirname(fileURLToPath(change.uri)))),
    Array.dedupe,
  )

const forgetWorkspace = (
  services: Cache.Cache<string, ReadonlyArray<LanguageServicePlugin>>,
  projects: Cache.Cache<string, LanguageServerProject>,
  workspace: string,
): Effect.Effect<void> =>
  Cache.getSuccess(projects, workspace).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.void,
        onSome: (project) => Effect.sync(() => project.reload()),
      }),
    ),
    Effect.andThen(Cache.invalidate(projects, workspace)),
    Effect.andThen(Cache.invalidate(services, workspace)),
  )

const reconfigure = (
  server: LanguageServer,
  services: Cache.Cache<string, ReadonlyArray<LanguageServicePlugin>>,
  projects: Cache.Cache<string, LanguageServerProject>,
  workspaces: ReadonlyArray<string>,
): Effect.Effect<void> =>
  workspaces.length === 0
    ? Effect.void
    : Effect.forEach(workspaces, (workspace) => forgetWorkspace(services, projects, workspace), {
        discard: true,
      }).pipe(Effect.andThen(Effect.sync(() => void server.languageFeatures.requestRefresh(true))))

const watchConfigs = (
  server: LanguageServer,
  services: Cache.Cache<string, ReadonlyArray<LanguageServicePlugin>>,
  projects: Cache.Cache<string, LanguageServerProject>,
): void => {
  void server.fileWatcher.watchFiles(['**/.loom/config.yaml'])
  server.fileWatcher.onDidChangeWatchedFiles(({ changes }) =>
    runtime.runSync(reconfigure(server, services, projects, reconfiguredWorkspaces(changes))),
  )
}

const closedLoomChanges = (
  server: LanguageServer,
  changes: ReadonlyArray<FileEvent>,
): ReadonlyArray<FileEvent> =>
  Array.filter(
    changes,
    (change) =>
      change.uri.endsWith('.loom') && server.documents.get(URI.parse(change.uri)) === undefined,
  )

const rereadLoom = (
  compiler: LoomCompiler['Service'],
  change: FileEvent,
): Effect.Effect<Option.Option<FileEvent>> =>
  compiler
    .invalidate(URI.parse(change.uri).fsPath)
    .pipe(
      Effect.map((reprojected) =>
        change.type === FileChangeType.Changed && reprojected.length === 0
          ? Option.none()
          : Option.some(change),
      ),
    )

const rereadLooms = (
  changes: ReadonlyArray<FileEvent>,
): Effect.Effect<ReadonlyArray<FileEvent>, never, LoomCompiler> =>
  LoomCompiler.pipe(
    Effect.flatMap((compiler) => Effect.forEach(changes, (change) => rereadLoom(compiler, change))),
    Effect.map(Array.getSomes),
  )

const openLoomsIn = (
  server: LanguageServer,
  home: string,
  workspace: string,
): ReadonlyArray<URI> =>
  pipe(
    server.documents.all(),
    Array.map((document) => URI.parse(document.uri)),
    Array.filter((uri) => uri.path.endsWith('.loom') && workspaceFor(home, uri) === workspace),
  )

const markStale = (project: LanguageServerProject, uri: URI): Effect.Effect<void> =>
  Effect.promise(async () => project.getLanguageService(uri)).pipe(
    Effect.map((languageService) => languageService.context.language.scripts.get(uri)),
    Effect.flatMap((script) =>
      Option.match(Option.fromNullishOr(script), {
        onNone: () => Effect.void,
        onSome: (stale) =>
          Effect.sync(() => {
            stale.isAssociationDirty = true
          }),
      }),
    ),
  )

const forgetScript = (language: Language<URI>, uri: URI): Effect.Effect<void> =>
  Effect.sync(() => language.scripts.delete(uri))

const refreshProject = (
  server: LanguageServer,
  home: string,
  workspace: string,
  project: LanguageServerProject,
  deleted: ReadonlyArray<URI>,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const languageServices = yield* Effect.promise(
      async () => (await project.getExistingLanguageServices()) ?? [],
    )
    yield* Effect.forEach(
      Array.cartesian(languageServices, deleted),
      ([languageService, uri]) => forgetScript(languageService.context.language, uri),
      { discard: true },
    )
    yield* Effect.forEach(openLoomsIn(server, home, workspace), (uri) => markStale(project, uri), {
      discard: true,
    })
  })

const reprojectWorkspace = (
  server: LanguageServer,
  home: string,
  projects: Cache.Cache<string, LanguageServerProject>,
  workspace: string,
  deleted: ReadonlyArray<URI>,
): Effect.Effect<void> =>
  Cache.getSuccess(projects, workspace).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.void,
        onSome: (project) => refreshProject(server, home, workspace, project, deleted),
      }),
    ),
  )

const reproject = (
  server: LanguageServer,
  home: string,
  projects: Cache.Cache<string, LanguageServerProject>,
  changes: ReadonlyArray<FileEvent>,
): Effect.Effect<void> => {
  const deleted = pipe(
    changes,
    Array.filter((change) => change.type === FileChangeType.Deleted),
    Array.map((change) => URI.parse(change.uri)),
  )
  return changes.length === 0
    ? Effect.void
    : Effect.forEach(
        Array.dedupe(Array.map(changes, (change) => workspaceFor(home, URI.parse(change.uri)))),
        (workspace) => reprojectWorkspace(server, home, projects, workspace, deleted),
        { discard: true },
      ).pipe(
        Effect.andThen(Effect.sync(() => void server.languageFeatures.requestRefresh(false))),
      )
}

const rereadOnDisk = (
  server: LanguageServer,
  home: string,
  projects: Cache.Cache<string, LanguageServerProject>,
  changes: ReadonlyArray<FileEvent>,
): void => {
  const counted = runtime.runSync(rereadLooms(changes))
  runtime.runFork(
    reproject(server, home, projects, counted).pipe(
      Effect.catchCause((cause) => Effect.logError('loom: reprojecting open looms failed', cause)),
    ),
  )
}

const watchLooms = (
  server: LanguageServer,
  home: string,
  projects: Cache.Cache<string, LanguageServerProject>,
): void => {
  void server.fileWatcher.watchFiles(['**/*.loom'])
  server.fileWatcher.onDidChangeWatchedFiles(({ changes }) =>
    rereadOnDisk(server, home, projects, closedLoomChanges(server, changes)),
  )
  server.documents.onDidClose(({ document }) =>
    rereadOnDisk(
      server,
      home,
      projects,
      document.uri.endsWith('.loom') ? [{ uri: document.uri, type: FileChangeType.Changed }] : [],
    ),
  )
}

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
    const { services, projects, plugins } = await runtime.runPromise(
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
        return { services, projects, plugins }
      }),
    )
    return server.initialize(params, workspaceProject(home, services, projects), [...plugins])
  })
  connection.onInitialized(() => {
    server.initialized()
    void server.fileWatcher.watchFiles(['**/tsconfig.json', '**/jsconfig.json'])
  })
  connection.onShutdown(server.shutdown)
  connection.listen()
}
