import { Config, ConfigProvider, Effect, Schema } from 'effect'
import { FileSystem } from '@effect/platform'
import { resolve } from 'node:path'

export const LoomConfigSchema = Schema.Struct({
  languages: Schema.Array(Schema.String),
})

export type LoomConfigData = typeof LoomConfigSchema.Type

export const configFileName = 'loom.config.json'

const activeLanguages = Config.array(Config.string(), 'languages').pipe(
  Config.withDefault([]),
)

export class LoomConfig extends Effect.Service<LoomConfig>()(
  'LoomConfig',
  {
    effect: Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem

      const read = (root: string): Effect.Effect<LoomConfigData> =>
        Effect.gen(function* () {
          const path = resolve(root, configFileName)
          const present = yield* fs.exists(path).pipe(Effect.orDie)
          if (!present) return { languages: [] }
          const text = yield* fs.readFileString(path).pipe(Effect.orDie)
          const json = yield* Effect.try(() => JSON.parse(text) as unknown).pipe(
            Effect.orDie,
          )
          const languages = yield* activeLanguages.pipe(
            Effect.withConfigProvider(ConfigProvider.fromJson(json)),
            Effect.orDie,
          )
          return { languages: languages.filter((id) => id !== '<nil>') }
        })

      const write = (root: string, config: LoomConfigData): Effect.Effect<void> =>
        Effect.gen(function* () {
          const path = resolve(root, configFileName)
          const text = `${JSON.stringify(config, null, 2)}\n`
          yield* fs.writeFileString(path, text).pipe(Effect.orDie)
        })

      return { read, write }
    }),
  },
) {}
