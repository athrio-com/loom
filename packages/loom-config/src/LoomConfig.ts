import { Effect, Option, Schema } from 'effect'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { dirname, resolve as resolvePath } from 'node:path'

export const configFileName = 'loom.json'

export const LoomConfigSchema = Schema.Struct({
  anchor: Schema.optional(
    Schema.Struct({
      open: Schema.optional(Schema.String),
      close: Schema.optional(Schema.String),
    }),
  ),
  primary: Schema.optional(Schema.String),
  languages: Schema.optional(Schema.Array(Schema.String)),
  settings: Schema.optional(
    Schema.Record({
      key: Schema.String,
      value: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
    }),
  ),
})

export type LoomConfigFile = typeof LoomConfigSchema.Type

export interface PackageConfig {
  readonly anchor: { readonly open?: string; readonly close?: string } | undefined
  readonly primary: string | undefined
  readonly languages: ReadonlyArray<string>
  readonly settings: Record<string, Record<string, unknown>>
}

const empty: PackageConfig = {
  anchor: undefined,
  primary: undefined,
  languages: [],
  settings: {},
}

const findConfig = (dir: string): string | undefined => {
  const candidate = resolvePath(dir, configFileName)
  if (existsSync(candidate)) return candidate
  const parent = dirname(dir)
  return parent === dir ? undefined : findConfig(parent)
}

const decode = Schema.decodeUnknownOption(LoomConfigSchema)

const readConfig = (file: string): PackageConfig => {
  try {
    const json = JSON.parse(readFileSync(file, 'utf8')) as unknown
    return Option.match(decode(json), {
      onNone: () => empty,
      onSome: (config) => ({
        anchor: config.anchor,
        primary: config.primary,
        languages: config.languages ?? [],
        settings: config.settings ?? {},
      }),
    })
  } catch {
    return empty
  }
}

export class LoomConfig extends Effect.Service<LoomConfig>()('LoomConfig', {
  succeed: {
    resolve: (fromPath: string): Effect.Effect<PackageConfig> =>
      Effect.sync(() => {
        if (fromPath === '') return empty
        const file = findConfig(dirname(fromPath))
        return file === undefined ? empty : readConfig(file)
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
