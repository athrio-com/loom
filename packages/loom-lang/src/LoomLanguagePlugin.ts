import type {
  CodegenContext,
  LanguagePlugin,
  VirtualCode,
} from '@volar/language-core'
import type { LanguageServicePlugin } from '@volar/language-service'
import type {} from '@volar/typescript'
import { Array, Effect, Layer, Option, pipe, Runtime } from 'effect'
import { NodeFileSystem } from '@effect/platform-node'
import { readFileSync } from 'node:fs'
import type * as ts from 'typescript'
import { URI } from 'vscode-uri'
import { ReadError, type Source } from '#ast/LoomCorpusAstBuilder'
import { LoomCompiler } from './LoomCompiler'
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

const editorSource = (
  uri: URI,
  snapshot: ts.IScriptSnapshot,
): Source => ({
  read: (path) =>
    Effect.try({
      try: () =>
        path === uri.fsPath
          ? snapshot.getText(0, snapshot.getLength())
          : readFileSync(path, 'utf8'),
      catch: (cause) => new ReadError({ path, cause }),
    }),
})

const associate = (
  compiler: LoomCompiler,
  ctx: CodegenContext<URI>,
  entry: string,
): Effect.Effect<void> =>
  compiler.corpus(entry).pipe(
    Effect.flatMap((corpus) =>
      Effect.forEach(
        pipe(
          Array.fromIterable(corpus.modules.keys()),
          Array.filter((dep) => dep !== entry),
        ),
        (dep) => Effect.sync(() => ctx.getAssociatedScript(URI.file(dep))),
        { discard: true },
      ),
    ),
  )

const changed = (previous: VirtualCode, next: ts.IScriptSnapshot): boolean =>
  previous.snapshot.getText(0, previous.snapshot.getLength()) !==
  next.getText(0, next.getLength())

export const loomLanguagePlugin = (
  runtime: Runtime.Runtime<LoomCompiler>,
): LanguagePlugin<URI> => ({
  getLanguageId: (uri) => (uri.path.endsWith('.loom') ? 'loom' : undefined),
  createVirtualCode: (uri, languageId, snapshot, ctx) =>
    languageId === 'loom'
      ? Runtime.runSync(runtime)(
          LoomCompiler.pipe(
            Effect.flatMap((compiler) =>
              compiler
                .virtualCode(editorSource(uri, snapshot), uri.fsPath)
                .pipe(Effect.tap(() => associate(compiler, ctx, uri.fsPath))),
            ),
          ),
        )
      : undefined,
  updateVirtualCode: (uri, previous, snapshot, ctx) =>
    Runtime.runSync(runtime)(
      LoomCompiler.pipe(
        Effect.flatMap((compiler) =>
          (changed(previous, snapshot)
            ? Effect.asVoid(compiler.change(uri.fsPath))
            : Effect.void
          ).pipe(
            Effect.zipRight(
              compiler
                .virtualCode(editorSource(uri, snapshot), uri.fsPath)
                .pipe(Effect.tap(() => associate(compiler, ctx, uri.fsPath))),
            ),
          ),
        ),
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
    const { languages } = yield* config.resolve(root)
    return yield* collect(resolveActive(languages), tsdk)
  }).pipe(
    Effect.provide(LoomConfig.Default),
    Effect.provide(NodeFileSystem.layer),
  )
