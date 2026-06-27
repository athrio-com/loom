import { Data, Effect } from 'effect'
import { execFile } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

export const servicePackage = (id: string): string =>
  `@athrio/loom-service-${id}`

export const workspaceRoot = (dir: string): string => {
  const seek = (at: string): string | undefined => {
    if (existsSync(join(at, '.loom'))) return at
    const parent = dirname(at)
    return parent === at ? undefined : seek(parent)
  }
  return seek(dir) ?? dir
}

export const storeDir = (dir: string): string =>
  process.env.LOOM_HOME === undefined
    ? join(workspaceRoot(dir), '.loom', 'services')
    : join(process.env.LOOM_HOME, 'services')

const servicePrefix = 'loom-service-'

export const installedServices = (
  dir: string,
): Effect.Effect<ReadonlyArray<string>> =>
  Effect.sync(() => {
    const scope = join(storeDir(dir), 'node_modules', '@athrio')
    if (!existsSync(scope)) return []
    return readdirSync(scope)
      .filter((name) => name.startsWith(servicePrefix))
      .map((name) => name.slice(servicePrefix.length))
  })

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

export const addService = (
  id: string,
  dir: string,
): Effect.Effect<void, StoreError> =>
  Effect.gen(function* () {
    const store = storeDir(dir)
    if (existsSync(join(store, 'node_modules', servicePackage(id)))) return
    yield* Effect.sync(() => prepareStore(store))
    yield* Effect.tryPromise({
      try: () =>
        run('npm', [
          'install',
          servicePackage(id),
          '--prefix',
          store,
          '--omit=peer',
          '--no-audit',
          '--no-fund',
        ]),
      catch: (cause) => new StoreError({ id, cause }),
    }).pipe(Effect.asVoid)
  })

export const removeService = (id: string, dir: string): Effect.Effect<void> =>
  Effect.sync(() =>
    rmSync(join(storeDir(dir), 'node_modules', servicePackage(id)), {
      recursive: true,
      force: true,
    }),
  )
