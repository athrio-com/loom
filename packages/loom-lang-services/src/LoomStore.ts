import { Data, Effect, Option, pipe } from 'effect'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

export const servicePackage = (id: string): string => `@athrio/loom-service-${id}`

export const workspaceOf = (dir: string): Option.Option<string> => {
  if (existsSync(join(dir, '.loom'))) return Option.some(dir)
  const parent = dirname(dir)
  return parent === dir ? Option.none() : workspaceOf(parent)
}

export const workspaceRoot = (dir: string): string => Option.getOrElse(workspaceOf(dir), () => dir)

export const storeDir = (dir: string): string =>
  process.env.LOOM_HOME === undefined
    ? join(workspaceRoot(dir), '.loom', 'services')
    : join(process.env.LOOM_HOME, 'services')

const servicePrefix = 'loom-service-'

export const installedServices = (dir: string): Effect.Effect<ReadonlyArray<string>> =>
  Effect.sync(() => {
    const scope = join(storeDir(dir), 'node_modules', '@athrio')
    if (!existsSync(scope)) return []
    return readdirSync(scope)
      .filter((name) => name.startsWith(servicePrefix))
      .map((name) => name.slice(servicePrefix.length))
  })

export const serviceVersion = '0.0.11'

export const installedVersion = (id: string, dir: string): Option.Option<string> =>
  pipe(
    Option.liftThrowable(() =>
      readFileSync(join(storeDir(dir), 'node_modules', servicePackage(id), 'package.json'), 'utf8'),
    )(),
    Option.flatMap(
      Option.liftThrowable((text: string) => JSON.parse(text) as { readonly version?: unknown }),
    ),
    Option.flatMap((manifest) =>
      typeof manifest.version === 'string' ? Option.some(manifest.version) : Option.none(),
    ),
  )

export class StoreError extends Data.TaggedError('StoreError')<{
  readonly id: string
  readonly cause: unknown
}> {}

const prepareStore = (store: string): void => {
  mkdirSync(store, { recursive: true })
  const manifest = join(store, 'package.json')
  if (!existsSync(manifest))
    writeFileSync(
      manifest,
      `${JSON.stringify({ name: 'loom-services', private: true }, null, 2)}\n`,
    )
}

export type ServiceInstall = Data.TaggedEnum<{
  Current: {}
  Installed: {}
  Updated: { readonly from: string }
}>
export const ServiceInstall = Data.taggedEnum<ServiceInstall>()

export const addService = (id: string, dir: string): Effect.Effect<ServiceInstall, StoreError> =>
  Effect.gen(function* () {
    const store = storeDir(dir)
    const installed = installedVersion(id, dir)
    if (Option.contains(installed, serviceVersion)) return ServiceInstall.Current()
    yield* Effect.sync(() => prepareStore(store))
    yield* Effect.tryPromise({
      try: () =>
        run('npm', [
          'install',
          `${servicePackage(id)}@${serviceVersion}`,
          '--prefix',
          store,
          '--omit=peer',
          '--no-audit',
          '--no-fund',
        ]),
      catch: (cause) => new StoreError({ id, cause }),
    })
    return Option.match(installed, {
      onNone: () => ServiceInstall.Installed(),
      onSome: (from) => ServiceInstall.Updated({ from }),
    })
  })

export const removeService = (id: string, dir: string): Effect.Effect<void> =>
  Effect.sync(() =>
    rmSync(join(storeDir(dir), 'node_modules', servicePackage(id)), {
      recursive: true,
      force: true,
    }),
  )
