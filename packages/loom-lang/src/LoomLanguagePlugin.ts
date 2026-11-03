import type { CodegenContext, LanguagePlugin, VirtualCode } from '@volar/language-core'
import type { LanguageServicePlugin } from '@volar/language-service'
import type {} from '@volar/typescript'
import { Array, Effect, Layer, ManagedRuntime, Option } from 'effect'
import type * as ts from 'typescript'
import { URI } from 'vscode-uri'
import { type Source } from '#ast/LoomCorpusAstBuilder'
import { DocumentSource, LoomCompiler, stringSnapshot } from './LoomCompiler'
import { LoomFormatter } from './LoomFormatter'
import { WorkspaceSource } from './WorkspaceSource'
import { WorkspaceSettings } from './WorkspaceSettings'
import { LoomConfig } from '@athrio/loom-config/LoomConfig'
import {
  Composition,
  type CompositionApi,
  FrameQuery,
  type FrameQueryApi,
  type LanguageService,
  TypescriptSdk,
  type TypescriptSdkApi,
} from '@athrio/loom-lang-services/LanguageService'
import { ActiveLanguages, LanguageRegistry } from '@athrio/loom-lang-services/LanguageRegistry'
import { loadActive } from '@athrio/loom-lang-services/LanguageLoader'
import { installHostRuntime } from '@athrio/loom-lang-services/Runtime'

const editorSource = (
  documents: DocumentSource['Service'],
  shown: string,
  snapshot: ts.IScriptSnapshot,
): Source => ({
  read: (path) =>
    path === shown ? Effect.succeed(snapshot.getText(0, snapshot.getLength())) : documents.read(path),
  list: documents.list,
})

const associate = (
  compiler: LoomCompiler['Service'],
  source: WorkspaceSource['Service'],
  ctx: CodegenContext<URI>,
  entry: string,
): Effect.Effect<void> =>
  compiler.reach(entry).pipe(
    Effect.flatMap((deps) =>
      Effect.forEach(
        deps,
        (dep) => Effect.sync(() => ctx.getAssociatedScript(source.uriOf(dep))),
        { discard: true },
      ),
    ),
  )

const projectIsolated = (
  uri: URI,
  snapshot: ts.IScriptSnapshot,
  ctx: CodegenContext<URI>,
): Effect.Effect<VirtualCode, never, LoomCompiler | DocumentSource | WorkspaceSource> =>
  Effect.gen(function* () {
    const compiler = yield* LoomCompiler
    const documents = yield* DocumentSource
    const source = yield* WorkspaceSource
    const shown = source.locationOf(uri)
    const tree = yield* compiler.compile(editorSource(documents, shown, snapshot), shown)
    yield* associate(compiler, source, ctx, shown)
    return isolateRoots(tree)
  })

export const loomLanguagePlugin = (
  runtime: ManagedRuntime.ManagedRuntime<
    LoomCompiler | DocumentSource | WorkspaceSource | LoomConfig,
    never
  >,
): LanguagePlugin<URI> => ({
  getLanguageId: (uri) => (uri.path.endsWith('.loom') ? 'loom' : undefined),
  createVirtualCode: (uri, languageId, snapshot, ctx) =>
    languageId === 'loom' ? runtime.runSync(projectIsolated(uri, snapshot, ctx)) : undefined,
  updateVirtualCode: (uri, _previous, snapshot, ctx) =>
    runtime.runSync(projectIsolated(uri, snapshot, ctx)),
  disposeVirtualCode: (uri) =>
    runtime.runSync(
      Effect.all([LoomCompiler, WorkspaceSource]).pipe(
        Effect.flatMap(([compiler, source]) =>
          Effect.asVoid(compiler.invalidate(source.locationOf(uri))),
        ),
      ),
    ),
})

const tsLanguages: ReadonlySet<string> = new Set(['typescript', 'tsx', 'javascript', 'jsx'])

const moduleMarker = '\nexport {}\n'

const isolateRoots = (code: VirtualCode): VirtualCode => ({
  ...code,
  snapshot: tsLanguages.has(code.languageId)
    ? stringSnapshot(code.snapshot.getText(0, code.snapshot.getLength()) + moduleMarker)
    : code.snapshot,
  embeddedCodes: Array.map(code.embeddedCodes ?? [], (child) => isolateRoots(child)),
})

const dedupeByName = (
  plugins: ReadonlyArray<LanguageServicePlugin>,
): ReadonlyArray<LanguageServicePlugin> =>
  Array.fromIterable(new Map(plugins.map((plugin) => [plugin.name ?? plugin, plugin])).values())

const collect = (
  active: ReadonlyArray<LanguageService>,
  sdk: TypescriptSdkApi,
  settings: Record<string, Record<string, unknown>>,
  frameQuery: FrameQueryApi,
  composition: CompositionApi,
): Effect.Effect<ReadonlyArray<LanguageServicePlugin>> =>
  Effect.gen(function* () {
    const registry = yield* LanguageRegistry
    const collected = yield* Effect.forEach(registry.all, (service) =>
      service
        .plugins({ settings: settings[service.id] ?? {} })
        .pipe(Effect.catchCause(() => Effect.succeed([] as ReadonlyArray<LanguageServicePlugin>))),
    )
    return dedupeByName(collected.flat())
  }).pipe(
    Effect.provide(LanguageRegistry.layer),
    Effect.provide(Layer.succeed(ActiveLanguages, { all: active })),
    Effect.provideService(TypescriptSdk, sdk),
    Effect.provideService(FrameQuery, frameQuery),
    Effect.provideService(Composition, composition),
  )

const frameQueryOver = (
  runtime: ManagedRuntime.ManagedRuntime<LoomCompiler | LoomFormatter, never>,
  source: WorkspaceSource['Service'],
  languages: ReadonlyArray<LanguageService>,
): FrameQueryApi => ({
  diagnostics: (path) =>
    runtime.runSync(LoomCompiler.pipe(Effect.flatMap((compiler) => compiler.diagnose(path)))),
  definition: (path, offset) =>
    runtime.runSync(
      LoomCompiler.pipe(Effect.flatMap((compiler) => compiler.definition(path, offset))),
    ),
  references: (path, offset) =>
    runtime.runSync(
      LoomCompiler.pipe(Effect.flatMap((compiler) => compiler.references(path, offset))),
    ),
  rename: (path, offset) =>
    runtime.runSync(LoomCompiler.pipe(Effect.flatMap((compiler) => compiler.rename(path, offset)))),
  renameRange: (path, offset) =>
    runtime.runSync(
      LoomCompiler.pipe(Effect.flatMap((compiler) => compiler.renameRange(path, offset))),
    ),
  navigationRange: (path, offset) =>
    runtime.runSync(
      LoomCompiler.pipe(Effect.flatMap((compiler) => compiler.navigationRange(path, offset))),
    ),
  semanticTokens: (path) =>
    runtime.runSync(LoomCompiler.pipe(Effect.flatMap((compiler) => compiler.semanticTokens(path)))),
  format: (path, text) =>
    runtime.runPromise(
      LoomFormatter.pipe(Effect.flatMap((formatter) => formatter.format(path, text, languages))),
    ),
  locationOf: source.locationOf,
  uriOf: source.uriOf,
})

const compositionOver = (
  runtime: ManagedRuntime.ManagedRuntime<LoomCompiler, never>,
): CompositionApi => ({
  rootsFor: (path) =>
    runtime.runSync(LoomCompiler.pipe(Effect.flatMap((compiler) => compiler.composition(path)))),
})

export const loomServicePlugins = (
  runtime: ManagedRuntime.ManagedRuntime<LoomCompiler | LoomFormatter, never>,
  sdk: TypescriptSdkApi,
  workspace: string,
): Effect.Effect<ReadonlyArray<LanguageServicePlugin>, never, WorkspaceSettings | WorkspaceSource> =>
  Effect.gen(function* () {
    const workspaceSettings = yield* WorkspaceSettings
    const source = yield* WorkspaceSource
    const manifest = Option.getOrUndefined(
      yield* Effect.orDie(workspaceSettings.manifest(workspace)),
    )
    const languages = Object.keys(manifest?.languages ?? {})
    const settings = manifest?.settings ?? {}
    yield* Effect.sync(() => installHostRuntime())
    const active = yield* loadActive(languages, workspace)
    return yield* collect(
      active,
      sdk,
      settings,
      frameQueryOver(runtime, source, active),
      compositionOver(runtime),
    )
  })
