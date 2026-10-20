import { Array, Data, Effect, Option, Schema, pipe } from 'effect'
import { execFile } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { gunzipSync } from 'node:zlib'

const run = promisify(execFile)

export const servicePackage = (id: string): string => `@athrio/loom-service-${id}`

export const isWorkspace = (dir: string): boolean => existsSync(join(dir, '.loom', 'config.yaml'))

export const workspaceOf = (dir: string): Option.Option<string> => {
  if (isWorkspace(dir)) return Option.some(dir)
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

export const serviceVersion = '0.0.13'

export const installedVersion = (id: string, dir: string): Option.Option<string> =>
  Option.flatMap(serviceManifest(id, dir), (manifest) => Option.fromNullishOr(manifest.version))

interface EmbeddedFile extends Blob {
  readonly name?: string
}

const embeddedFiles: ReadonlyArray<EmbeddedFile> =
  (globalThis as { readonly Bun?: { readonly embeddedFiles?: ReadonlyArray<EmbeddedFile> } }).Bun
    ?.embeddedFiles ?? []

export const embeddedFile = (name: string): Option.Option<EmbeddedFile> =>
  Array.findFirst(embeddedFiles, (file) => file.name === name)

export const standalone: boolean =
  embeddedFiles.length > 0 || /(\$|%24)bunfs|(~|%7E)BUN/i.test(String(import.meta.url))

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

const typeScriptAsset = 'typescript.json.gz'

const PackedTypeScriptSchema = Schema.Struct({
  files: Schema.Record(Schema.String, Schema.String),
})

const typeScriptError = (cause: unknown): StoreError =>
  new StoreError({ packageName: 'typescript', cause })

const unpackTypeScript = (dir: string, packed: Blob): Effect.Effect<void, StoreError> =>
  Effect.gen(function* () {
    const archive = yield* Effect.tryPromise({
      try: async () => new Uint8Array(await packed.arrayBuffer()),
      catch: typeScriptError,
    })
    const json = yield* Effect.try({
      try: (): unknown => JSON.parse(gunzipSync(archive).toString('utf8')),
      catch: typeScriptError,
    })
    const { files } = yield* Schema.decodeUnknownEffect(PackedTypeScriptSchema)(json).pipe(
      Effect.mapError(typeScriptError),
    )
    const store = storeDir(dir)
    const modules = join(store, 'node_modules')
    const partial = join(modules, `.typescript-${process.pid}`)
    yield* Effect.sync(() => prepareStore(store))
    yield* Effect.forEach(
      Object.entries(files),
      ([path, text]) =>
        Effect.try({
          try: () => {
            mkdirSync(dirname(join(partial, path)), { recursive: true })
            writeFileSync(join(partial, path), text)
          },
          catch: typeScriptError,
        }),
      { discard: true },
    )
    yield* Effect.try({
      try: () => {
        rmSync(join(modules, 'typescript'), { recursive: true, force: true })
        renameSync(partial, join(modules, 'typescript'))
      },
      catch: typeScriptError,
    })
  })

export const installTypeScript = (dir: string): Effect.Effect<string, StoreError> =>
  Option.match(embeddedFile(typeScriptAsset), {
    onSome: (packed) => unpackTypeScript(dir, packed),
    onNone: () => installPackage(dir, 'typescript', typeScriptRange),
  }).pipe(
    Effect.flatMap(() =>
      Option.match(storeTypeScript(dir), {
        onNone: () => Effect.fail(typeScriptError('the store holds no lib/typescript.js')),
        onSome: Effect.succeed,
      }),
    ),
  )

export const removeService = (id: string, dir: string): Effect.Effect<void> =>
  Effect.sync(() => rmSync(serviceDir(id, dir), { recursive: true, force: true }))
