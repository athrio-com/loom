import { Array, Cause, Effect, Option, Schema, pipe } from 'effect'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  installedVersion,
  serviceDir,
  type ServiceManifest,
  serviceManifest,
  servicePackage,
  serviceVersion,
} from './LoomStore'
import { isLanguageService, type LanguageService } from './LanguageService'
import { LoomLanguage } from './LoomLanguage'
import { ProseLanguage } from './ProseLanguage'

const ConditionsSchema = Schema.Struct({
  import: Schema.optional(Schema.String),
  default: Schema.optional(Schema.String),
})

const RootExportSchema = Schema.Union([Schema.String, ConditionsSchema])

const ExportsSchema = Schema.Union([Schema.String, Schema.Struct({ '.': RootExportSchema })])

const rootEntry = (root: typeof RootExportSchema.Type): Option.Option<string> =>
  typeof root === 'string'
    ? Option.some(root)
    : Option.fromNullishOr(root.import ?? root.default)

const exportedEntry = (exported: unknown): Option.Option<string> =>
  pipe(
    Schema.decodeUnknownOption(ExportsSchema)(exported),
    Option.map((decoded) => (typeof decoded === 'string' ? decoded : decoded['.'])),
    Option.flatMap(rootEntry),
  )

const serviceEntry = (manifest: ServiceManifest): string =>
  pipe(
    exportedEntry(manifest.exports),
    Option.orElse(() => Option.fromNullishOr(manifest.main)),
    Option.getOrElse(() => 'index.js'),
  )

const serviceAddress = (entry: string, version: Option.Option<string>): string =>
  Option.match(version, {
    onNone: () => pathToFileURL(entry).href,
    onSome: (installed) => `${pathToFileURL(entry).href}?version=${installed}`,
  })

const warnIfStale = (id: string, root: string): Effect.Effect<void> =>
  Option.match(
    Option.filter(installedVersion(id, root), (version) => version !== serviceVersion),
    {
      onNone: () => Effect.void,
      onSome: (version) =>
        Effect.logWarning(
          `${servicePackage(id)} ${version} is installed, but this Loom is ${serviceVersion} — run \`loom update ${id}\` to update it`,
        ),
    },
  )

const exportedService = (
  id: string,
  exported: unknown,
): Effect.Effect<Option.Option<LanguageService>> =>
  isLanguageService(exported) && exported.id === id
    ? Effect.succeed(Option.some(exported))
    : Effect.logWarning(`${servicePackage(id)} does not export a language service for "${id}"`).pipe(
        Effect.as(Option.none<LanguageService>()),
      )

const importService = (id: string, root: string): Effect.Effect<Option.Option<LanguageService>> =>
  Option.match(serviceManifest(id, root), {
    onNone: () =>
      Effect.logWarning(
        `language "${id}" is activated but ${servicePackage(id)} is not installed — run \`loom update ${id}\``,
      ).pipe(Effect.as(Option.none<LanguageService>())),
    onSome: (manifest) =>
      Effect.tryPromise(async () => {
        const entry = join(serviceDir(id, root), serviceEntry(manifest))
        const imported = (await import(
          serviceAddress(entry, Option.fromNullishOr(manifest.version))
        )) as { readonly default?: unknown }
        return imported.default
      }).pipe(
        Effect.flatMap((exported) => exportedService(id, exported)),
        Effect.catchCause((cause) =>
          Effect.logWarning(
            `${servicePackage(id)} could not be loaded — ${Cause.pretty(cause)}`,
          ).pipe(Effect.as(Option.none<LanguageService>())),
        ),
      ),
  })

const loadService = (id: string, root: string): Effect.Effect<Option.Option<LanguageService>> =>
  Effect.andThen(warnIfStale(id, root), importService(id, root))

export const loadActive = (
  ids: ReadonlyArray<string>,
  root: string,
): Effect.Effect<ReadonlyArray<LanguageService>> =>
  pipe(
    ids,
    Array.filter((id) => id !== LoomLanguage.id && id !== ProseLanguage.id),
    Array.dedupe,
    (rest) => Effect.forEach(rest, (id) => loadService(id, root)),
    Effect.map((loaded) => [LoomLanguage, ProseLanguage, ...Array.getSomes(loaded)]),
  )
