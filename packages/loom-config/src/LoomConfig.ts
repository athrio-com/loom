import { Effect, Option, Schema } from 'effect'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, resolve as resolvePath } from 'node:path'

const AnchorSchema = Schema.Struct({
  open: Schema.optional(Schema.String),
  close: Schema.optional(Schema.String),
})

const LanguageSchema = Schema.Struct({
  service: Schema.optional(Schema.String),
})

const SettingsSchema = Schema.Record({
  key: Schema.String,
  value: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
})

export const WorkspaceConfigSchema = Schema.Struct({
  languages: Schema.Record({ key: Schema.String, value: LanguageSchema }),
  corpus: Schema.optional(Schema.String),
  primary: Schema.optional(Schema.String),
  anchor: Schema.optional(AnchorSchema),
  settings: Schema.optional(SettingsSchema),
})

export type WorkspaceConfig = typeof WorkspaceConfigSchema.Type

const decodeConfig = Schema.decodeUnknownOption(WorkspaceConfigSchema)

export const parseConfig = (text: string): WorkspaceConfig | undefined => {
  try {
    return Option.getOrUndefined(decodeConfig(parseYaml(text)))
  } catch {
    return undefined
  }
}

export const WorkspaceManifestSchema = Schema.Struct({
  languages: Schema.optional(
    Schema.Record({ key: Schema.String, value: LanguageSchema }),
  ),
  corpus: Schema.optional(Schema.String),
  primary: Schema.optional(Schema.String),
  anchor: Schema.optional(AnchorSchema),
  settings: Schema.optional(SettingsSchema),
})

export type WorkspaceManifest = typeof WorkspaceManifestSchema.Type

export interface ResolvedConfig {
  readonly anchor: { readonly open?: string; readonly close?: string } | undefined
  readonly primary: string | undefined
  readonly languages: ReadonlyArray<string>
  readonly settings: Record<string, Record<string, unknown>>
  readonly services: Record<string, string>
  readonly packageRoot: string | undefined
  readonly workspaceRoot: string | undefined
}

const empty: ResolvedConfig = {
  anchor: undefined,
  primary: undefined,
  languages: [],
  settings: {},
  services: {},
  packageRoot: undefined,
  workspaceRoot: undefined,
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

const containerRoot = (
  dir: string,
  container: string,
  workspace: string,
): string | undefined => {
  if (basename(dir) === container) return dirname(dir)
  const parent = dirname(dir)
  return dir === workspace || parent === dir
    ? undefined
    : containerRoot(parent, container, workspace)
}

const resolveFromManifest = (
  manifest: WorkspaceManifest,
  workspace: string,
  fromPath: string,
): ResolvedConfig => {
  const container = manifest.corpus ?? defaultCorpus
  return {
    anchor: manifest.anchor,
    primary: manifest.primary,
    languages: Object.keys(manifest.languages ?? {}),
    settings: manifest.settings ?? {},
    services: servicesOf(manifest.languages),
    packageRoot: containerRoot(dirname(fromPath), container, workspace),
    workspaceRoot: workspace,
  }
}

export class LoomConfig extends Effect.Service<LoomConfig>()('LoomConfig', {
  succeed: {
    resolve: (fromPath: string): Effect.Effect<ResolvedConfig> =>
      Effect.sync(() => {
        if (fromPath === '') return empty
        const workspace = findWorkspace(dirname(fromPath))
        if (workspace === undefined) return empty
        const manifest = readManifest(
          resolvePath(workspace, storeDirName, manifestName),
        )
        return manifest === undefined
          ? empty
          : resolveFromManifest(manifest, workspace, fromPath)
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
  },
}) {}
