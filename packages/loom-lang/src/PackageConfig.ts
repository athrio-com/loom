import { Config, ConfigProvider, Effect } from 'effect'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve as resolvePath } from 'node:path'
import { type AnchorDelims, defaultAnchorDelims } from '#ast/LoomTokens'
import { type Path } from '#ast/LoomCorpusAst'

export const configFileName = 'loom.json'

const anchorConfig = Config.all({
  open: Config.string('open').pipe(Config.withDefault(defaultAnchorDelims.open)),
  close: Config.string('close').pipe(Config.withDefault(defaultAnchorDelims.close)),
}).pipe(Config.nested('anchor'))

const delimsFromJson = (json: unknown): Effect.Effect<AnchorDelims> =>
  anchorConfig.pipe(
    Effect.withConfigProvider(ConfigProvider.fromJson(json)),
    Effect.orDie,
  )

const findConfigSync = (dir: string): string | undefined => {
  const candidate = resolvePath(dir, configFileName)
  if (existsSync(candidate)) return candidate
  const parent = dirname(dir)
  return parent === dir ? undefined : findConfigSync(parent)
}

export const resolveAnchorDelims = (
  path: string,
): Effect.Effect<AnchorDelims> =>
  Effect.gen(function* () {
    if (path === '') return defaultAnchorDelims
    const found = yield* Effect.sync(() => findConfigSync(dirname(path)))
    if (found === undefined) return defaultAnchorDelims
    const json = yield* Effect.try(
      () => JSON.parse(readFileSync(found, 'utf8')) as unknown,
    ).pipe(Effect.orElse(() => Effect.succeed({} as unknown)))
    return yield* delimsFromJson(json)
  })

export class PackageConfig extends Effect.Service<PackageConfig>()(
  'PackageConfig',
  {
    succeed: {
      anchorDelims: (path: Path): Effect.Effect<AnchorDelims> =>
        resolveAnchorDelims(path),
    },
  },
) {}
