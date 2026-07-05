import { Array, Effect, Option, pipe } from 'effect'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { servicePackage, storeDir } from './LoomStore'
import { isLanguageService, type LanguageService } from './LanguageService'
import { LoomLanguage } from './LoomLanguage'
import { ProseLanguage } from './ProseLanguage'

const loadService = (
  id: string,
  root: string,
): Effect.Effect<Option.Option<LanguageService>> =>
  Effect.tryPromise(async () => {
    const from = join(storeDir(dirname(root)), 'index.js')
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
    Effect.catchCause(() =>
      Effect.logWarning(
        `language "${id}" is activated but ${servicePackage(id)} is not installed — run \`loom add ${id}\``,
      ).pipe(Effect.as(Option.none<LanguageService>())),
    ),
  )

export const loadActive = (
  ids: ReadonlyArray<string>,
  root: string,
): Effect.Effect<ReadonlyArray<LanguageService>> =>
  pipe(
    ids,
    Array.filter((id) => id !== LoomLanguage.id && id !== ProseLanguage.id),
    Array.dedupe,
    (rest) => Effect.forEach(rest, (id) => loadService(id, root)),
    Effect.map((loaded) => [
      LoomLanguage,
      ProseLanguage,
      ...Array.getSomes(loaded),
    ]),
  )
