import {
  Array,
  Config,
  Context,
  Data,
  Effect,
  Equal,
  Layer,
  Option,
  pipe,
  Redacted,
  Ref,
  Schema,
} from 'effect'
import { FetchHttpClient, HttpClient, HttpClientRequest } from 'effect/http'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve as resolvePath } from 'node:path'
import { URI } from 'vscode-uri'
import {
  defaultCorpus,
  findWorkspace,
  LoomConfig,
  type ResolvedConfig,
  type WorkspaceManifest,
  WorkspaceManifestSchema,
} from '@athrio/loom-config/LoomConfig'
import { type Location } from '@athrio/loom-ast/LoomCorpusAst'
import { ReadError } from '#ast/LoomCorpusAstBuilder'
import { type KeptRelation, KeptRelationSchema } from '#ast/Relations'
import {
  holdsOf,
  loomsIn,
  projectIn,
  walkIn,
  type LoomProject,
  type Path,
  type Reading,
} from './LoomProject'
import { LoomDiskCache } from './LoomDiskCache'
import {
  FileSystemSettings,
  settingsOfManifest,
  WorkspaceSettings,
  type WorkspaceSettingsApi,
} from './WorkspaceSettings'

export interface Workspace {
  readonly location: Location
  readonly manifest: Option.Option<WorkspaceManifest>
  readonly looms: ReadonlyMap<Location, string>
  readonly relations: ReadonlyArray<KeptRelation>
}

export class RelationsNotKept extends Data.TaggedError('RelationsNotKept')<{
  readonly workspace: Location
  readonly cause: unknown
}> {}

export class StorageTakesNoWrite extends Data.TaggedError('StorageTakesNoWrite')<{
  readonly workspace: Location
}> {}

export interface KeptFile {
  readonly file: Location
  readonly text: string
}

export type PlaceOf = (loom: Location, sink: string) => Location

export interface WorkspaceSourceApi {
  readonly open: (workspace: Location) => Effect.Effect<Workspace, ReadError>
  readonly read: (loom: Location) => Effect.Effect<string, ReadError>
  readonly corpusOf: (loom: Location) => Effect.Effect<ReadonlyArray<Location>>
  readonly workspaceOf: (loom: Location) => Location
  readonly placesOf: (looms: ReadonlyArray<Location>) => Effect.Effect<PlaceOf>
  readonly locationOf: (uri: URI) => Location
  readonly uriOf: (loom: Location) => URI
  readonly relist: (loom: Location, held: boolean) => Effect.Effect<void>
  readonly close: (workspace: Location) => Effect.Effect<void>
  readonly keptRelationsOf: (loom: Location) => Effect.Effect<ReadonlyArray<KeptRelation>>
  readonly keepRelations: (
    loom: Location,
    relations: ReadonlyArray<KeptRelation>,
  ) => Effect.Effect<void, RelationsNotKept | StorageTakesNoWrite>
  readonly relationsFileOf: (
    loom: Location,
    relations: ReadonlyArray<KeptRelation>,
  ) => Option.Option<KeptFile>
}

export class WorkspaceSource extends Context.Service<WorkspaceSource>()('WorkspaceSource', {
  make: Effect.die('WorkspaceSource must be provided by an environment') as Effect.Effect<WorkspaceSourceApi>,
}) {
  static readonly layer = Layer.effect(this, this.make)
}

export const fromDisk = (path: Path): Effect.Effect<string, ReadError> =>
  Effect.try({
    try: () => readFileSync(path, 'utf8'),
    catch: (cause) => new ReadError({ path, cause }),
  })

const corpusFolderOf = (workspace: Location, manifest: WorkspaceManifest): Location =>
  join(workspace, manifest.corpus ?? defaultCorpus)

interface KeptReading<Answer> {
  readonly answer: Answer
  readonly times: ReadonlyArray<readonly [Path, Option.Option<number>]>
}

type KeptReadings<Answer> = Ref.Ref<ReadonlyMap<string, KeptReading<Answer>>>

const timeOf = (path: Path): Option.Option<number> =>
  pipe(
    Option.liftThrowable(() => statSync(path, { throwIfNoEntry: false }))(),
    Option.flatMap(Option.fromNullishOr),
    Option.map((stats) => stats.mtimeMs),
  )

const stands = <Answer,>(kept: KeptReading<Answer>): boolean =>
  kept.times.every(([path, time]) => Equal.equals(timeOf(path), time))

const tickOf = (time: number): number => (time % 1000 === 0 ? 2000 : 50)

const settled = (time: Option.Option<number>, taken: number): boolean =>
  Option.match(time, { onNone: () => true, onSome: (at) => at + tickOf(at) <= taken })

const keptOf = <Answer>(
  reading: Reading<Answer>,
  taken: number,
): Option.Option<KeptReading<Answer>> => {
  const times = reading.from.map((path) => [path, timeOf(path)] as const)
  return times.every(([, time]) => settled(time, taken))
    ? Option.some({ answer: reading.answer, times })
    : Option.none()
}

const answeredAfresh = <Answer>(
  kept: KeptReadings<Answer>,
  key: string,
  read: () => Reading<Answer>,
): Effect.Effect<Answer> =>
  Effect.sync(() => {
    const taken = Date.now()
    const reading = read()
    return { answer: reading.answer, fresh: keptOf(reading, taken) }
  }).pipe(
    Effect.tap(({ fresh }) =>
      Option.match(fresh, {
        onNone: () => Effect.void,
        onSome: (reading) => Ref.update(kept, (held) => new Map(held).set(key, reading)),
      }),
    ),
    Effect.map(({ answer }) => answer),
  )

const answered = <Answer>(
  kept: KeptReadings<Answer>,
  key: string,
  read: () => Reading<Answer>,
): Effect.Effect<Answer> =>
  Ref.get(kept).pipe(
    Effect.flatMap((held) =>
      Effect.sync(() => Option.filter(Option.fromNullishOr(held.get(key)), stands)),
    ),
    Effect.flatMap(
      Option.match({
        onSome: (reading) => Effect.succeed(reading.answer),
        onNone: () => answeredAfresh(kept, key, read),
      }),
    ),
  )

interface KeptAnswers {
  readonly walks: KeptReadings<ReadonlyArray<Location>>
  readonly holds: KeptReadings<(loom: Path) => boolean>
}

const keyOf = (path: Path, project: Option.Option<LoomProject>): string =>
  JSON.stringify([path, Option.getOrNull(project)])

const holderOf = (
  kept: KeptAnswers,
  resolved: ResolvedConfig,
  loom: Location,
): Effect.Effect<Option.Option<LoomProject>> =>
  Option.match(projectIn(resolved), {
    onNone: () => Effect.succeed(Option.none()),
    onSome: (project) =>
      answered(kept.holds, keyOf(project.root, Option.some(project)), () => holdsOf(project)).pipe(
        Effect.flatMap((holds) =>
          Effect.sync(() => (holds(loom) ? Option.some(project) : Option.none())),
        ),
      ),
  })

const corpusWalk = (
  kept: KeptAnswers,
  resolved: ResolvedConfig,
  loom: Location,
): Effect.Effect<ReadonlyArray<Location>> =>
  holderOf(kept, resolved, loom).pipe(
    Effect.flatMap((holder) => {
      const folder = Option.match(holder, {
        onNone: () => dirname(loom),
        onSome: () => Option.getOrElse(Option.fromNullishOr(resolved.corpusDir), () => dirname(loom)),
      })
      return answered(kept.walks, keyOf(folder, holder), () => walkIn(folder, holder))
    }),
  )

export const outputPath = (packageRoot: Option.Option<string>, entry: Path, sink: string): Path =>
  Option.match(packageRoot, {
    onNone: () => resolvePath(dirname(entry), sink),
    onSome: (root) => resolvePath(root, sink),
  })

const packageRoots = (
  config: LoomConfig['Service'],
  looms: ReadonlyArray<Location>,
): Effect.Effect<ReadonlyMap<string, Option.Option<string>>> =>
  Effect.forEach(
    Array.fromIterable(new Map(looms.map((loom) => [dirname(loom), loom] as const))),
    ([folder, loom]) =>
      config
        .resolve(loom)
        .pipe(Effect.map(({ packageRoot }) => [folder, Option.fromNullishOr(packageRoot)] as const)),
  ).pipe(Effect.map((roots) => new Map(roots)))

const folderOf = (location: Path): Path =>
  statSync(location, { throwIfNoEntry: false })?.isDirectory() === true
    ? location
    : dirname(location)

const locationOfUri = (uri: URI): Location => (uri.scheme === 'file' ? uri.fsPath : uri.toString())

const uriOfLocation = (loom: Location): URI => (isAbsolute(loom) ? URI.file(loom) : URI.parse(loom))

export const FileSystemSource = Layer.effect(
  WorkspaceSource,
  Effect.gen(function* () {
    const config = yield* LoomConfig
    const kept: KeptAnswers = {
      walks: yield* Ref.make<ReadonlyMap<string, KeptReading<ReadonlyArray<Location>>>>(new Map()),
      holds: yield* Ref.make<ReadonlyMap<string, KeptReading<(loom: Path) => boolean>>>(new Map()),
    }
    const loomsOf = (
      workspace: Location,
      manifest: Option.Option<WorkspaceManifest>,
    ): Effect.Effect<ReadonlyMap<Location, string>> =>
      Option.match(manifest, {
        onNone: () => Effect.succeed(new Map<Location, string>()),
        onSome: (found) =>
          config.resolve(workspace).pipe(
            Effect.flatMap((resolved) =>
              Effect.sync(() => loomsIn(corpusFolderOf(workspace, found), projectIn(resolved))),
            ),
            Effect.flatMap((paths) =>
              Effect.forEach(paths, (loom) =>
                Effect.option(fromDisk(loom).pipe(Effect.map((text) => [loom, text] as const))),
              ),
            ),
            Effect.map((read) => new Map(Array.getSomes(read))),
          ),
      })
    const open = (workspace: Location): Effect.Effect<Workspace, ReadError> =>
      Effect.gen(function* () {
        const manifest = Option.fromNullishOr(yield* config.manifest(workspace))
        return {
          location: workspace,
          manifest,
          looms: yield* loomsOf(workspace, manifest),
          relations: yield* relationsIn(workspace),
        }
      })
    const workspaceOf = (location: Location): Location =>
      isAbsolute(location)
        ? Option.getOrElse(Option.fromNullishOr(findWorkspace(folderOf(location))), () =>
            folderOf(location),
          )
        : location
    const source: WorkspaceSourceApi = {
      open,
      read: fromDisk,
      corpusOf: (loom) =>
        config.resolve(loom).pipe(Effect.flatMap((resolved) => corpusWalk(kept, resolved, loom))),
      workspaceOf,
      placesOf: (looms) =>
        packageRoots(config, looms).pipe(
          Effect.map(
            (roots): PlaceOf =>
              (loom, sink) =>
                outputPath(
                  Option.flatten(Option.fromNullishOr(roots.get(dirname(loom)))),
                  loom,
                  sink,
                ),
          ),
        ),
      locationOf: locationOfUri,
      uriOf: uriOfLocation,
      relist: () => Effect.void,
      close: () => Effect.void,
      keptRelationsOf: (loom) => relationsIn(workspaceOf(loom)),
      keepRelations: (loom, relations) => keepIn(workspaceOf(loom), relations),
      relationsFileOf: (loom, relations) => Option.some(keptFile(workspaceOf(loom), relations)),
    }
    return source
  }),
).pipe(Layer.provide(LoomConfig.layer))

const RelationsFile = Schema.Struct({
  version: Schema.Number,
  relations: Schema.Array(KeptRelationSchema),
})

const relationsPath = (workspace: Location): Path => join(workspace, '.loom', 'relations.lock')

const relationsIn = (workspace: Location): Effect.Effect<ReadonlyArray<KeptRelation>> =>
  fromDisk(relationsPath(workspace)).pipe(
    Effect.flatMap((text) =>
      Effect.try({ try: () => JSON.parse(text) as unknown, catch: (cause) => cause }),
    ),
    Effect.flatMap(Schema.decodeUnknownEffect(RelationsFile)),
    Effect.map((file) =>
      file.relations.map((relation) => ({
        ...relation,
        loom: join(workspace, relation.loom),
      })),
    ),
    Effect.orElseSucceed((): ReadonlyArray<KeptRelation> => []),
  )

const relationsText = (workspace: Location, relations: ReadonlyArray<KeptRelation>): string => {
  const rows = relations.map(
    (relation) =>
      `    ${JSON.stringify({ ...relation, loom: relative(workspace, relation.loom) })}`,
  )
  return `{\n  "version": 1,\n  "relations": [\n${rows.join(',\n')}\n  ]\n}\n`
}

const keptFile = (workspace: Location, relations: ReadonlyArray<KeptRelation>): KeptFile => ({
  file: relationsPath(workspace),
  text: relationsText(workspace, relations),
})

const keepIn = (
  workspace: Location,
  relations: ReadonlyArray<KeptRelation>,
): Effect.Effect<void, RelationsNotKept> =>
  Effect.try({
    try: () => {
      const kept = keptFile(workspace, relations)
      mkdirSync(join(workspace, '.loom'), { recursive: true })
      writeFileSync(kept.file, kept.text)
    },
    catch: (cause) => new RelationsNotKept({ workspace, cause }),
  })

export const WorkspaceJson = Schema.Struct({
  contract: Schema.Number,
  manifest: Schema.optional(WorkspaceManifestSchema),
  looms: Schema.Record(Schema.String, Schema.String),
  relations: Schema.optional(Schema.Array(KeptRelationSchema)),
})

const fetchText = (
  client: HttpClient.HttpClient,
  key: Redacted.Redacted<string>,
  url: string,
): Effect.Effect<string, ReadError> =>
  HttpClient.filterStatusOk(client)
    .execute(HttpClientRequest.get(url).pipe(HttpClientRequest.bearerToken(key)))
    .pipe(
      Effect.flatMap((response) => response.text),
      Effect.mapError((cause) => new ReadError({ path: url, cause })),
    )

const workspaceFrom = (url: string, text: string): Effect.Effect<Workspace, ReadError> =>
  Effect.try({
    try: () => JSON.parse(text) as unknown,
    catch: (cause) => new ReadError({ path: url, cause }),
  }).pipe(
    Effect.flatMap((json) =>
      Schema.decodeUnknownEffect(WorkspaceJson)(json).pipe(
        Effect.mapError((cause) => new ReadError({ path: url, cause })),
      ),
    ),
    Effect.map((decoded) => ({
      location: url,
      manifest: Option.fromNullishOr(decoded.manifest),
      looms: new Map(Object.entries(decoded.looms)),
      relations: decoded.relations ?? [],
    })),
  )

const firstStepBeneath = (storage: string, location: Location): Option.Option<string> =>
  location.startsWith(`${storage}/`)
    ? Option.filter(
        Array.head(location.slice(storage.length + 1).split('/')),
        (step) => step !== '',
      )
    : Option.none()

const workspaceBeneath = (storage: string, location: Location): Location =>
  Option.match(firstStepBeneath(storage, location), {
    onNone: () => location,
    onSome: (step) => `${storage}/${step}`,
  })

export interface OpenedWorkspace {
  readonly looms: ReadonlyArray<Location>
  readonly relations: ReadonlyArray<KeptRelation>
  readonly manifest: Option.Option<WorkspaceManifest>
}

export class RemoteWorkspaces extends Context.Service<RemoteWorkspaces>()('RemoteWorkspaces', {
  make: Effect.gen(function* () {
    const opened = yield* Ref.make<ReadonlyMap<Location, OpenedWorkspace>>(new Map())
    return {
      keptOf: (workspace: Location): Effect.Effect<Option.Option<OpenedWorkspace>> =>
        Ref.get(opened).pipe(Effect.map((all) => Option.fromNullishOr(all.get(workspace)))),
      keep: (workspace: Location, kept: OpenedWorkspace): Effect.Effect<void> =>
        Ref.update(opened, (all) => new Map(all).set(workspace, kept)),
      update: (
        workspace: Location,
        change: (kept: OpenedWorkspace) => OpenedWorkspace,
      ): Effect.Effect<void> =>
        Ref.update(opened, (all) =>
          Option.match(Option.fromNullishOr(all.get(workspace)), {
            onNone: () => all,
            onSome: (kept) => new Map(all).set(workspace, change(kept)),
          }),
        ),
      forget: (workspace: Location): Effect.Effect<void> =>
        Ref.update(opened, (all) => new Map([...all].filter(([key]) => key !== workspace))),
    }
  }),
}) {
  static readonly layer = Layer.effect(this, this.make)
}

const relisted = (
  looms: ReadonlyArray<Location>,
  loom: Location,
  held: boolean,
): ReadonlyArray<Location> =>
  held ? Array.dedupe([...looms, loom]) : looms.filter((listed) => listed !== loom)

export const RemoteSource = (
  address: StorageAddress,
): Layer.Layer<WorkspaceSource, never, RemoteWorkspaces> =>
  Layer.effect(
    WorkspaceSource,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const workspaces = yield* RemoteWorkspaces
      const storage = address.url.replace(/\/+$/, '')
      const workspaceOf = (location: Location): Location => workspaceBeneath(storage, location)
      const keptOf = (loom: Location): Effect.Effect<Option.Option<OpenedWorkspace>> =>
        workspaces.keptOf(workspaceOf(loom))
      const read = (loom: Location): Effect.Effect<string, ReadError> =>
        fetchText(client, address.key, loom)
      const source: WorkspaceSourceApi = {
        open: (workspace) =>
          read(workspace).pipe(
            Effect.flatMap((text) => workspaceFrom(workspace, text)),
            Effect.tap((opened) =>
              workspaces.keep(workspaceOf(workspace), {
                looms: Array.fromIterable(opened.looms.keys()),
                relations: opened.relations,
                manifest: opened.manifest,
              }),
            ),
          ),
        read,
        corpusOf: (loom) =>
          keptOf(loom).pipe(
            Effect.map(
              Option.match({
                onNone: (): ReadonlyArray<Location> => [],
                onSome: (kept) => kept.looms,
              }),
            ),
          ),
        workspaceOf,
        placesOf: () => Effect.succeed((_loom, sink) => sink),
        locationOf: (uri) => uri.toString(),
        uriOf: (loom) => URI.parse(loom),
        relist: (loom, held) =>
          workspaces.update(workspaceOf(loom), (kept) => ({
            ...kept,
            looms: relisted(kept.looms, loom, held),
          })),
        close: (workspace) => workspaces.forget(workspaceOf(workspace)),
        keptRelationsOf: (loom) =>
          keptOf(loom).pipe(
            Effect.map(
              Option.match({
                onNone: (): ReadonlyArray<KeptRelation> => [],
                onSome: (kept) => kept.relations,
              }),
            ),
          ),
        keepRelations: (loom) =>
          Effect.fail(new StorageTakesNoWrite({ workspace: workspaceOf(loom) })),
        relationsFileOf: () => Option.none(),
      }
      return source
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer))

export const RemoteSettings: Layer.Layer<
  WorkspaceSettings,
  never,
  WorkspaceSource | RemoteWorkspaces
> = Layer.effect(
  WorkspaceSettings,
  Effect.gen(function* () {
    const source = yield* WorkspaceSource
    const workspaces = yield* RemoteWorkspaces
    const settings: WorkspaceSettingsApi = {
      resolve: (loom) =>
        workspaces
          .keptOf(source.workspaceOf(loom))
          .pipe(
            Effect.map((kept) =>
              settingsOfManifest(Option.flatMap(kept, (opened) => opened.manifest)),
            ),
          ),
      manifest: (workspace) =>
        workspaces.keptOf(source.workspaceOf(workspace)).pipe(
          Effect.flatMap(
            Option.match({
              onSome: (kept) => Effect.succeed(kept.manifest),
              onNone: () => source.open(workspace).pipe(Effect.map((opened) => opened.manifest)),
            }),
          ),
        ),
    }
    return settings
  }),
)

export const RemoteEnvironment = (
  address: StorageAddress,
): Layer.Layer<WorkspaceSource | WorkspaceSettings | LoomDiskCache> =>
  Layer.mergeAll(
    RemoteSettings.pipe(Layer.provideMerge(RemoteSource(address))),
    LoomDiskCache.none,
  ).pipe(Layer.provide(RemoteWorkspaces.layer))

export interface StorageAddress {
  readonly url: string
  readonly key: Redacted.Redacted<string>
}

export const FileSystemEnvironment = Layer.mergeAll(
  FileSystemSource,
  FileSystemSettings,
  LoomDiskCache.layer,
)

export const Environment = Layer.unwrap(
  Config.option(Config.String('LOOM_STORAGE_URL')).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed(FileSystemEnvironment),
        onSome: (url) =>
          Config.Redacted('LOOM_STORAGE_KEY').pipe(
            Effect.map((key) => RemoteEnvironment({ url, key })),
          ),
      }),
    ),
  ),
)
