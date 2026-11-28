import {
  Array,
  Cache,
  Cause,
  Data,
  Duration,
  Effect,
  Exit,
  Layer,
  Logger,
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
  type CreateFile,
  createLanguageServiceEnvironment,
  createServer,
  FileChangeType,
  type FileEvent,
  type InitializeParams,
  type Language,
  type LanguageServer,
  type LanguageServerProject,
  type LanguageServicePlugin,
  LSPErrorCodes,
  ResponseError,
  type TextDocumentEdit,
  type WorkspaceEdit,
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
import {
  type EditAnswer,
  LoomCompiler,
  DocumentSource,
  stringSnapshot,
  type SummaryEdit,
  within,
} from './LoomCompiler'
import {
  type Concepts,
  coreTypes,
  type NoSuchLoom,
  type Outline,
  type Types,
} from './OutlineBuilder'
import { type EditBreaksLoom, type EditRefusal, LoomIntentSchema } from './EditBuilder'
import { LanguagePackages } from './LanguagePackages'
import { TropePackages } from './TropePackages'
import { type ReadError, type Source } from '#ast/LoomCorpusAstBuilder'
import {
  broke,
  describe,
  failureIn,
  failureWording,
  lineOf,
  type LoomFailure,
  type Work,
} from '#ast/LoomFailure'
import { LoomFormatter } from './LoomFormatter'
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
  type FetchedTypeScript,
  type TypescriptSdkApi,
} from '@athrio/loom-lang-services/LanguageService'
import { loomLanguagePlugin, loomServicePlugins } from './LoomLanguagePlugin'
import { type TableOfContents } from './weave/TableOfContentsBuilder'
import { Environment, type Workspace, WorkspaceSource } from './WorkspaceSource'

const lineFor = (failure: LoomFailure): string => lineOf(describe(failure))

const inWords = (failure: LoomFailure): Error => new Error(lineFor(failure))

const serverLogger = Logger.make((logged: Logger.Options<unknown>) =>
  Logger.defaultLogger.log(
    Option.match(failureIn(failureWording)(logged.message), {
      onNone: () => logged,
      onSome: (failure) => ({ ...logged, message: [lineFor(failure)] }),
    }),
  ),
)

const told =
  (work: Work, subject: string) =>
  <E extends LoomFailure>(cause: Cause.Cause<E>): Effect.Effect<void> =>
    Cause.hasInterruptsOnly(cause)
      ? Effect.void
      : Effect.logError(
          lineFor(
            Option.getOrElse(Cause.findErrorOption(cause), (): LoomFailure =>
              broke(work, subject, cause),
            ),
          ),
          cause,
        )

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

export class ClassicTypeScriptMissing extends Data.TaggedError('ClassicTypeScriptMissing')<{
  readonly folder: string
  readonly tsdk: Option.Option<string>
  readonly cause?: unknown
}> {}

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
}> {}

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
    fetch: () => runtime.runPromise(Effect.asVoid(once).pipe(Effect.mapError(inWords))),
  }
})

const typescriptSdkFor = (options: unknown): Effect.Effect<TypescriptSdkApi> =>
  Effect.map(fetchedTypeScript, (fetched) => {
    const classic = classicTypeScript(options)
    return { classic: (folder) => Result.mapError(classic(folder), inWords), fetched }
  })

const workspaceNamed = (source: WorkspaceSource['Service'], home: string, location: string): string =>
  Option.getOrElse(
    Option.filter(Option.some(source.workspaceOf(location)), (named) => named !== location),
    () => home,
  )

const workspaceFor = (source: WorkspaceSource['Service'], home: string, uri: URI): string =>
  uri.scheme === 'file'
    ? Option.getOrElse(workspaceOf(dirname(uri.fsPath)), () => home)
    : workspaceNamed(source, home, source.locationOf(uri))

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

const snapshotBy = Match.fn(
  (
    _within: {
      readonly onDisk: (uri: URI) => Option.Option<IScriptSnapshot>
      readonly inMemory: (uri: URI) => Option.Option<IScriptSnapshot>
    },
    uri: URI,
  ) => uri,
).pipe(
  Match.withReturnType<Option.Option<IScriptSnapshot>>(),
  Match.when((loom) => !isLoom(loom), () => Option.none<IScriptSnapshot>()),
  Match.when((loom) => loom.scheme === 'file', (matched, { onDisk }) => onDisk(matched)),
  Match.orElse((matched, { inMemory }) => inMemory(matched)),
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
    snapshotBy({ onDisk, inMemory }, uri)
}

export const workspaceProject = (
  server: LanguageServer,
  home: string,
  services: Cache.Cache<string, ReadonlyArray<LanguageServicePlugin>>,
  projects: Cache.Cache<string, LanguageServerProject>,
  places: Places,
  reprojecting: Semaphore.Semaphore,
  edited: Ref.Ref<ReadonlySet<string>>,
): LanguageServerProject => ({
  setup: (server) => {
    watchConfigs(server, home, services, projects, places, reprojecting, edited)
    watchLooms(server, home, projects, places, reprojecting, edited)
    watchRelations(server)
  },
  getLanguageService: (uri) =>
    runtime.runPromise(
      reprojecting
        .withPermits(1)(
          settleEdits(server, home, projects, places, edited).pipe(
            Effect.andThen(WorkspaceSource),
            Effect.flatMap((source) => Cache.get(projects, workspaceFor(source, home, uri))),
          ),
        )
        .pipe(
          Effect.flatMap((project) => Effect.promise(async () => project.getLanguageService(uri))),
        ),
    ),
  getExistingLanguageServices: () =>
    runtime.runPromise(
      reprojecting.withPermits(1)(settleEdits(server, home, projects, places, edited)).pipe(
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
  Array.dedupe(
    changes
      .filter((change) => change.uri.endsWith('/.loom/config.yaml'))
      .map((change) => dirname(dirname(source.locationOf(URI.parse(change.uri))))),
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
            openLooms(server).filter((uri) => within(workspace, source.locationOf(uri))),
            (uri) => recordEdit(edited, uri),
            { discard: true },
          ),
        ),
      ),
    ),
  )

const closeWorkspace = (
  services: Cache.Cache<string, ReadonlyArray<LanguageServicePlugin>>,
  projects: Cache.Cache<string, LanguageServerProject>,
  places: Places,
  workspace: string,
): Effect.Effect<void, never, WorkspaceSource> =>
  WorkspaceSource.pipe(
    Effect.flatMap((source) => source.close(workspace)),
    Effect.andThen(Cache.invalidate(places, workspace)),
    Effect.andThen(forgetWorkspace(services, projects, workspace)),
  )

const reconfigure = (
  server: LanguageServer,
  services: Cache.Cache<string, ReadonlyArray<LanguageServicePlugin>>,
  projects: Cache.Cache<string, LanguageServerProject>,
  places: Places,
  edited: Ref.Ref<ReadonlySet<string>>,
  workspaces: ReadonlyArray<string>,
): Effect.Effect<void, never, LoomCompiler | WorkspaceSource> =>
  workspaces.length === 0
    ? Effect.void
    : Effect.forEach(
        workspaces,
        (workspace) =>
          rebuildUnder(server, edited, workspace).pipe(
            Effect.andThen(closeWorkspace(services, projects, places, workspace)),
          ),
        { discard: true },
      ).pipe(Effect.andThen(Effect.sync(() => void server.languageFeatures.requestRefresh(true))))

const isCompilerSetting = (uri: string): boolean =>
  /\/(tsconfig|jsconfig|package)\.json$/.test(uri) && !uri.includes('/node_modules/')

const retypedWorkspaces = (
  source: WorkspaceSource['Service'],
  home: string,
  changes: ReadonlyArray<FileEvent>,
): ReadonlyArray<string> =>
  Array.dedupe(
    changes
      .filter((change) => isCompilerSetting(change.uri))
      .map((change) => workspaceFor(source, home, URI.parse(change.uri))),
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
  places: Places,
  reprojecting: Semaphore.Semaphore,
  edited: Ref.Ref<ReadonlySet<string>>,
): void => {
  void server.fileWatcher.watchFiles([
    '**/.loom/config.yaml',
    '**/tsconfig.json',
    '**/jsconfig.json',
    '**/package.json',
  ])
  server.fileWatcher.onDidChangeWatchedFiles(
    ({ changes }) =>
      void runtime.runFork(
        reprojecting.withPermits(1)(
          WorkspaceSource.pipe(
            Effect.flatMap((source) =>
              reconfigure(
                server,
                services,
                projects,
                places,
                edited,
                reconfiguredWorkspaces(source, changes),
              ).pipe(
                Effect.andThen(retype(server, projects, retypedWorkspaces(source, home, changes))),
              ),
            ),
          ),
        ),
      ),
  )
}

const isLoom = (uri: URI): boolean => uri.path.endsWith('.loom')

const closedLoomChanges = (
  server: LanguageServer,
  changes: ReadonlyArray<FileEvent>,
): ReadonlyArray<FileEvent> =>
  changes.filter((change) => {
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

const fetchReportedLoom = (
  source: WorkspaceSource['Service'],
  change: FileEvent,
): Effect.Effect<void, never, WorkspaceSource | DocumentSource> => {
  const loom = source.locationOf(URI.parse(change.uri))
  return fetchSaved(loom).pipe(
    Effect.flatMap((saved) =>
      change.type === FileChangeType.Changed
        ? Effect.void
        : source.relist(loom, Option.isSome(saved)),
    ),
  )
}

const fetchReported = (
  changes: ReadonlyArray<FileEvent>,
): Effect.Effect<void, never, WorkspaceSource | DocumentSource> =>
  WorkspaceSource.pipe(
    Effect.flatMap((source) =>
      Effect.forEach(
        changes.filter((change) => isLoom(URI.parse(change.uri))),
        (change) => fetchReportedLoom(source, change),
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
  server.documents
    .all()
    .map((document) => URI.parse(document.uri))
    .filter(isLoom)

const openLoomsIn = (
  server: LanguageServer,
  source: WorkspaceSource['Service'],
  home: string,
  workspace: string,
): ReadonlyArray<URI> =>
  openLooms(server).filter((uri) => workspaceFor(source, home, uri) === workspace)

const logged = (work: Work, uri: URI, effect: Effect.Effect<void>): Effect.Effect<void> =>
  effect.pipe(Effect.catchCause(told(work, uri.toString())))

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
): Effect.Effect<void, never, WorkspaceSource> =>
  Effect.gen(function* () {
    const source = yield* WorkspaceSource
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
      openLoomsIn(server, source, home, workspace),
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
): Effect.Effect<void, never, WorkspaceSource> =>
  Cache.getSuccess(projects, workspace).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.void,
        onSome: (project) => refreshProject(server, home, workspace, project, forgotten),
      }),
    ),
  )

const refreshEverything = (server: LanguageServer): void =>
  void server.languageFeatures.requestRefresh(false)

const refusalIgnored = (asked: void | Promise<void>): void =>
  void Promise.resolve(asked).catch(() => undefined)

export const refreshDecorations = (server: LanguageServer): void => {
  const supported = server.initializeParams.capabilities.workspace
  if (supported?.semanticTokens?.refreshSupport === true)
    refusalIgnored(server.connection.languages.semanticTokens.refresh())
  if (supported?.inlayHint?.refreshSupport === true)
    refusalIgnored(server.connection.languages.inlayHint.refresh())
}

const reproject = (
  server: LanguageServer,
  home: string,
  projects: Cache.Cache<string, LanguageServerProject>,
  changes: ReadonlyArray<FileEvent>,
  alsoForgotten: ReadonlyArray<URI>,
  refresh: (server: LanguageServer) => void,
): Effect.Effect<void, never, WorkspaceSource> => {
  const forgotten = [
    ...changes
      .filter((change) => change.type === FileChangeType.Deleted)
      .map((change) => URI.parse(change.uri)),
    ...alsoForgotten,
  ]
  return changes.length === 0
    ? Effect.void
    : WorkspaceSource.pipe(
        Effect.flatMap((source) =>
          Effect.forEach(
            Array.dedupe(
              changes.map((change) => workspaceFor(source, home, URI.parse(change.uri))),
            ),
            (workspace) => reprojectWorkspace(server, home, projects, workspace, forgotten),
            { discard: true },
          ),
        ),
        Effect.andThen(Effect.sync(() => refresh(server))),
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
              reproject(server, home, projects, counted, forgottenBy(changes), refreshEverything),
            ),
          ),
        ),
        Effect.catchCause(told('rereading', '')),
      ),
    ),
  )

const watchLooms = (
  server: LanguageServer,
  home: string,
  projects: Cache.Cache<string, LanguageServerProject>,
  places: Places,
  reprojecting: Semaphore.Semaphore,
  edited: Ref.Ref<ReadonlySet<string>>,
): void => {
  void server.fileWatcher.watchFiles(['**/*.loom'])
  const seen = runtime.runSync(Ref.make<ReadonlyMap<string, string>>(new Map()))
  server.documents.onDidChangeContent(({ document }) => {
    runtime.runSync(recordEdit(edited, URI.parse(document.uri)))
    keepInStep(
      server,
      home,
      projects,
      places,
      reprojecting,
      edited,
      seen,
      URI.parse(document.uri),
      document.getText(),
    )
  })
  server.fileWatcher.onDidChangeWatchedFiles(({ changes }) =>
    rereadOnDisk(
      server,
      home,
      projects,
      reprojecting,
      fetchReported(changes).pipe(
        Effect.andThen(Effect.sync(() => closedLoomChanges(server, changes))),
      ),
      () => [],
    ),
  )
  server.documents.onDidClose(({ document }) => {
    const uri = URI.parse(document.uri)
    runtime.runSync(forgetSeen(seen, uri))
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

const isRelations = (change: FileEvent): boolean => change.uri.endsWith('/.loom/relations.lock')

const watchRelations = (server: LanguageServer): void => {
  void server.fileWatcher.watchFiles(['**/.loom/relations.lock'])
  server.fileWatcher.onDidChangeWatchedFiles(({ changes }) => {
    if (changes.some(isRelations)) void server.languageFeatures.requestRefresh(true)
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
          Effect.catchCause((cause) => told('rebuilding', path)(cause).pipe(Effect.as(true))),
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

const openEdited = (
  home: string,
  places: Places,
  edited: Ref.Ref<ReadonlySet<string>>,
): Effect.Effect<void, never, WorkspaceSource> =>
  Effect.all([Ref.get(edited), WorkspaceSource]).pipe(
    Effect.flatMap(([paths, source]) =>
      Effect.forEach(
        Array.dedupe([...paths].map((path) => workspaceFor(source, home, source.uriOf(path)))),
        (workspace) => placeOpened(places, workspace),
        { discard: true },
      ),
    ),
  )

const settleEdits = (
  server: LanguageServer,
  home: string,
  projects: Cache.Cache<string, LanguageServerProject>,
  places: Places,
  edited: Ref.Ref<ReadonlySet<string>>,
): Effect.Effect<void, never, LoomCompiler | DocumentSource | WorkspaceSource> =>
  openEdited(home, places, edited).pipe(
    Effect.andThen(
      rebuildEdited(server, edited).pipe(Effect.provideService(Scheduler.PreventSchedulerYield, true)),
    ),
    Effect.flatMap((changes) => reproject(server, home, projects, changes, [], refreshDecorations)),
  )

const applySummaryEdits = (
  server: LanguageServer,
  edits: ReadonlyArray<SummaryEdit>,
): Effect.Effect<void, never, WorkspaceSource> =>
  Array.isReadonlyArrayNonEmpty(edits)
    ? WorkspaceSource.pipe(
        Effect.flatMap((source) =>
          Effect.promise(() =>
            server.connection.workspace.applyEdit({
              label: 'Keep a box in step',
              edit: {
                documentChanges: Object.entries(Array.groupBy(edits, (edit) => edit.path)).map(
                  ([path, inLoom]) => ({
                    textDocument: {
                      uri: source.uriOf(path).toString(),
                      version: server.documents.get(source.uriOf(path))?.version ?? null,
                    },
                    edits: inLoom.map((edit) => ({ range: edit.range, newText: edit.text })),
                  }),
                ),
              },
            }),
          ),
        ),
        Effect.asVoid,
      )
    : Effect.void

const keepInStep = (
  server: LanguageServer,
  home: string,
  projects: Cache.Cache<string, LanguageServerProject>,
  places: Places,
  reprojecting: Semaphore.Semaphore,
  edited: Ref.Ref<ReadonlySet<string>>,
  seen: Ref.Ref<ReadonlyMap<string, string>>,
  uri: URI,
  after: string,
): void => {
  if (!isLoom(uri)) return
  void runtime.runFork(
    Ref.modify(
      seen,
      (texts) =>
        [
          Option.fromNullishOr(texts.get(uri.toString())),
          new Map(texts).set(uri.toString(), after),
        ] as const,
    ).pipe(
      Effect.flatMap((before) =>
        Option.match(
          Option.filter(before, (was) => was !== after),
          {
            onNone: () => Effect.void,
            onSome: (was) =>
              reprojecting
                .withPermits(1)(
                  settleEdits(server, home, projects, places, edited).pipe(
                    Effect.andThen(Effect.all([LoomCompiler, WorkspaceSource])),
                    Effect.flatMap(([compiler, source]) =>
                      compiler.summaryEdits(source.locationOf(uri), was, after),
                    ),
                  ),
                )
                .pipe(Effect.flatMap((edits) => applySummaryEdits(server, edits))),
          },
        ),
      ),
      Effect.catchCause(told('keeping', uri.toString())),
    ),
  )
}

const forgetSeen = (seen: Ref.Ref<ReadonlyMap<string, string>>, uri: URI): Effect.Effect<void> =>
  Ref.update(seen, (texts) => new Map([...texts].filter(([key]) => key !== uri.toString())))

export const contentsRequest = 'loom/contents'

const AddressSchema = Schema.Struct({ workspace: Schema.optional(Schema.String) })

type Places = Cache.Cache<string, Option.Option<string>, ReadError>

const noBooks: TableOfContents = { books: [] }

const workspaceAsked = (
  source: WorkspaceSource['Service'],
  home: string,
  params: unknown,
): string =>
  Option.match(
    Option.flatMap(Schema.decodeUnknownOption(AddressSchema)(params), ({ workspace }) =>
      Option.fromNullishOr(workspace),
    ),
    {
      onNone: () => home,
      onSome: (workspace) => source.workspaceOf(source.locationOf(URI.parse(workspace))),
    },
  )

const entryOf = (
  place: Option.Option<string>,
): Effect.Effect<Option.Option<string>, never, WorkspaceSource> =>
  Option.match(place, {
    onNone: () => Effect.succeed(Option.none<string>()),
    onSome: (loom) =>
      WorkspaceSource.pipe(
        Effect.flatMap((source) => source.corpusOf(loom)),
        Effect.map(Array.head),
      ),
  })

const contentsOf = (
  place: Option.Option<string>,
): Effect.Effect<TableOfContents, never, LoomCompiler | WorkspaceSource> =>
  entryOf(place).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed(noBooks),
        onSome: (entry) =>
          LoomCompiler.pipe(
            Effect.flatMap((compiler) => compiler.contents(entry)),
            Effect.catchCause((cause) => told('listing', entry)(cause).pipe(Effect.as(noBooks))),
          ),
      }),
    ),
  )

const contentsFor = (
  places: Places,
  home: string,
  params: unknown,
): Effect.Effect<TableOfContents, ReadError, LoomCompiler | WorkspaceSource> =>
  WorkspaceSource.pipe(
    Effect.flatMap((source) => Cache.get(places, workspaceAsked(source, home, params))),
    Effect.flatMap(contentsOf),
  )

export const outlineRequest = 'loom/outline'

export const conceptsRequest = 'loom/concepts'

export const typesRequest = 'loom/types'

export const editRequest = 'loom/edit'

const OutlineParamsSchema = Schema.Struct({ uri: Schema.String })

const EditParamsSchema = Schema.Struct({
  workspace: Schema.optional(Schema.String),
  edit: LoomIntentSchema,
})

export class RequestUnread extends Data.TaggedError('RequestUnread')<{
  readonly request: string
  readonly cause: unknown
}> {}

const paramsOf =
  <A>(request: string, decode: (asked: unknown) => Effect.Effect<A, Schema.SchemaError>) =>
  (asked: unknown): Effect.Effect<A, RequestUnread> =>
    decode(asked).pipe(Effect.mapError((cause) => new RequestUnread({ request, cause })))

const outlineParams = paramsOf(outlineRequest, Schema.decodeUnknownEffect(OutlineParamsSchema))

const editParams = paramsOf(editRequest, Schema.decodeUnknownEffect(EditParamsSchema))

const noConcepts: Concepts = { concepts: [] }

const outlineFor = (
  places: Places,
  home: string,
  asked: unknown,
): Effect.Effect<Outline, RequestUnread | NoSuchLoom | ReadError, LoomCompiler | WorkspaceSource> =>
  Effect.all([outlineParams(asked), WorkspaceSource]).pipe(
    Effect.flatMap(([{ uri }, source]) => {
      const loom = URI.parse(uri)
      return Cache.get(places, workspaceFor(source, home, loom)).pipe(
        Effect.andThen(LoomCompiler),
        Effect.flatMap((compiler) => compiler.outline(source.locationOf(loom))),
      )
    }),
  )

const conceptsFor = (
  places: Places,
  home: string,
  asked: unknown,
): Effect.Effect<Concepts, ReadError, LoomCompiler | WorkspaceSource> =>
  WorkspaceSource.pipe(
    Effect.flatMap((source) => Cache.get(places, workspaceAsked(source, home, asked))),
    Effect.flatMap(entryOf),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed(noConcepts),
        onSome: (entry) =>
          LoomCompiler.pipe(Effect.flatMap((compiler) => compiler.concepts(entry))),
      }),
    ),
  )

const typesFor = (
  places: Places,
  home: string,
  asked: unknown,
): Effect.Effect<Types, ReadError, LoomCompiler | WorkspaceSource> =>
  WorkspaceSource.pipe(
    Effect.flatMap((source) => Cache.get(places, workspaceAsked(source, home, asked))),
    Effect.flatMap(entryOf),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed(coreTypes),
        onSome: (entry) => LoomCompiler.pipe(Effect.flatMap((compiler) => compiler.types(entry))),
      }),
    ),
  )

const editFor = (
  places: Places,
  home: string,
  asked: unknown,
): Effect.Effect<
  LoomWorkspaceEdit,
  RequestUnread | EditRefusal | EditBreaksLoom | ReadError,
  LoomCompiler | WorkspaceSource
> =>
  Effect.all([editParams(asked), WorkspaceSource]).pipe(
    Effect.flatMap(([{ edit }, source]) => {
      const workspace = workspaceAsked(source, home, asked)
      return Cache.get(places, workspace).pipe(
        Effect.flatMap(entryOf),
        Effect.flatMap((entry) =>
          LoomCompiler.pipe(
            Effect.flatMap((compiler) =>
              compiler.edit(workspace, entry, edit, (uri) => source.locationOf(URI.parse(uri))),
            ),
          ),
        ),
        Effect.map((answer) => workspaceEditOf(source, answer)),
      )
    }),
  )

type LoomWorkspaceEdit = WorkspaceEdit & {
  readonly removed: ReadonlyArray<string>
  readonly configuration?: string
}

const atStart = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }

const workspaceEditOf = (
  source: WorkspaceSource['Service'],
  answer: EditAnswer,
): LoomWorkspaceEdit => ({
  documentChanges: [
    ...answer.made.flatMap((made): ReadonlyArray<CreateFile | TextDocumentEdit> => {
      const uri = source.uriOf(made.path).toString()
      return [
        { kind: 'create', uri },
        { textDocument: { uri, version: null }, edits: [{ range: atStart, newText: made.text }] },
      ]
    }),
    ...Object.entries(Array.groupBy(answer.edits, (edit) => edit.path)).map(
      ([path, edits]): TextDocumentEdit => ({
        textDocument: { uri: source.uriOf(path).toString(), version: null },
        edits: edits.map((edit) => ({ range: edit.range, newText: edit.text })),
      }),
    ),
  ],
  removed: answer.removed.map((path) => source.uriOf(path).toString()),
  ...Option.match(answer.configuration, {
    onNone: () => ({}),
    onSome: (configuration) => ({ configuration }),
  }),
})

const refusalOf = (failure: LoomFailure): ResponseError<Record<string, unknown>> =>
  new ResponseError(
    LSPErrorCodes.RequestFailed,
    lineFor(failure),
    Object.fromEntries(Object.entries(failure).filter(([key]) => key !== 'cause')),
  )

const runtime = ManagedRuntime.make(
  Layer.mergeAll(LoomCompiler.layer, LoomFormatter.layer).pipe(
    Layer.provideMerge(LanguagePackages.held),
    Layer.provideMerge(TropePackages.layer),
    Layer.provideMerge(DocumentSource.layer),
    Layer.provideMerge(Layer.orDie(Environment)),
    Layer.provideMerge(LoomConfig.layer),
    Layer.provideMerge(Logger.layer([serverLogger])),
  ),
)

const openedFolders = (params: InitializeParams): ReadonlyArray<string> =>
  Option.getOrElse(
    Option.firstSomeOf([
      Option.map(
        Option.filter(Option.fromNullishOr(params.workspaceFolders), (folders) => folders.length > 0),
        (folders) => folders.map((folder) => folder.uri),
      ),
      Option.map(Option.fromNullishOr(params.rootUri), (uri) => [uri]),
      Option.map(Option.fromNullishOr(params.rootPath), (path) => [URI.file(path).toString()]),
    ]),
    (): ReadonlyArray<string> => [],
  )

const workspacesAt = (
  source: WorkspaceSource['Service'],
  folders: ReadonlyArray<string>,
): ReadonlyArray<string> =>
  Array.dedupe(folders.map((folder) => source.workspaceOf(source.locationOf(URI.parse(folder)))))

const servedWorkspaces = (
  params: InitializeParams,
): Effect.Effect<Array.NonEmptyReadonlyArray<string>, never, WorkspaceSource> =>
  WorkspaceSource.pipe(
    Effect.map((source) =>
      Array.match(workspacesAt(source, openedFolders(params)), {
        onEmpty: (): Array.NonEmptyReadonlyArray<string> => [source.workspaceOf(process.cwd())],
        onNonEmpty: (named) => named,
      }),
    ),
  )

const openWorkspace = (
  workspace: string,
): Effect.Effect<Option.Option<Workspace>, ReadError, WorkspaceSource | DocumentSource> =>
  WorkspaceSource.pipe(
    Effect.flatMap((source) => source.open(workspace)),
    Effect.flatMap((opened) =>
      Option.match(opened.manifest, {
        onNone: () => Effect.succeed(Option.none<Workspace>()),
        onSome: () =>
          DocumentSource.pipe(
            Effect.flatMap((documents) => documents.hold(opened.looms)),
            Effect.as(Option.some(opened)),
          ),
      }),
    ),
  )

const openedPlace = (
  workspace: string,
): Effect.Effect<Option.Option<string>, ReadError, WorkspaceSource | DocumentSource> =>
  openWorkspace(workspace).pipe(
    Effect.map(Option.flatMap((opened) => Array.head(Array.fromIterable(opened.looms.keys())))),
  )

const lifetimeOf = (opened: Exit.Exit<Option.Option<string>, ReadError>): Duration.Duration =>
  Exit.isSuccess(opened) ? Duration.infinity : Duration.zero

const placeOpened = (places: Places, workspace: string): Effect.Effect<Option.Option<string>> =>
  Cache.get(places, workspace).pipe(
    Effect.catchCause((cause) =>
      told('opening', workspace)(cause).pipe(Effect.as(Option.none<string>())),
    ),
  )

const warmCorpus = (
  place: Option.Option<string>,
): Effect.Effect<void, never, LoomCompiler | WorkspaceSource> =>
  entryOf(place).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.void,
        onSome: (entry) =>
          LoomCompiler.pipe(
            Effect.flatMap((compiler) => Effect.asVoid(compiler.reach(entry))),
            Effect.catchCause(told('warming', entry)),
          ),
      }),
    ),
  )

const warmInTurn = (places: ReadonlyArray<Option.Option<string>>): void =>
  Array.match(places, {
    onEmpty: () => undefined,
    onNonEmpty: ([place, ...rest]) =>
      void setTimeout(() => {
        runtime.runSync(warmCorpus(place))
        warmInTurn(rest)
      }, 10),
  })

const closeRemoved = (
  server: LanguageServer,
  services: Cache.Cache<string, ReadonlyArray<LanguageServicePlugin>>,
  projects: Cache.Cache<string, LanguageServerProject>,
  places: Places,
  removed: ReadonlyArray<string>,
): Effect.Effect<void, never, WorkspaceSource> =>
  WorkspaceSource.pipe(
    Effect.flatMap((source) => {
      const held = workspacesAt(
        source,
        server.workspaceFolders.all.map((folder) => folder.toString()),
      )
      return Effect.forEach(
        workspacesAt(source, removed).filter((workspace) => !Array.contains(held, workspace)),
        (workspace) => closeWorkspace(services, projects, places, workspace),
        { discard: true },
      )
    }),
  )

const openAdded = (
  places: Places,
  added: ReadonlyArray<string>,
): Effect.Effect<void, never, WorkspaceSource> =>
  WorkspaceSource.pipe(
    Effect.flatMap((source) =>
      Effect.forEach(workspacesAt(source, added), (workspace) => placeOpened(places, workspace)),
    ),
    Effect.flatMap((opened) => Effect.sync(() => warmInTurn(opened))),
  )

const urisOf = (folders: ReadonlyArray<{ readonly uri: string }>): ReadonlyArray<string> =>
  folders.map((folder) => folder.uri)

const watchFolders = (
  server: LanguageServer,
  services: Cache.Cache<string, ReadonlyArray<LanguageServicePlugin>>,
  projects: Cache.Cache<string, LanguageServerProject>,
  places: Places,
  reprojecting: Semaphore.Semaphore,
): void =>
  void server.workspaceFolders.onDidChange(
    ({ added, removed }) =>
      void runtime.runFork(
        reprojecting.withPermits(1)(
          closeRemoved(server, services, projects, places, urisOf(removed)).pipe(
            Effect.andThen(openAdded(places, urisOf(added))),
          ),
        ),
      ),
  )

const placeFirst = (places: Places, workspace: string, loom: string): Effect.Effect<void> =>
  Cache.getSuccess(places, workspace).pipe(
    Effect.flatMap((kept) =>
      Option.exists(kept, Option.isNone)
        ? Cache.set(places, workspace, Option.some(loom))
        : Effect.void,
    ),
  )

const watchPlaces = (server: LanguageServer, home: string, places: Places): void =>
  void server.fileWatcher.onDidChangeWatchedFiles(({ changes }) =>
    runtime.runSync(
      WorkspaceSource.pipe(
        Effect.flatMap((source) =>
          Effect.forEach(
            changes
              .filter((change) => change.type === FileChangeType.Created)
              .map((change) => URI.parse(change.uri))
              .filter(isLoom),
            (uri) => placeFirst(places, workspaceFor(source, home, uri), source.locationOf(uri)),
            { discard: true },
          ),
        ),
      ),
    ),
  )

export const startLanguageServer = (): void => {
  const connection = createConnection()
  const server = createServer(connection)

  connection.onInitialize(async (params) => {
    const workspaces = await runtime.runPromise(servedWorkspaces(params))
    const home = Array.headNonEmpty(workspaces)
    const { places, opened, services, projects, plugins, reprojecting, edited } =
      await runtime.runPromise(
        Effect.gen(function* () {
          const places = yield* Cache.makeWith(openedPlace, {
            capacity: Infinity,
            timeToLive: lifetimeOf,
          })
          const homePlace = yield* Cache.get(places, home)
          const otherPlaces = yield* Effect.forEach(Array.tailNonEmpty(workspaces), (workspace) =>
            placeOpened(places, workspace),
          )
          const opened = [homePlace, ...otherPlaces]
          const sdk = yield* typescriptSdkFor(params.initializationOptions)
          const services = yield* Cache.make({
            capacity: Infinity,
            lookup: (workspace: string) => loomServicePlugins(runtime, sdk, workspace),
          })
          const projects = yield* Cache.make({
            capacity: Infinity,
            lookup: (workspace: string) =>
              placeOpened(places, workspace).pipe(
                Effect.andThen(Cache.get(services, workspace)),
                Effect.flatMap((plugins) => Effect.sync(() => projectOver(server, plugins))),
              ),
          })
          const plugins = yield* Cache.get(services, home)
          const reprojecting = yield* Semaphore.make(1)
          const edited = yield* Ref.make<ReadonlySet<string>>(new Set())
          return { places, opened, services, projects, plugins, reprojecting, edited }
        }).pipe(Effect.mapError(inWords)),
      )
    warmInTurn(opened)
    watchFolders(server, services, projects, places, reprojecting)
    watchPlaces(server, home, places)
    connection.onRequest(contentsRequest, (asked: unknown) =>
      runtime.runPromise(
        reprojecting.withPermits(1)(contentsFor(places, home, asked)).pipe(Effect.mapError(inWords)),
      ),
    )
    const answered = <A, E extends LoomFailure>(
      asking: Effect.Effect<A, E, LoomCompiler | DocumentSource | WorkspaceSource>,
    ): Promise<A> =>
      runtime.runPromise(
        reprojecting
          .withPermits(1)(
            settleEdits(server, home, projects, places, edited).pipe(Effect.andThen(asking)),
          )
          .pipe(Effect.mapError(refusalOf)),
      )
    connection.onRequest(outlineRequest, (asked: unknown) =>
      answered(outlineFor(places, home, asked)),
    )
    connection.onRequest(conceptsRequest, (asked: unknown) =>
      answered(conceptsFor(places, home, asked)),
    )
    connection.onRequest(typesRequest, (asked: unknown) => answered(typesFor(places, home, asked)))
    connection.onRequest(editRequest, (asked: unknown) => answered(editFor(places, home, asked)))
    return server.initialize(
      params,
      workspaceProject(server, home, services, projects, places, reprojecting, edited),
      [...plugins],
    )
  })
  connection.onInitialized(() => server.initialized())
  connection.onShutdown(server.shutdown)
  connection.listen()
}
