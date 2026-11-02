import { Context, Effect, Layer, Option } from 'effect'
import { dirname, isAbsolute, join } from 'node:path'
import { URI } from 'vscode-uri'
import {
  containerRoot,
  defaultCorpus,
  findWorkspace,
  LoomConfig,
  type WorkspaceManifest,
} from '@athrio/loom-config/LoomConfig'
import { type Path } from '@athrio/loom-ast/LoomCorpusAst'
import { type ReadError } from '#ast/LoomCorpusAstBuilder'
import { fromDisk, outputPath } from './LoomCompiler'
import { PackageConfig } from './PackageConfig'
import { loomsIn, projectIn } from './LoomProject'

export type Location = Path

export interface Workspace {
  readonly location: Location
  readonly manifest: Option.Option<WorkspaceManifest>
  readonly looms: ReadonlyMap<Location, string>
}

export interface WorkspaceSourceApi {
  readonly open: (workspace: Location) => Effect.Effect<Workspace, ReadError>
  readonly read: (loom: Location) => Effect.Effect<string, ReadError>
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

const corpusOf = (workspace: Location, manifest: Option.Option<WorkspaceManifest>): Location =>
  Option.match(manifest, {
    onNone: () => workspace,
    onSome: (m) => join(workspace, m.corpus ?? defaultCorpus),
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
          loomsIn(corpusOf(workspace, manifest), projectIn(settings)),
        )
        const looms = yield* Effect.forEach(paths, (loom) =>
          fromDisk(loom).pipe(Effect.map((text) => [loom, text] as const)),
        )
        return { location: workspace, manifest, looms: new Map(looms) }
      })
    const source: WorkspaceSourceApi = {
      open,
      read: fromDisk,
      workspaceOf: (loom) =>
        Option.getOrElse(Option.fromNullishOr(findWorkspace(dirname(loom))), () => dirname(loom)),
      placeOf: (workspace, loom, sink) => outputPath(packageRootOf(workspace, loom), loom, sink),
      locationOf: locationOfUri,
      uriOf: uriOfLocation,
    }
    return source
  }),
)
