import { Array, Config, Context, Data, Effect, Layer, Option, Redacted, Ref, Schema } from 'effect'
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
import { holds, loomsIn, projectIn, type Path } from './LoomProject'
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
}> {
  get message(): string {
    return `Cannot keep relations for ${this.workspace}: ${
      this.cause instanceof Error ? this.cause.message : String(this.cause)
    }`
  }
}

export interface KeptFile {
  readonly file: Location
  readonly text: string
}

export interface WorkspaceSourceApi {
  readonly open: (workspace: Location) => Effect.Effect<Workspace, ReadError>
  readonly read: (loom: Location) => Effect.Effect<string, ReadError>
  readonly corpusOf: (loom: Location) => Effect.Effect<ReadonlyArray<Location>>
  readonly workspaceOf: (loom: Location) => Location
  readonly placeOf: (loom: Location, sink: string) => Effect.Effect<Location>
  readonly locationOf: (uri: URI) => Location
  readonly uriOf: (loom: Location) => URI
  readonly keptRelationsOf: (loom: Location) => Effect.Effect<ReadonlyArray<KeptRelation>>
  readonly keepRelations: (
    loom: Location,
    relations: ReadonlyArray<KeptRelation>,
  ) => Effect.Effect<void, RelationsNotKept>
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

const corpusFolderOf = (workspace: Location, manifest: Option.Option<WorkspaceManifest>): Location =>
  Option.match(manifest, {
    onNone: () => workspace,
    onSome: (m) => join(workspace, m.corpus ?? defaultCorpus),
  })

const corpusWalk = (resolved: ResolvedConfig, loom: Location): ReadonlyArray<Location> =>
  Option.match(
    Option.filter(projectIn(resolved), (project) => holds(project, loom)),
    {
      onNone: () => loomsIn(dirname(loom), Option.none()),
      onSome: (project) =>
        loomsIn(
          Option.getOrElse(Option.fromNullishOr(resolved.corpusDir), () => dirname(loom)),
          Option.some(project),
        ),
    },
  )

export const outputPath = (packageRoot: Option.Option<string>, entry: Path, sink: string): Path =>
  Option.match(packageRoot, {
    onNone: () => resolvePath(dirname(entry), sink),
    onSome: (root) => resolvePath(root, sink),
  })

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
    const open = (workspace: Location): Effect.Effect<Workspace, ReadError> =>
      Effect.gen(function* () {
        const manifest = Option.fromNullishOr(yield* config.manifest(workspace))
        const resolved = yield* config.resolve(workspace)
        const paths = yield* Effect.sync(() =>
          loomsIn(corpusFolderOf(workspace, manifest), projectIn(resolved)),
        )
        const looms = yield* Effect.forEach(paths, (loom) =>
          fromDisk(loom).pipe(Effect.map((text) => [loom, text] as const)),
        )
        return {
          location: workspace,
          manifest,
          looms: new Map(looms),
          relations: yield* relationsIn(workspace),
        }
      })
    const workspaceOf = (location: Location): Location =>
      Option.getOrElse(Option.fromNullishOr(findWorkspace(folderOf(location))), () =>
        folderOf(location),
      )
    const source: WorkspaceSourceApi = {
      open,
      read: fromDisk,
      corpusOf: (loom) =>
        config
          .resolve(loom)
          .pipe(Effect.flatMap((resolved) => Effect.sync(() => corpusWalk(resolved, loom)))),
      workspaceOf,
      placeOf: (loom, sink) =>
        config
          .resolve(loom)
          .pipe(
            Effect.map(({ packageRoot }) =>
              outputPath(Option.fromNullishOr(packageRoot), loom, sink),
            ),
          ),
      locationOf: locationOfUri,
      uriOf: uriOfLocation,
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
      Array.map(file.relations, (relation) => ({
        ...relation,
        loom: join(workspace, relation.loom),
      })),
    ),
    Effect.orElseSucceed((): ReadonlyArray<KeptRelation> => []),
  )

const relationsText = (workspace: Location, relations: ReadonlyArray<KeptRelation>): string => {
  const rows = Array.map(
    relations,
    (relation) =>
      `    ${JSON.stringify({ ...relation, loom: relative(workspace, relation.loom) })}`,
  )
  return `{\n  "version": 1,\n  "relations": [\n${Array.join(rows, ',\n')}\n  ]\n}\n`
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

export const RemoteSource = (address: StorageAddress): Layer.Layer<WorkspaceSource> =>
  Layer.effect(
    WorkspaceSource,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const listed = yield* Ref.make<ReadonlyArray<Location>>([])
      const kept = yield* Ref.make<ReadonlyArray<KeptRelation>>([])
      const read = (loom: Location): Effect.Effect<string, ReadError> =>
        fetchText(client, address.key, loom)
      const source: WorkspaceSourceApi = {
        open: (workspace) =>
          read(workspace).pipe(
            Effect.flatMap((text) => workspaceFrom(workspace, text)),
            Effect.tap((opened) => Ref.set(listed, Array.fromIterable(opened.looms.keys()))),
            Effect.tap((opened) => Ref.set(kept, opened.relations)),
          ),
        read,
        corpusOf: () => Ref.get(listed),
        workspaceOf: () => address.url,
        placeOf: (_loom, sink) => Effect.succeed(sink),
        locationOf: (uri) => uri.toString(),
        uriOf: (loom) => URI.parse(loom),
        keptRelationsOf: () => Ref.get(kept),
        keepRelations: () =>
          Effect.fail(
            new RelationsNotKept({ workspace: address.url, cause: 'remote storage takes no write' }),
          ),
        relationsFileOf: () => Option.none(),
      }
      return source
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer))

export const RemoteSettings = Layer.effect(
  WorkspaceSettings,
  Effect.gen(function* () {
    const source = yield* WorkspaceSource
    const kept = yield* Ref.make(Option.none<WorkspaceManifest>())
    const settings: WorkspaceSettingsApi = {
      resolve: () => Ref.get(kept).pipe(Effect.map(settingsOfManifest)),
      manifest: (workspace) =>
        source.open(workspace).pipe(
          Effect.map((opened) => opened.manifest),
          Effect.tap((manifest) => Ref.set(kept, manifest)),
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
  )

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
