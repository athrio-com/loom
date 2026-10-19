import { Context, Effect, Layer, Option, Schema } from 'effect'
import { parse as parseYaml, parseDocument, stringify as stringifyYaml } from 'yaml'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, resolve as resolvePath } from 'node:path'

const AnchorSchema = Schema.Struct({
  open: Schema.optional(Schema.String),
  close: Schema.optional(Schema.String),
})

const LanguageSchema = Schema.Struct({
  service: Schema.optional(Schema.String),
})

const SettingsSchema = Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Unknown))

const VariablesSchema = Schema.Record(
  Schema.String,
  Schema.Union([Schema.String, Schema.Number, Schema.Boolean]),
)

export const WorkspaceManifestSchema = Schema.Struct({
  languages: Schema.optional(Schema.Record(Schema.String, LanguageSchema)),
  corpus: Schema.optional(Schema.String),
  primary: Schema.optional(Schema.String),
  anchor: Schema.optional(AnchorSchema),
  settings: Schema.optional(SettingsSchema),
  variables: Schema.optional(VariablesSchema),
  ignore: Schema.optional(Schema.Array(Schema.String)),
  width: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
})

export type WorkspaceManifest = typeof WorkspaceManifestSchema.Type

export interface ResolvedConfig {
  readonly anchor: { readonly open?: string; readonly close?: string } | undefined
  readonly primary: string | undefined
  readonly languages: ReadonlyArray<string>
  readonly settings: Record<string, Record<string, unknown>>
  readonly variables: Record<string, string>
  readonly ignore?: ReadonlyArray<string>
  readonly width: number
  readonly services: Record<string, string>
  readonly packageRoot: string | undefined
  readonly workspaceRoot: string | undefined
  readonly corpusDir: string | undefined
}

export const defaultWidth = 100

const empty: ResolvedConfig = {
  anchor: undefined,
  primary: undefined,
  languages: [],
  settings: {},
  variables: {},
  width: defaultWidth,
  services: {},
  packageRoot: undefined,
  workspaceRoot: undefined,
  corpusDir: undefined,
}

const storeDirName = '.loom'
const manifestName = 'config.yaml'
const defaultCorpus = 'corpus'

const findWorkspace = (dir: string): string | undefined => {
  if (existsSync(resolvePath(dir, storeDirName))) return dir
  const parent = dirname(dir)
  return parent === dir ? undefined : findWorkspace(parent)
}

const decodeManifest = Schema.decodeUnknownOption(WorkspaceManifestSchema)

const readManifest = (file: string): WorkspaceManifest | undefined => {
  try {
    return Option.getOrUndefined(decodeManifest(parseYaml(readFileSync(file, 'utf8'))))
  } catch {
    return undefined
  }
}

const serviceFor = (id: string, language: { readonly service?: string }): string =>
  language.service ?? `@athrio/loom-service-${id}`

const servicesOf = (
  languages: Record<string, { readonly service?: string }> | undefined,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(languages ?? {}).map(([id, language]) => [id, serviceFor(id, language)]),
  )

const variablesOf = (
  variables: Record<string, string | number | boolean> | undefined,
): Record<string, string> =>
  Object.fromEntries(Object.entries(variables ?? {}).map(([name, value]) => [name, String(value)]))

const containerRoot = (dir: string, container: string, workspace: string): string | undefined => {
  if (basename(dir) === container) return dirname(dir)
  const parent = dirname(dir)
  return dir === workspace || parent === dir
    ? undefined
    : containerRoot(parent, container, workspace)
}

const corpusDirOf = (start: string, container: string, workspace: string): string => {
  const climb = (dir: string): string => {
    if (basename(dir) === container) return dir
    const parent = dirname(dir)
    return dir === workspace || parent === dir ? start : climb(parent)
  }
  return climb(start)
}

const resolveFromManifest = (
  manifest: WorkspaceManifest,
  workspace: string,
  from: string,
): ResolvedConfig => {
  const container = manifest.corpus ?? defaultCorpus
  return {
    anchor: manifest.anchor,
    primary: manifest.primary,
    languages: Object.keys(manifest.languages ?? {}),
    settings: manifest.settings ?? {},
    variables: variablesOf(manifest.variables),
    ignore: manifest.ignore,
    width: manifest.width ?? defaultWidth,
    services: servicesOf(manifest.languages),
    packageRoot: containerRoot(from, container, workspace),
    workspaceRoot: workspace,
    corpusDir: corpusDirOf(from, container, workspace),
  }
}

const isFolder = (path: string): boolean =>
  statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false

export class LoomConfig extends Context.Service<LoomConfig>()('LoomConfig', {
  make: Effect.succeed({
    resolve: (fromPath: string): Effect.Effect<ResolvedConfig> =>
      Effect.sync(() => {
        if (fromPath === '') return empty
        const from = isFolder(fromPath) ? fromPath : dirname(fromPath)
        const workspace = findWorkspace(from)
        if (workspace === undefined) return empty
        const manifest = readManifest(resolvePath(workspace, storeDirName, manifestName))
        return manifest === undefined ? empty : resolveFromManifest(manifest, workspace, from)
      }),

    manifest: (fromDir: string): Effect.Effect<WorkspaceManifest | undefined> =>
      Effect.sync(() => {
        const workspace = findWorkspace(fromDir)
        return workspace === undefined
          ? undefined
          : readManifest(resolvePath(workspace, storeDirName, manifestName))
      }),

    materialize: (workspace: string, manifest: WorkspaceManifest): Effect.Effect<void> =>
      Effect.sync(() => {
        const store = resolvePath(workspace, storeDirName)
        mkdirSync(store, { recursive: true })
        writeFileSync(resolvePath(store, manifestName), stringifyYaml(manifest))
      }),

    edit: (workspace: string, path: ReadonlyArray<string>, value: unknown): Effect.Effect<void> =>
      Effect.sync(() => {
        const store = resolvePath(workspace, storeDirName)
        const file = resolvePath(store, manifestName)
        mkdirSync(store, { recursive: true })
        const document = parseDocument(existsSync(file) ? readFileSync(file, 'utf8') : '')
        document.setIn(path, value)
        writeFileSync(file, document.toString())
      }),
  }),
}) {
  static readonly layer = Layer.effect(this, this.make)
}
