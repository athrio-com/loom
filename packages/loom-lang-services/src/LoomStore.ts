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
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

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

export const serviceVersion = '0.0.16'

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

const prepareRoot = (root: string): void => {
  mkdirSync(root, { recursive: true })
  const manifest = join(root, 'package.json')
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
  readonly shell: boolean
}

const onWindows = process.platform === 'win32'

const quotedOnWindows = (argument: string): string =>
  onWindows && /\s/.test(argument) ? `"${argument}"` : argument

const packageManager = (root: string, spec: string): PackageManager =>
  standalone
    ? {
        command: process.execPath,
        args: ['add', spec, '--cwd', root, '--omit', 'peer', '--linker', 'hoisted'],
        env: { ...process.env, BUN_BE_BUN: '1' },
        shell: false,
      }
    : {
        command: 'npm',
        args: Array.map(
          ['install', spec, '--prefix', root, '--omit=peer', '--no-audit', '--no-fund'],
          quotedOnWindows,
        ),
        env: process.env,
        shell: onWindows,
      }

const installPackage = (
  root: string,
  packageName: string,
  range: string,
): Effect.Effect<void, StoreError> =>
  Effect.gen(function* () {
    yield* Effect.sync(() => prepareRoot(root))
    const manager = packageManager(root, `${packageName}@${range}`)
    yield* Effect.tryPromise({
      try: () =>
        run(manager.command, [...manager.args], { env: manager.env, shell: manager.shell }),
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
    yield* installPackage(storeDir(dir), servicePackage(id), serviceVersion)
    return Option.match(installed, {
      onNone: () => ServiceInstall.Installed(),
      onSome: (from) => ServiceInstall.Updated({ from }),
    })
  })

export const typeScriptVersion = '7.0.2'

export const loomHome = (): string => process.env.LOOM_HOME ?? join(homedir(), '.loom')

export const fetchedTypeScriptDir = (version: string): string =>
  join(loomHome(), 'typescript', version)

const executableName = process.platform === 'win32' ? 'tsc.exe' : 'tsc'

export const fetchedExecutable = (version: string): string =>
  join(
    fetchedTypeScriptDir(version),
    'node_modules',
    '@typescript',
    `typescript-${process.platform}-${process.arch}`,
    'lib',
    executableName,
  )

const present = (path: string): Effect.Effect<boolean> => Effect.sync(() => existsSync(path))

const placeFetched = (partial: string, folder: string, executable: string): void => {
  if (existsSync(executable)) return
  rmSync(folder, { recursive: true, force: true })
  Option.liftThrowable(() => renameSync(partial, folder))()
}

export const fetchTypeScript = (version: string): Effect.Effect<string, StoreError> => {
  const folder = fetchedTypeScriptDir(version)
  const partial = `${folder}.partial-${process.pid}`
  const executable = fetchedExecutable(version)
  const failed = (cause: unknown): StoreError =>
    new StoreError({ packageName: `typescript@${version}`, cause })
  const install = Effect.gen(function* () {
    yield* Effect.logInfo(`loom: fetching TypeScript ${version} into ${folder}`)
    yield* Effect.sync(() => rmSync(partial, { recursive: true, force: true }))
    yield* installPackage(partial, 'typescript', version)
    yield* Effect.sync(() => placeFetched(partial, folder, executable))
  }).pipe(Effect.ensuring(Effect.sync(() => rmSync(partial, { recursive: true, force: true }))))
  return present(executable).pipe(
    Effect.flatMap((there) => (there ? Effect.void : install)),
    Effect.andThen(present(executable)),
    Effect.flatMap((there) =>
      there
        ? Effect.succeed(executable)
        : Effect.fail(
            failed(`${folder} holds no TypeScript executable for this platform at ${executable}`),
          ),
    ),
  )
}

export const removeService = (id: string, dir: string): Effect.Effect<void> =>
  Effect.sync(() => rmSync(serviceDir(id, dir), { recursive: true, force: true }))
