import { Context, Effect, Layer, Option } from 'effect'
import { readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve as resolvePath } from 'node:path'
import { URI } from 'vscode-uri'
import {
  containerRoot,
  defaultCorpus,
  findWorkspace,
  LoomConfig,
  type WorkspaceManifest,
} from '@athrio/loom-config/LoomConfig'
import { type Path } from '@athrio/loom-ast/LoomCorpusAst'
import { ReadError } from '#ast/LoomCorpusAstBuilder'
import { type BuildSettings, PackageConfig } from './PackageConfig'
import { holds, loomsIn, projectIn } from './LoomProject'

export type Location = Path

export interface Workspace {
  readonly location: Location
  readonly manifest: Option.Option<WorkspaceManifest>
  readonly looms: ReadonlyMap<Location, string>
}

export interface WorkspaceSourceApi {
  readonly open: (workspace: Location) => Effect.Effect<Workspace, ReadError>
  readonly read: (loom: Location) => Effect.Effect<string, ReadError>
  readonly corpusOf: (loom: Location) => Effect.Effect<ReadonlyArray<Location>>
  readonly workspaceOf: (loom: Location) => Location
  readonly placeOf: (workspace: Workspace, loom: Location, sink: string) => string
  readonly locationOf: (uri: URI) => Location
  readonly uriOf: (loom: Location) => URI
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

const corpusWalk = (settings: BuildSettings, loom: Location): ReadonlyArray<Location> =>
  Option.match(
    Option.filter(projectIn(settings), (project) => holds(project, loom)),
    {
      onNone: () => loomsIn(dirname(loom), Option.none()),
      onSome: (project) =>
        loomsIn(
          Option.getOrElse(Option.fromNullishOr(settings.corpusDir), () => dirname(loom)),
          Option.some(project),
        ),
    },
  )

export const outputPath = (packageRoot: Option.Option<string>, entry: Path, sink: string): Path =>
  Option.match(packageRoot, {
    onNone: () => resolvePath(dirname(entry), sink),
    onSome: (root) => resolvePath(root, sink),
  })

const packageRootOf = (workspace: Workspace, loom: Location): Option.Option<string> =>
  Option.flatMap(workspace.manifest, (m) =>
    Option.fromNullishOr(containerRoot(dirname(loom), m.corpus ?? defaultCorpus, workspace.location)),
  )

const locationOfUri = (uri: URI): Location => (uri.scheme === 'file' ? uri.fsPath : uri.toString())

const uriOfLocation = (loom: Location): URI => (isAbsolute(loom) ? URI.file(loom) : URI.parse(loom))

export const FileSystemSource = Layer.effect(
  WorkspaceSource,
  Effect.gen(function* () {
    const config = yield* LoomConfig
    const packages = yield* PackageConfig
    const open = (workspace: Location): Effect.Effect<Workspace, ReadError> =>
      Effect.gen(function* () {
        const manifest = Option.fromNullishOr(yield* config.manifest(workspace))
        const settings = yield* packages.resolve(workspace)
        const paths = yield* Effect.sync(() =>
          loomsIn(corpusFolderOf(workspace, manifest), projectIn(settings)),
        )
        const looms = yield* Effect.forEach(paths, (loom) =>
          fromDisk(loom).pipe(Effect.map((text) => [loom, text] as const)),
        )
        return { location: workspace, manifest, looms: new Map(looms) }
      })
    const source: WorkspaceSourceApi = {
      open,
      read: fromDisk,
      corpusOf: (loom) =>
        packages
          .resolve(loom)
          .pipe(Effect.flatMap((settings) => Effect.sync(() => corpusWalk(settings, loom)))),
      workspaceOf: (loom) =>
        Option.getOrElse(Option.fromNullishOr(findWorkspace(dirname(loom))), () => dirname(loom)),
      placeOf: (workspace, loom, sink) => outputPath(packageRootOf(workspace, loom), loom, sink),
      locationOf: locationOfUri,
      uriOf: uriOfLocation,
    }
    return source
  }),
).pipe(Layer.provide(PackageConfig.layer), Layer.provide(LoomConfig.layer))
