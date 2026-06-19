import type { LanguagePlugin } from '@volar/language-core'
import type { LanguageServicePlugin } from '@volar/language-service'
import type {} from '@volar/typescript'
import { Array, Effect, Layer, Option, pipe, Runtime } from 'effect'
import { NodeFileSystem } from '@effect/platform-node'
import type * as ts from 'typescript'
import type { URI } from 'vscode-uri'
import type { LoomCorpusAstBuilder } from '#ast/LoomCorpusAstBuilder'
import { loomVirtualCode } from './LoomCompiler'
import { resolveAnchorDelims } from './PackageConfig'
import { LoomConfig } from '@athrio/loom-config/LoomConfig'
import {
  type LanguageService,
  TypescriptSdk,
} from '@athrio/loom-lang-services/LanguageService'
import {
  ActiveLanguages,
  LanguageRegistry,
} from '@athrio/loom-lang-services/LanguageRegistry'
import { LoomLanguage } from '@athrio/loom-lang-services/LoomLanguage'
import { TypescriptLanguage } from '@athrio/loom-lang-services/TypescriptLanguage'

export const loomLanguagePlugin = (
  runtime: Runtime.Runtime<LoomCorpusAstBuilder>,
): LanguagePlugin<URI> => ({
  getLanguageId: (uri) => (uri.path.endsWith('.loom') ? 'loom' : undefined),
  createVirtualCode: (uri, languageId, snapshot) =>
    languageId === 'loom'
      ? Runtime.runSync(runtime)(
          resolveAnchorDelims(uri.fsPath).pipe(
            Effect.flatMap((delims) => loomVirtualCode(snapshot, delims)),
          ),
        )
      : undefined,
  updateVirtualCode: (uri, _old, snapshot) =>
    Runtime.runSync(runtime)(
      resolveAnchorDelims(uri.fsPath).pipe(
        Effect.flatMap((delims) => loomVirtualCode(snapshot, delims)),
      ),
    ),
  typescript: {
    extraFileExtensions: [
      { extension: 'loom', isMixedContent: true, scriptKind: 7 as ts.ScriptKind },
    ],
    getServiceScript: (root) => {
      const frame = root.embeddedCodes?.find((code) => code.id === 'frame')
      return frame
        ? { code: frame, extension: '.ts', scriptKind: 3 as ts.ScriptKind }
        : undefined
    },
  },
})

const builtIns: ReadonlyMap<string, LanguageService> = new Map([
  [LoomLanguage.id, LoomLanguage],
  [TypescriptLanguage.id, TypescriptLanguage],
])

const resolveActive = (
  ids: ReadonlyArray<string>,
): ReadonlyArray<LanguageService> => [
  LoomLanguage,
  ...pipe(
    ids,
    Array.filterMap((id) =>
      id === LoomLanguage.id
        ? Option.none()
        : Option.fromNullable(builtIns.get(id)),
    ),
  ),
]

const dedupeByName = (
  plugins: ReadonlyArray<LanguageServicePlugin>,
): ReadonlyArray<LanguageServicePlugin> =>
  Array.fromIterable(
    new Map(plugins.map((plugin) => [plugin.name ?? plugin, plugin])).values(),
  )

const collect = (
  active: ReadonlyArray<LanguageService>,
  tsdk: typeof import('typescript'),
): Effect.Effect<ReadonlyArray<LanguageServicePlugin>> =>
  Effect.gen(function* () {
    const registry = yield* LanguageRegistry
    const collected = yield* Effect.forEach(registry.all, (service) =>
      service.plugins({ settings: {} }).pipe(
        Effect.catchAll(() =>
          Effect.succeed([] as ReadonlyArray<LanguageServicePlugin>),
        ),
      ),
    )
    return dedupeByName(collected.flat())
  }).pipe(
    Effect.provide(LanguageRegistry.Default),
    Effect.provide(Layer.succeed(ActiveLanguages, ActiveLanguages.make({ all: active }))),
    Effect.provideService(TypescriptSdk, TypescriptSdk.make(tsdk)),
  )

export const loomServicePlugins = (
  tsdk: typeof import('typescript'),
  root: string,
): Effect.Effect<ReadonlyArray<LanguageServicePlugin>> =>
  Effect.gen(function* () {
    const config = yield* LoomConfig
    const { languages } = yield* config.read(root)
    return yield* collect(resolveActive(languages), tsdk)
  }).pipe(
    Effect.provide(LoomConfig.Default),
    Effect.provide(NodeFileSystem.layer),
  )
