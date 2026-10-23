import {
  Array,
  Cache,
  Data,
  Effect,
  Layer,
  ManagedRuntime,
  Option,
  Result,
  Schema,
  Ref,
  Scheduler,
  Semaphore,
  pipe,
} from 'effect'
import {
  createConnection,
  createLanguageServiceEnvironment,
  createServer,
  FileChangeType,
  type FileEvent,
  type Language,
  type LanguageServer,
  type LanguageServerProject,
  type LanguageServicePlugin,
} from '@volar/language-server/node'
import {
  createLanguage,
  createLanguageService,
  createUriMap,
  type IScriptSnapshot,
  type LanguageService,
} from '@volar/language-service'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { URI } from 'vscode-uri'
import { LoomCompiler, DocumentSource, stringSnapshot, within } from './LoomCompiler'
import { ReadError, type Source } from '#ast/LoomCorpusAstBuilder'
import { LoomFormatter } from './LoomFormatter'
import { PackageConfig } from './PackageConfig'
import { LoomConfig } from '@athrio/loom-config/LoomConfig'
import {
  fetchedExecutable,
  fetchedTypeScriptDir,
  fetchTypeScript,
  standalone,
  typeScriptVersion,
  workspaceOf,
  workspaceRoot,
} from '@athrio/loom-lang-services/LoomStore'
import {
  ClassicTypeScriptMissing,
  type FetchedTypeScript,
  type TypescriptSdkApi,
} from '@athrio/loom-lang-services/LanguageService'
import { loomLanguagePlugin, loomServicePlugins } from './LoomLanguagePlugin'
import { loomsIn } from './LoomProject'

const EditorTsdkSchema = Schema.Struct({
  typescript: Schema.Struct({ tsdk: Schema.String }),
})

const editorTsdk = (options: unknown): Option.Option<string> =>
  pipe(
    Schema.decodeUnknownOption(EditorTsdkSchema)(options),
    Option.map((decoded) => decoded.typescript.tsdk),
    Option.filter((tsdk) => existsSync(join(tsdk, 'typescript.js'))),
  )

const installedTsdk = (from: string): Option.Option<string> =>
  Option.map(
    Option.liftThrowable(() => createRequire(from).resolve('typescript/lib/typescript.js'))(),
    dirname,
  )

const besideLoom = (): Option.Option<string> =>
  standalone ? Option.none() : installedTsdk(import.meta.url)

const classicTsdk = (options: unknown, folder: string): Option.Option<string> =>
  pipe(
    installedTsdk(join(folder, 'package.json')),
    Option.orElse(() => editorTsdk(options)),
    Option.orElse(besideLoom),
  )

type TypeScript = typeof import('typescript')

export const classicTypeScript = (
  options: unknown,
): ((folder: string) => Result.Result<TypeScript, ClassicTypeScriptMissing>) => {
  const loaded = new Map<string, TypeScript>()
  const load = (folder: string, tsdk: string): Result.Result<TypeScript, ClassicTypeScriptMissing> =>
    Option.match(Option.fromNullishOr(loaded.get(tsdk)), {
      onSome: (ts) => Result.succeed(ts),
      onNone: () =>
        pipe(
          Result.try((): TypeScript => {
            const file = join(tsdk, 'typescript.js')
            return createRequire(file)(file)
          }),
          Result.map((ts) => {
            loaded.set(tsdk, ts)
            return ts
          }),
          Result.mapError(
            (cause) => new ClassicTypeScriptMissing({ folder, tsdk: Option.some(tsdk), cause }),
          ),
        ),
    })
  return (folder) =>
    Option.match(classicTsdk(options, folder), {
      onNone: () => Result.fail(new ClassicTypeScriptMissing({ folder, tsdk: Option.none() })),
      onSome: (tsdk) => load(folder, tsdk),
    })
}

export class TypeScriptNotFetched extends Data.TaggedError('TypeScriptNotFetched')<{
  readonly version: string
  readonly folder: string
  readonly cause: unknown
}> {
  get message(): string {
    return `could not fetch TypeScript ${this.version} into ${this.folder}: ${String(this.cause)}`
  }
}

const fetchedTypeScript: Effect.Effect<FetchedTypeScript> = Effect.gen(function* () {
  const folder = fetchedTypeScriptDir(typeScriptVersion)
  const once = yield* Effect.cached(
    fetchTypeScript(typeScriptVersion).pipe(
      Effect.mapError(
        (error) =>
          new TypeScriptNotFetched({ version: typeScriptVersion, folder, cause: error.cause }),
      ),
    ),
  )
  return {
    version: typeScriptVersion,
    executable: fetchedExecutable(typeScriptVersion),
    fetch: () => runtime.runPromise(Effect.asVoid(once)),
  }
})

const typescriptSdkFor = (options: unknown): Effect.Effect<TypescriptSdkApi> =>
  Effect.map(fetchedTypeScript, (fetched) => ({ classic: classicTypeScript(options), fetched }))

const workspaceFor = (home: string, uri: URI): string =>
  uri.scheme === 'file' ? Option.getOrElse(workspaceOf(dirname(uri.fsPath)), () => home) : home

const languageServiceOver = (
  server: LanguageServer,
  plugins: ReadonlyArray<LanguageServicePlugin>,
  savedLoom: (uri: URI) => Option.Option<IScriptSnapshot>,
): LanguageService => {
  const language: Language<URI> = createLanguage<URI>(
    [{ getLanguageId: (uri) => server.documents.get(uri)?.languageId }, loomLanguagePlugin(runtime)],
    createUriMap(false),
    (uri, includeFsFiles) =>
      Option.match(
        Option.orElse(
          Option.map(Option.fromNullishOr(server.documents.get(uri)), (document) =>
            document.getSnapshot(),
          ),
          () => (includeFsFiles ? savedLoom(uri) : Option.none()),
        ),
        {
          onSome: (snapshot) => void language.scripts.set(uri, snapshot),
          onNone: () => language.scripts.delete(uri),
        },
      ),
  )
  return createLanguageService(
    language,
    [...plugins],
    createLanguageServiceEnvironment(server, server.workspaceFolders.all),
    {},
  )
}

export const projectOver = (
  server: LanguageServer,
  plugins: ReadonlyArray<LanguageServicePlugin>,
): LanguageServerProject => {
  const savedLoom = savedLooms()
  const state = { service: languageServiceOver(server, plugins, savedLoom) }
  return {
    setup: () => undefined,
    getLanguageService: () => state.service,
    getExistingLanguageServices: () => [state.service],
    reload: () => {
      state.service.dispose()
      state.service = languageServiceOver(server, plugins, savedLoom)
    },
  }
}

interface SavedLoom {
  readonly modified: number
  readonly snapshot: IScriptSnapshot
}

const savedLooms = (): ((uri: URI) => Option.Option<IScriptSnapshot>) => {
  const read = new Map<string, SavedLoom>()
  const readAgain = (path: string, modified: number): Option.Option<IScriptSnapshot> =>
    Option.map(Option.liftThrowable(() => readFileSync(path, 'utf8'))(), (text) => {
      const snapshot = stringSnapshot(text)
      read.set(path, { modified, snapshot })
      return snapshot
    })
  return (uri) =>
    pipe(
      Option.some(uri),
      Option.filter((loom) => loom.scheme === 'file' && isLoom(loom)),
      Option.flatMap((loom) => Option.liftThrowable(() => statSync(loom.fsPath).mtimeMs)()),
      Option.flatMap((modified) =>
        pipe(
          Option.fromNullishOr(read.get(uri.fsPath)),
          Option.filter((held) => held.modified === modified),
          Option.map((held) => held.snapshot),
          Option.orElse(() => readAgain(uri.fsPath, modified)),
        ),
      ),
    )
}

export const workspaceProject = (
  server: LanguageServer,
  home: string,
  services: Cache.Cache<string, ReadonlyArray<LanguageServicePlugin>>,
  projects: Cache.Cache<string, LanguageServerProject>,
  reprojecting: Semaphore.Semaphore,
  edited: Ref.Ref<ReadonlySet<string>>,
): LanguageServerProject => ({
  setup: (server) => {
    watchConfigs(server, home, services, projects, edited)
    watchLooms(server, home, projects, reprojecting, edited)
  },
  getLanguageService: (uri) =>
    runtime.runPromise(
      reprojecting.withPermits(1)(settleEdits(server, home, projects, edited)).pipe(
        Effect.andThen(Cache.get(projects, workspaceFor(home, uri))),
        Effect.flatMap((project) => Effect.promise(async () => project.getLanguageService(uri))),
      ),
    ),
  getExistingLanguageServices: () =>
    runtime.runPromise(
      reprojecting.withPermits(1)(settleEdits(server, home, projects, edited)).pipe(
        Effect.andThen(Cache.values(projects)),
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

const reloadProject = (
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
  )

const forgetWorkspace = (
  services: Cache.Cache<string, ReadonlyArray<LanguageServicePlugin>>,
  projects: Cache.Cache<string, LanguageServerProject>,
  workspace: string,
): Effect.Effect<void> =>
  reloadProject(projects, workspace).pipe(
    Effect.andThen(Cache.invalidate(projects, workspace)),
    Effect.andThen(Cache.invalidate(services, workspace)),
  )

export const rebuildUnder = (
  server: LanguageServer,
  edited: Ref.Ref<ReadonlySet<string>>,
  workspace: string,
): Effect.Effect<void, never, LoomCompiler> =>
  LoomCompiler.pipe(
    Effect.flatMap((compiler) => compiler.invalidateWithin(workspace)),
    Effect.andThen(
      Effect.forEach(
        Array.filter(openLooms(server), (uri) => within(workspace, uri.fsPath)),
        (uri) => recordEdit(edited, uri),
        { discard: true },
      ),
    ),
  )

const reconfigure = (
  server: LanguageServer,
  services: Cache.Cache<string, ReadonlyArray<LanguageServicePlugin>>,
  projects: Cache.Cache<string, LanguageServerProject>,
  edited: Ref.Ref<ReadonlySet<string>>,
  workspaces: ReadonlyArray<string>,
): Effect.Effect<void, never, LoomCompiler> =>
  workspaces.length === 0
    ? Effect.void
    : Effect.forEach(
        workspaces,
        (workspace) =>
          rebuildUnder(server, edited, workspace).pipe(
            Effect.andThen(forgetWorkspace(services, projects, workspace)),
          ),
        { discard: true },
      ).pipe(Effect.andThen(Effect.sync(() => void server.languageFeatures.requestRefresh(true))))

const isCompilerSetting = (uri: string): boolean =>
  /\/(tsconfig|jsconfig|package)\.json$/.test(uri) && !uri.includes('/node_modules/')

const retypedWorkspaces = (
  home: string,
  changes: ReadonlyArray<FileEvent>,
): ReadonlyArray<string> =>
  pipe(
    changes,
    Array.filter((change) => isCompilerSetting(change.uri)),
    Array.map((change) => workspaceFor(home, URI.parse(change.uri))),
    Array.dedupe,
  )

const retype = (
  server: LanguageServer,
  projects: Cache.Cache<string, LanguageServerProject>,
  workspaces: ReadonlyArray<string>,
): Effect.Effect<void> =>
  workspaces.length === 0
    ? Effect.void
    : Effect.forEach(workspaces, (workspace) => reloadProject(projects, workspace), {
        discard: true,
      }).pipe(Effect.andThen(Effect.sync(() => void server.languageFeatures.requestRefresh(true))))

const watchConfigs = (
  server: LanguageServer,
  home: string,
  services: Cache.Cache<string, ReadonlyArray<LanguageServicePlugin>>,
  projects: Cache.Cache<string, LanguageServerProject>,
  edited: Ref.Ref<ReadonlySet<string>>,
): void => {
  void server.fileWatcher.watchFiles([
    '**/.loom/config.yaml',
    '**/tsconfig.json',
    '**/jsconfig.json',
    '**/package.json',
  ])
  server.fileWatcher.onDidChangeWatchedFiles(({ changes }) =>
    runtime.runSync(
      reconfigure(server, services, projects, edited, reconfiguredWorkspaces(changes)).pipe(
        Effect.andThen(retype(server, projects, retypedWorkspaces(home, changes))),
      ),
    ),
  )
}

const isLoom = (uri: URI): boolean => uri.path.endsWith('.loom')

const closedLoomChanges = (
  server: LanguageServer,
  changes: ReadonlyArray<FileEvent>,
): ReadonlyArray<FileEvent> =>
  Array.filter(changes, (change) => {
    const uri = URI.parse(change.uri)
    return isLoom(uri) && server.documents.get(uri) === undefined
  })

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

const openLooms = (server: LanguageServer): ReadonlyArray<URI> =>
  pipe(
    server.documents.all(),
    Array.map((document) => URI.parse(document.uri)),
    Array.filter(isLoom),
  )

const openLoomsIn = (
  server: LanguageServer,
  home: string,
  workspace: string,
): ReadonlyArray<URI> =>
  Array.filter(openLooms(server), (uri) => workspaceFor(home, uri) === workspace)

const logged = (step: string, uri: URI, effect: Effect.Effect<void>): Effect.Effect<void> =>
  effect.pipe(
    Effect.catchCause((cause) => Effect.logError(`loom: ${step} ${uri.fsPath} failed`, cause)),
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

export const refreshProject = (
  server: LanguageServer,
  home: string,
  workspace: string,
  project: LanguageServerProject,
  forgotten: ReadonlyArray<URI>,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const languageServices = yield* Effect.promise(
      async () => (await project.getExistingLanguageServices()) ?? [],
    )
    yield* Effect.forEach(
      Array.cartesian(languageServices, forgotten),
      ([languageService, uri]) =>
        logged('forgetting', uri, forgetScript(languageService.context.language, uri)),
      { discard: true },
    )
    yield* Effect.forEach(
      openLoomsIn(server, home, workspace),
      (uri) => logged('reprojecting', uri, markStale(project, uri)),
      { discard: true },
    )
  })

const reprojectWorkspace = (
  server: LanguageServer,
  home: string,
  projects: Cache.Cache<string, LanguageServerProject>,
  workspace: string,
  forgotten: ReadonlyArray<URI>,
): Effect.Effect<void> =>
  Cache.getSuccess(projects, workspace).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.void,
        onSome: (project) => refreshProject(server, home, workspace, project, forgotten),
      }),
    ),
  )

const reproject = (
  server: LanguageServer,
  home: string,
  projects: Cache.Cache<string, LanguageServerProject>,
  changes: ReadonlyArray<FileEvent>,
  alsoForgotten: ReadonlyArray<URI>,
): Effect.Effect<void> => {
  const forgotten = [
    ...pipe(
      changes,
      Array.filter((change) => change.type === FileChangeType.Deleted),
      Array.map((change) => URI.parse(change.uri)),
    ),
    ...alsoForgotten,
  ]
  return changes.length === 0
    ? Effect.void
    : Effect.forEach(
        Array.dedupe(Array.map(changes, (change) => workspaceFor(home, URI.parse(change.uri)))),
        (workspace) => reprojectWorkspace(server, home, projects, workspace, forgotten),
        { discard: true },
      ).pipe(
        Effect.andThen(Effect.sync(() => void server.languageFeatures.requestRefresh(false))),
      )
}

export const closeOf = (uri: URI, text: string): ReadonlyArray<FileEvent> =>
  Option.match(
    Option.liftThrowable(() => readFileSync(uri.fsPath, 'utf8'))(),
    {
      onNone: () => [{ uri: uri.toString(), type: FileChangeType.Deleted }],
      onSome: (saved) =>
        saved === text ? [] : [{ uri: uri.toString(), type: FileChangeType.Changed }],
    },
  )

const rereadOnDisk = (
  server: LanguageServer,
  home: string,
  projects: Cache.Cache<string, LanguageServerProject>,
  reprojecting: Semaphore.Semaphore,
  changes: ReadonlyArray<FileEvent>,
  alsoForgotten: ReadonlyArray<URI>,
): void => {
  const counted = runtime.runSync(rereadLooms(changes))
  runtime.runFork(
    reprojecting.withPermits(1)(
      reproject(server, home, projects, counted, alsoForgotten).pipe(
        Effect.catchCause((cause) => Effect.logError('loom: reprojecting open looms failed', cause)),
      ),
    ),
  )
}

const watchLooms = (
  server: LanguageServer,
  home: string,
  projects: Cache.Cache<string, LanguageServerProject>,
  reprojecting: Semaphore.Semaphore,
  edited: Ref.Ref<ReadonlySet<string>>,
): void => {
  void server.fileWatcher.watchFiles(['**/*.loom'])
  server.documents.onDidChangeContent(({ document }) =>
    runtime.runSync(recordEdit(edited, URI.parse(document.uri))),
  )
  server.fileWatcher.onDidChangeWatchedFiles(({ changes }) =>
    rereadOnDisk(server, home, projects, reprojecting, closedLoomChanges(server, changes), []),
  )
  server.documents.onDidClose(({ document }) => {
    const uri = URI.parse(document.uri)
    const changes = isLoom(uri) ? closeOf(uri, document.getText()) : []
    rereadOnDisk(server, home, projects, reprojecting, changes, changes.length > 0 ? [uri] : [])
  })
}

const openSource = (server: LanguageServer): Source => ({
  read: (path) =>
    Option.match(Option.fromNullishOr(server.documents.get(URI.file(path))), {
      onSome: (document) => Effect.succeed(document.getText()),
      onNone: () =>
        Effect.try({
          try: () => readFileSync(path, 'utf8'),
          catch: (cause) => new ReadError({ path, cause }),
        }),
    }),
  list: Option.none(),
})

const recordEdit = (edited: Ref.Ref<ReadonlySet<string>>, uri: URI): Effect.Effect<void> =>
  isLoom(uri) ? Ref.update(edited, (paths) => new Set([...paths, uri.fsPath])) : Effect.void

const rebuildEdited = (
  server: LanguageServer,
  edited: Ref.Ref<ReadonlySet<string>>,
): Effect.Effect<ReadonlyArray<FileEvent>, never, LoomCompiler> =>
  Effect.all([Ref.getAndSet(edited, new Set<string>()), LoomCompiler]).pipe(
    Effect.flatMap(([paths, compiler]) =>
      Effect.forEach(paths, (path) =>
        compiler.rebuild(openSource(server), path).pipe(
          Effect.catchCause((cause) =>
            Effect.logError(`loom: rebuilding ${path} failed`, cause).pipe(Effect.as(true)),
          ),
          Effect.map((changed) =>
            changed
              ? Option.some<FileEvent>({
                  uri: URI.file(path).toString(),
                  type: FileChangeType.Changed,
                })
              : Option.none(),
          ),
        ),
      ),
    ),
    Effect.map(Array.getSomes),
  )

const settleEdits = (
  server: LanguageServer,
  home: string,
  projects: Cache.Cache<string, LanguageServerProject>,
  edited: Ref.Ref<ReadonlySet<string>>,
): Effect.Effect<void, never, LoomCompiler> =>
  rebuildEdited(server, edited).pipe(
    Effect.provideService(Scheduler.PreventSchedulerYield, true),
    Effect.flatMap((changes) => reproject(server, home, projects, changes, [])),
  )

const runtime = ManagedRuntime.make(
  Layer.mergeAll(LoomCompiler.layer, LoomFormatter.layer, LoomConfig.layer).pipe(
    Layer.provide(DocumentSource.layer),
    Layer.provide(PackageConfig.layer),
    Layer.provide(LoomConfig.layer),
  ),
)

const warmCorpus = (home: string): Effect.Effect<void, never, LoomCompiler | LoomConfig> =>
  Effect.gen(function* () {
    const config = yield* LoomConfig
    const compiler = yield* LoomCompiler
    const manifest = yield* config.manifest(home)
    if (manifest === undefined) return
    const corpus = join(home, manifest.corpus ?? 'corpus')
    const project = Option.some({ root: home, ignore: manifest.ignore ?? [] })
    yield* Option.match(Array.head(loomsIn(corpus, project)), {
      onNone: () => Effect.void,
      onSome: (entry) => Effect.asVoid(compiler.reach(entry)),
    })
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning('loom: could not warm the corpus', cause)),
  )

export const startLanguageServer = (): void => {
  const connection = createConnection()
  const server = createServer(connection)

  connection.onInitialize(async (params) => {
    const folder = params.workspaceFolders?.[0]?.uri
    const root = folder ? fileURLToPath(folder) : process.cwd()
    const home = workspaceRoot(root)
    const { services, projects, plugins, reprojecting, edited } = await runtime.runPromise(
      Effect.gen(function* () {
        const sdk = yield* typescriptSdkFor(params.initializationOptions)
        const services = yield* Cache.make({
          capacity: Infinity,
          lookup: (workspace: string) => loomServicePlugins(runtime, sdk, workspace),
        })
        const projects = yield* Cache.make({
          capacity: Infinity,
          lookup: (workspace: string) =>
            Cache.get(services, workspace).pipe(
              Effect.flatMap((plugins) => Effect.sync(() => projectOver(server, plugins))),
            ),
        })
        const plugins = yield* Cache.get(services, home)
        const reprojecting = yield* Semaphore.make(1)
        const edited = yield* Ref.make<ReadonlySet<string>>(new Set())
        return { services, projects, plugins, reprojecting, edited }
      }),
    )
    setTimeout(() => runtime.runSync(warmCorpus(home)), 10)
    return server.initialize(
      params,
      workspaceProject(server, home, services, projects, reprojecting, edited),
      [...plugins],
    )
  })
  connection.onInitialized(() => server.initialized())
  connection.onShutdown(server.shutdown)
  connection.listen()
}
