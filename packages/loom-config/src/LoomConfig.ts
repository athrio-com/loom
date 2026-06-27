import { Effect, Option, Schema } from 'effect'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { dirname, resolve as resolvePath, sep } from 'node:path'

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
  primary: Schema.optional(Schema.String),
  anchor: Schema.optional(AnchorSchema),
  settings: Schema.optional(SettingsSchema),
})

export const PackageConfigSchema = Schema.Struct({
  package: Schema.String,
  primary: Schema.optional(Schema.String),
  anchor: Schema.optional(AnchorSchema),
  settings: Schema.optional(SettingsSchema),
})

export const ConfigSchema = Schema.Union(WorkspaceConfigSchema, PackageConfigSchema)

export type WorkspaceConfig = typeof WorkspaceConfigSchema.Type
export type PackageConfig = typeof PackageConfigSchema.Type
export type Config = typeof ConfigSchema.Type

const decodeConfig = Schema.decodeUnknownOption(ConfigSchema)

export const parseConfig = (text: string): Config | undefined => {
  try {
    return Option.getOrUndefined(decodeConfig(parseYaml(text)))
  } catch {
    return undefined
  }
}

const PackageEntrySchema = Schema.Struct({
  corpus: Schema.String,
  output: Schema.String,
  primary: Schema.optional(Schema.String),
  anchor: Schema.optional(AnchorSchema),
  settings: Schema.optional(SettingsSchema),
})

export const WorkspaceManifestSchema = Schema.Struct({
  languages: Schema.optional(
    Schema.Record({ key: Schema.String, value: LanguageSchema }),
  ),
  primary: Schema.optional(Schema.String),
  anchor: Schema.optional(AnchorSchema),
  settings: Schema.optional(SettingsSchema),
  packages: Schema.optional(
    Schema.Record({ key: Schema.String, value: PackageEntrySchema }),
  ),
})

export type WorkspaceManifest = typeof WorkspaceManifestSchema.Type
export type PackageEntry = typeof PackageEntrySchema.Type

export interface ResolvedConfig {
  readonly anchor: { readonly open?: string; readonly close?: string } | undefined
  readonly primary: string | undefined
  readonly languages: ReadonlyArray<string>
  readonly settings: Record<string, Record<string, unknown>>
  readonly services: Record<string, string>
  readonly packageRoot: string | undefined
}

const empty: ResolvedConfig = {
  anchor: undefined,
  primary: undefined,
  languages: [],
  settings: {},
  services: {},
  packageRoot: undefined,
}

const storeDirName = '.loom'
const manifestName = 'config.yaml'

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

const mergeSettings = (
  base: Record<string, Record<string, unknown>> | undefined,
  override: Record<string, Record<string, unknown>> | undefined,
): Record<string, Record<string, unknown>> => {
  const a = base ?? {}
  const b = override ?? {}
  return Object.fromEntries(
    [...new Set([...Object.keys(a), ...Object.keys(b)])].map((id) => [
      id,
      { ...(a[id] ?? {}), ...(b[id] ?? {}) },
    ]),
  )
}

const nearestPackage = (
  manifest: WorkspaceManifest,
  workspace: string,
  fromPath: string,
): PackageEntry | undefined =>
  Object.values(manifest.packages ?? {})
    .filter((entry) => {
      const corpus = resolvePath(workspace, entry.corpus)
      return fromPath === corpus || fromPath.startsWith(corpus + sep)
    })
    .reduce<PackageEntry | undefined>(
      (best, entry) =>
        best === undefined || entry.corpus.length > best.corpus.length ? entry : best,
      undefined,
    )

const resolveFromManifest = (
  manifest: WorkspaceManifest,
  workspace: string,
  fromPath: string,
): ResolvedConfig => {
  const pkg = nearestPackage(manifest, workspace, fromPath)
  return {
    anchor: pkg?.anchor ?? manifest.anchor,
    primary: pkg?.primary ?? manifest.primary,
    languages: Object.keys(manifest.languages ?? {}),
    settings: mergeSettings(manifest.settings, pkg?.settings),
    services: servicesOf(manifest.languages),
    packageRoot:
      pkg === undefined ? undefined : resolvePath(workspace, pkg.output),
  }
}

export const configFileName = 'loom.json'

export const LoomConfigSchema = Schema.Struct({
  anchor: Schema.optional(AnchorSchema),
  primary: Schema.optional(Schema.String),
  languages: Schema.optional(Schema.Array(Schema.String)),
  settings: Schema.optional(SettingsSchema),
})

export type LoomConfigFile = typeof LoomConfigSchema.Type

const findLegacy = (dir: string): string | undefined => {
  const candidate = resolvePath(dir, configFileName)
  if (existsSync(candidate)) return candidate
  const parent = dirname(dir)
  return parent === dir ? undefined : findLegacy(parent)
}

const decodeLegacy = Schema.decodeUnknownOption(LoomConfigSchema)

const readLegacy = (file: string): ResolvedConfig => {
  try {
    return Option.match(decodeLegacy(JSON.parse(readFileSync(file, 'utf8'))), {
      onNone: () => empty,
      onSome: (config) => ({
        anchor: config.anchor,
        primary: config.primary,
        languages: config.languages ?? [],
        settings: config.settings ?? {},
        services: Object.fromEntries(
          (config.languages ?? []).map((id) => [id, `@athrio/loom-service-${id}`]),
        ),
        packageRoot: undefined,
      }),
    })
  } catch {
    return empty
  }
}

export class LoomConfig extends Effect.Service<LoomConfig>()('LoomConfig', {
  succeed: {
    resolve: (fromPath: string): Effect.Effect<ResolvedConfig> =>
      Effect.sync(() => {
        if (fromPath === '') return empty
        const dir = dirname(fromPath)
        const workspace = findWorkspace(dir)
        const manifest =
          workspace === undefined
            ? undefined
            : readManifest(resolvePath(workspace, storeDirName, manifestName))
        if (workspace !== undefined && manifest !== undefined) {
          return resolveFromManifest(manifest, workspace, fromPath)
        }
        const legacy = findLegacy(dir)
        return legacy === undefined ? empty : readLegacy(legacy)
      }),

    materialize: (workspace: string, manifest: WorkspaceManifest): Effect.Effect<void> =>
      Effect.sync(() => {
        const store = resolvePath(workspace, storeDirName)
        mkdirSync(store, { recursive: true })
        writeFileSync(resolvePath(store, manifestName), stringifyYaml(manifest))
      }),

    write: (dir: string, config: LoomConfigFile): Effect.Effect<void> =>
      Effect.sync(() => {
        mkdirSync(dir, { recursive: true })
        writeFileSync(
          resolvePath(dir, configFileName),
          `${JSON.stringify(config, null, 2)}\n`,
        )
      }),
  },
}) {}
