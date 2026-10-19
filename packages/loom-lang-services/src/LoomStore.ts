import { Data, Effect, Option, Schema, pipe } from 'effect'
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

export const ServiceManifestSchema = Schema.Struct({
  version: Schema.optional(Schema.String),
  main: Schema.optional(Schema.String),
  exports: Schema.optional(Schema.Unknown),
})

export type ServiceManifest = typeof ServiceManifestSchema.Type

export const serviceDir = (id: string, dir: string): string =>
  join(storeDir(dir), 'node_modules', servicePackage(id))

export const serviceManifest = (id: string, dir: string): Option.Option<ServiceManifest> =>
  pipe(
    Option.liftThrowable(() => readFileSync(join(serviceDir(id, dir), 'package.json'), 'utf8'))(),
    Option.flatMap(Option.liftThrowable((text: string): unknown => JSON.parse(text))),
    Option.flatMap(Schema.decodeUnknownOption(ServiceManifestSchema)),
  )

export const serviceVersion = '0.0.12'

export const installedVersion = (id: string, dir: string): Option.Option<string> =>
  Option.flatMap(serviceManifest(id, dir), (manifest) => Option.fromNullishOr(manifest.version))

export const standalone: boolean = /[\\/](\$bunfs|~BUN)[\\/]/.test(import.meta.url)

export class StoreError extends Data.TaggedError('StoreError')<{
  readonly packageName: string
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

interface PackageManager {
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly env: NodeJS.ProcessEnv
}

const packageManager = (store: string, spec: string): PackageManager =>
  standalone
    ? {
        command: process.execPath,
        args: ['add', spec, '--cwd', store, '--omit', 'peer'],
        env: { ...process.env, BUN_BE_BUN: '1' },
      }
    : {
        command: 'npm',
        args: ['install', spec, '--prefix', store, '--omit=peer', '--no-audit', '--no-fund'],
        env: process.env,
      }

const installPackage = (
  dir: string,
  packageName: string,
  range: string,
): Effect.Effect<void, StoreError> =>
  Effect.gen(function* () {
    const store = storeDir(dir)
    yield* Effect.sync(() => prepareStore(store))
    const manager = packageManager(store, `${packageName}@${range}`)
    yield* Effect.tryPromise({
      try: () => run(manager.command, [...manager.args], { env: manager.env }),
      catch: (cause) => new StoreError({ packageName, cause }),
    })
  })

export type ServiceInstall = Data.TaggedEnum<{
  Current: {}
  Installed: {}
  Updated: { readonly from: string }
}>
export const ServiceInstall = Data.taggedEnum<ServiceInstall>()

export const installService = (id: string, dir: string): Effect.Effect<ServiceInstall, StoreError> =>
  Effect.gen(function* () {
    const installed = installedVersion(id, dir)
    if (Option.contains(installed, serviceVersion)) return ServiceInstall.Current()
    yield* installPackage(dir, servicePackage(id), serviceVersion)
    return Option.match(installed, {
      onNone: () => ServiceInstall.Installed(),
      onSome: (from) => ServiceInstall.Updated({ from }),
    })
  })

export const typeScriptRange = '^6'

export const storeTypeScript = (dir: string): Option.Option<string> => {
  const file = join(storeDir(dir), 'node_modules', 'typescript', 'lib', 'typescript.js')
  return existsSync(file) ? Option.some(file) : Option.none()
}

export const installTypeScript = (dir: string): Effect.Effect<string, StoreError> =>
  installPackage(dir, 'typescript', typeScriptRange).pipe(
    Effect.flatMap(() =>
      Option.match(storeTypeScript(dir), {
        onNone: () =>
          Effect.fail(
            new StoreError({
              packageName: 'typescript',
              cause: 'the install left no lib/typescript.js in the store',
            }),
          ),
        onSome: Effect.succeed,
      }),
    ),
  )

export const removeService = (id: string, dir: string): Effect.Effect<void> =>
  Effect.sync(() => rmSync(serviceDir(id, dir), { recursive: true, force: true }))
