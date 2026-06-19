import { Config, ConfigProvider, Effect, Option } from 'effect'
import { FileSystem } from '@effect/platform'
import { dirname, resolve as resolvePath } from 'node:path'
import { type AnchorDelims, defaultAnchorDelims } from '#ast/LoomTokens'
import { type Path } from '#ast/LoomCorpusAst'

export const configFileName = 'loom.json'

const anchorConfig = Config.all({
  open: Config.string('open').pipe(Config.withDefault(defaultAnchorDelims.open)),
  close: Config.string('close').pipe(Config.withDefault(defaultAnchorDelims.close)),
}).pipe(Config.nested('anchor'))

export class PackageConfig extends Effect.Service<PackageConfig>()(
  'PackageConfig',
  {
    effect: Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem

      const findConfig = (
        dir: string,
      ): Effect.Effect<Option.Option<string>> =>
        Effect.gen(function* () {
          const candidate = resolvePath(dir, configFileName)
          const present = yield* fs.exists(candidate).pipe(Effect.orDie)
          if (present) return Option.some(candidate)
          const parent = dirname(dir)
          return parent === dir ? Option.none() : yield* findConfig(parent)
        })

      const anchorDelims = (path: Path): Effect.Effect<AnchorDelims> =>
        Effect.gen(function* () {
          if (path === '') return defaultAnchorDelims
          const found = yield* findConfig(dirname(path))
          if (Option.isNone(found)) return defaultAnchorDelims
          const text = yield* fs.readFileString(found.value).pipe(Effect.orDie)
          const json = yield* Effect.try(
            () => JSON.parse(text) as unknown,
          ).pipe(Effect.orDie)
          return yield* anchorConfig.pipe(
            Effect.withConfigProvider(ConfigProvider.fromJson(json)),
            Effect.orDie,
          )
        })

      return { anchorDelims }
    }),
  },
) {}
