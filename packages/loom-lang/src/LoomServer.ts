import {
  Array,
  Cache,
  Data,
  Effect,
  Exit,
  Layer,
  ManagedRuntime,
  Match,
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
import { existsSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { URI } from 'vscode-uri'
import { LoomCompiler, DocumentSource, Placeholders, stringSnapshot, within } from './LoomCompiler'
import { type ReadError, type Source } from '#ast/LoomCorpusAstBuilder'
import { LoomFormatter } from './LoomFormatter'
import { WorkspaceSettings } from './WorkspaceSettings'
import { LoomConfig } from '@athrio/loom-config/LoomConfig'
import {
  fetchedExecutable,
  fetchedTypeScriptDir,
  fetchTypeScript,
  standalone,
  typeScriptVersion,
  workspaceOf,
} from '@athrio/loom-lang-services/LoomStore'
import {
  ClassicTypeScriptMissing,
  type FetchedTypeScript,
  type TypescriptSdkApi,
} from '@athrio/loom-lang-services/LanguageService'
import { loomLanguagePlugin, loomServicePlugins } from './LoomLanguagePlugin'
import { Environment, type Workspace, WorkspaceSource } from './WorkspaceSource'

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

const fetchSaved = (
  path: string,
): Effect.Effect<Option.Option<string>, never, WorkspaceSource | DocumentSource> =>
  Effect.gen(function* () {
    const source = yield* WorkspaceSource
    const documents = yield* DocumentSource
    const saved = yield* Effect.option(source.read(path))
    yield* Option.match(saved, {
      onNone: () => documents.forget(path),
      onSome: (text) => documents.hold(new Map([[path, text]])),
    })
    return saved
  })

interface ShownLoom {
  readonly text: string
  readonly snapshot: IScriptSnapshot
}

const heldText = (uri: URI): Effect.Effect<Option.Option<string>, never, WorkspaceSource | DocumentSource> =>
  Effect.all([WorkspaceSource, DocumentSource]).pipe(
    Effect.flatMap(([source, documents]) => Effect.option(documents.read(source.locationOf(uri)))),
  )

const savedLooms = (): ((uri: URI) => Option.Option<IScriptSnapshot>) => {
  const read = new Map<string, SavedLoom>()
  const shown = new Map<string, ShownLoom>()
  const readAgain = (path: string, modified: number): Option.Option<IScriptSnapshot> =>
    Option.map(runtime.runSync(fetchSaved(path)), (text) => {
      const snapshot = stringSnapshot(text)
      read.set(path, { modified, snapshot })
      return snapshot
    })
  const onDisk = (uri: URI): Option.Option<IScriptSnapshot> =>
    pipe(
      Option.liftThrowable(() => statSync(uri.fsPath).mtimeMs)(),
      Option.flatMap((modified) =>
        pipe(
          Option.fromNullishOr(read.get(uri.fsPath)),
          Option.filter((held) => held.modified === modified),
          Option.map((held) => held.snapshot),
          Option.orElse(() => readAgain(uri.fsPath, modified)),
        ),
      ),
    )
  const inMemory = (uri: URI): Option.Option<IScriptSnapshot> =>
    Option.map(
      Exit.match(runtime.runSyncExit(heldText(uri)), {
        onFailure: () => Option.none<string>(),
        onSuccess: (text) => text,
      }),
      (text) =>
        pipe(
          Option.fromNullishOr(shown.get(uri.toString())),
          Option.filter((kept) => kept.text === text),
          Option.map((kept) => kept.snapshot),
          Option.getOrElse(() => {
            const snapshot = stringSnapshot(text)
            shown.set(uri.toString(), { text, snapshot })
            return snapshot
          }),
        ),
    )
  return (uri) =>
    Match.value(uri).pipe(
      Match.when((loom) => !isLoom(loom), () => Option.none<IScriptSnapshot>()),
      Match.when((loom) => loom.scheme === 'file', onDisk),
      Match.orElse(inMemory),
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

const reconfiguredWorkspaces = (
  source: WorkspaceSource['Service'],
  changes: ReadonlyArray<FileEvent>,
): ReadonlyArray<string> =>
  pipe(
    changes,
    Array.filter((change) => change.uri.endsWith('/.loom/config.yaml')),
    Array.map((change) => dirname(dirname(source.locationOf(URI.parse(change.uri))))),
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
): Effect.Effect<void, never, LoomCompiler | WorkspaceSource> =>
  Effect.all([LoomCompiler, WorkspaceSource]).pipe(
    Effect.flatMap(([compiler, source]) =>
      compiler.invalidateWithin(workspace).pipe(
        Effect.andThen(
          Effect.forEach(
            Array.filter(openLooms(server), (uri) => within(workspace, source.locationOf(uri))),
            (uri) => recordEdit(edited, uri),
            { discard: true },
          ),
        ),
      ),
    ),
  )

const reconfigure = (
  server: LanguageServer,
  services: Cache.Cache<string, ReadonlyArray<LanguageServicePlugin>>,
  projects: Cache.Cache<string, LanguageServerProject>,
  edited: Ref.Ref<ReadonlySet<string>>,
  workspaces: ReadonlyArray<string>,
): Effect.Effect<void, never, LoomCompiler | WorkspaceSource> =>
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
      WorkspaceSource.pipe(
        Effect.flatMap((source) =>
          reconfigure(server, services, projects, edited, reconfiguredWorkspaces(source, changes)),
        ),
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
  source: WorkspaceSource['Service'],
  change: FileEvent,
): Effect.Effect<Option.Option<FileEvent>> =>
  compiler
    .invalidate(source.locationOf(URI.parse(change.uri)))
    .pipe(
      Effect.map((reprojected) =>
        change.type === FileChangeType.Changed && reprojected.length === 0
          ? Option.none()
          : Option.some(change),
      ),
    )

const fetchReported = (
  changes: ReadonlyArray<FileEvent>,
): Effect.Effect<void, never, WorkspaceSource | DocumentSource> =>
  WorkspaceSource.pipe(
    Effect.flatMap((source) =>
      Effect.forEach(
        Array.filter(Array.map(changes, (change) => URI.parse(change.uri)), isLoom),
        (uri) => fetchSaved(source.locationOf(uri)),
        { discard: true },
      ),
    ),
  )

const rereadLooms = (
  changes: ReadonlyArray<FileEvent>,
): Effect.Effect<ReadonlyArray<FileEvent>, never, LoomCompiler | WorkspaceSource> =>
  Effect.all([LoomCompiler, WorkspaceSource]).pipe(
    Effect.flatMap(([compiler, source]) =>
      Effect.forEach(changes, (change) => rereadLoom(compiler, source, change)),
    ),
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
    Effect.catchCause((cause) => Effect.logError(`loom: ${step} ${uri.toString()} failed`, cause)),
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

export const closeOf = (
  uri: URI,
  text: string,
): Effect.Effect<ReadonlyArray<FileEvent>, never, WorkspaceSource | DocumentSource> =>
  WorkspaceSource.pipe(
    Effect.flatMap((source) => fetchSaved(source.locationOf(uri))),
    Effect.map(
      Option.match({
        onNone: (): ReadonlyArray<FileEvent> => [
          { uri: uri.toString(), type: FileChangeType.Deleted },
        ],
        onSome: (saved) =>
          saved === text ? [] : [{ uri: uri.toString(), type: FileChangeType.Changed }],
      }),
    ),
  )

const rereadOnDisk = (
  server: LanguageServer,
  home: string,
  projects: Cache.Cache<string, LanguageServerProject>,
  reprojecting: Semaphore.Semaphore,
  fetched: Effect.Effect<ReadonlyArray<FileEvent>, never, WorkspaceSource | DocumentSource>,
  forgottenBy: (changes: ReadonlyArray<FileEvent>) => ReadonlyArray<URI>,
): void =>
  void runtime.runFork(
    reprojecting.withPermits(1)(
      fetched.pipe(
        Effect.flatMap((changes) =>
          rereadLooms(changes).pipe(
            Effect.flatMap((counted) =>
              reproject(server, home, projects, counted, forgottenBy(changes)),
            ),
          ),
        ),
        Effect.catchCause((cause) => Effect.logError('loom: rereading changed looms failed', cause)),
      ),
    ),
  )

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
    rereadOnDisk(
      server,
      home,
      projects,
      reprojecting,
      fetchReported(changes).pipe(Effect.as(closedLoomChanges(server, changes))),
      () => [],
    ),
  )
  server.documents.onDidClose(({ document }) => {
    const uri = URI.parse(document.uri)
    rereadOnDisk(
      server,
      home,
      projects,
      reprojecting,
      isLoom(uri) ? closeOf(uri, document.getText()) : Effect.succeed([]),
      (changes) => (changes.length > 0 ? [uri] : []),
    )
  })
}

const openSource = (
  server: LanguageServer,
  documents: DocumentSource['Service'],
  source: WorkspaceSource['Service'],
): Source => ({
  read: (path) =>
    Option.match(Option.fromNullishOr(server.documents.get(source.uriOf(path))), {
      onSome: (document) => Effect.succeed(document.getText()),
      onNone: () => documents.read(path),
    }),
  list: Option.none(),
})

const recordEdit = (
  edited: Ref.Ref<ReadonlySet<string>>,
  uri: URI,
): Effect.Effect<void, never, WorkspaceSource> =>
  isLoom(uri)
    ? WorkspaceSource.pipe(
        Effect.flatMap((source) =>
          Ref.update(edited, (paths) => new Set([...paths, source.locationOf(uri)])),
        ),
      )
    : Effect.void

const rebuildEdited = (
  server: LanguageServer,
  edited: Ref.Ref<ReadonlySet<string>>,
): Effect.Effect<ReadonlyArray<FileEvent>, never, LoomCompiler | DocumentSource | WorkspaceSource> =>
  Effect.all([
    Ref.getAndSet(edited, new Set<string>()),
    LoomCompiler,
    DocumentSource,
    WorkspaceSource,
  ]).pipe(
    Effect.flatMap(([paths, compiler, documents, source]) =>
      Effect.forEach(paths, (path) =>
        compiler.rebuild(openSource(server, documents, source), path).pipe(
          Effect.catchCause((cause) =>
            Effect.logError(`loom: rebuilding ${path} failed`, cause).pipe(Effect.as(true)),
          ),
          Effect.map((changed) =>
            changed
              ? Option.some<FileEvent>({
                  uri: source.uriOf(path).toString(),
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
): Effect.Effect<void, never, LoomCompiler | DocumentSource | WorkspaceSource> =>
  rebuildEdited(server, edited).pipe(
    Effect.provideService(Scheduler.PreventSchedulerYield, true),
    Effect.flatMap((changes) => reproject(server, home, projects, changes, [])),
  )

const runtime = ManagedRuntime.make(
  Layer.mergeAll(LoomCompiler.layer, LoomFormatter.layer).pipe(
    Layer.provideMerge(Placeholders.layer),
    Layer.provideMerge(DocumentSource.layer),
    Layer.provideMerge(Layer.orDie(Environment)),
    Layer.provideMerge(LoomConfig.layer),
  ),
)

const openWorkspace = (
  home: string,
): Effect.Effect<
  Option.Option<Workspace>,
  ReadError,
  WorkspaceSettings | WorkspaceSource | DocumentSource
> =>
  WorkspaceSettings.pipe(
    Effect.flatMap((settings) => settings.manifest(home)),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed(Option.none<Workspace>()),
        onSome: () =>
          Effect.gen(function* () {
            const source = yield* WorkspaceSource
            const documents = yield* DocumentSource
            const workspace = yield* source.open(home)
            yield* documents.hold(workspace.looms)
            return Option.some(workspace)
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning('loom: could not open the workspace', cause).pipe(
                Effect.as(Option.none<Workspace>()),
              ),
            ),
          ),
      }),
    ),
  )

const warmCorpus = (workspace: Option.Option<Workspace>): Effect.Effect<void, never, LoomCompiler> =>
  pipe(
    Option.flatMap(workspace, (opened) => Array.head(Array.fromIterable(opened.looms.keys()))),
    Option.match({
      onNone: () => Effect.void,
      onSome: (entry) =>
        LoomCompiler.pipe(Effect.flatMap((compiler) => Effect.asVoid(compiler.reach(entry)))),
    }),
    Effect.catchCause((cause) => Effect.logWarning('loom: could not warm the corpus', cause)),
  )

const homeOf = (folder: string | undefined): Effect.Effect<string, never, WorkspaceSource> =>
  WorkspaceSource.pipe(
    Effect.map((source) =>
      source.workspaceOf(
        Option.match(Option.fromNullishOr(folder), {
          onNone: () => process.cwd(),
          onSome: (uri) => source.locationOf(URI.parse(uri)),
        }),
      ),
    ),
  )

export const startLanguageServer = (): void => {
  const connection = createConnection()
  const server = createServer(connection)

  connection.onInitialize(async (params) => {
    const home = await runtime.runPromise(homeOf(params.workspaceFolders?.[0]?.uri))
    const { workspace, services, projects, plugins, reprojecting, edited } = await runtime.runPromise(
      Effect.gen(function* () {
        const workspace = yield* openWorkspace(home)
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
        return { workspace, services, projects, plugins, reprojecting, edited }
      }),
    )
    setTimeout(() => runtime.runSync(warmCorpus(workspace)), 10)
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
