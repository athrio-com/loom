import { Array, Effect, Option, pipe } from 'effect'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isLanguageService, type LanguageService } from './LanguageService'
import { LoomLanguage } from './LoomLanguage'

const servicePackage = (id: string): string => `@athrio/loom-service-${id}`

const userStore = (): string =>
  join(process.env.LOOM_HOME ?? join(homedir(), '.loom'), 'services')

const storeFor = (root: string): string => {
  const seek = (dir: string): string | undefined => {
    const local = join(dir, '.loom', 'services')
    if (existsSync(local)) return local
    const parent = dirname(dir)
    return parent === dir ? undefined : seek(parent)
  }
  return seek(dirname(root)) ?? userStore()
}

const loadService = (
  id: string,
  root: string,
): Effect.Effect<Option.Option<LanguageService>> =>
  Effect.tryPromise(async () => {
    const from = join(storeFor(root), 'index.js')
    const entry = createRequire(from).resolve(servicePackage(id))
    const loaded = (await import(pathToFileURL(entry).href)) as {
      readonly default?: unknown
    }
    return loaded.default
  }).pipe(
    Effect.flatMap((exported) =>
      isLanguageService(exported) && exported.id === id
        ? Effect.succeed(Option.some(exported))
        : Effect.logWarning(
            `${servicePackage(id)} does not export a language service for "${id}"`,
          ).pipe(Effect.as(Option.none<LanguageService>())),
    ),
    Effect.catchAll(() =>
      Effect.logWarning(
        `language "${id}" is activated but ${servicePackage(id)} is not installed — run \`loom activate ${id}\``,
      ).pipe(Effect.as(Option.none<LanguageService>())),
    ),
  )

export const loadActive = (
  ids: ReadonlyArray<string>,
  root: string,
): Effect.Effect<ReadonlyArray<LanguageService>> =>
  pipe(
    ids,
    Array.filter((id) => id !== LoomLanguage.id),
    Array.dedupe,
    (rest) => Effect.forEach(rest, (id) => loadService(id, root)),
    Effect.map((loaded) => [LoomLanguage, ...Array.getSomes(loaded)]),
  )
