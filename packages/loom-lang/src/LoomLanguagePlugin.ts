import type {
  CodegenContext,
  LanguagePlugin,
  VirtualCode,
} from '@volar/language-core'
import type { LanguageServicePlugin } from '@volar/language-service'
import type {} from '@volar/typescript'
import { Array, Effect, Layer, Option, Runtime } from 'effect'
import { readFileSync } from 'node:fs'
import type * as ts from 'typescript'
import { URI } from 'vscode-uri'
import { ReadError, type Source } from '#ast/LoomCorpusAstBuilder'
import { LoomCompiler, loomsUnder, stringSnapshot } from './LoomCompiler'
import { LoomConfig } from '@athrio/loom-config/LoomConfig'
import {
  Composition,
  type CompositionApi,
  FrameQuery,
  type FrameQueryApi,
  type LanguageService,
  TypescriptSdk,
} from '@athrio/loom-lang-services/LanguageService'
import {
  ActiveLanguages,
  LanguageRegistry,
} from '@athrio/loom-lang-services/LanguageRegistry'
import { loadActive } from '@athrio/loom-lang-services/LanguageLoader'
import { installHostRuntime } from '@athrio/loom-lang-services/Runtime'

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
  list: Option.some((dir) => Effect.sync(() => loomsUnder(dir))),
})

const associate = (
  compiler: LoomCompiler,
  ctx: CodegenContext<URI>,
  entry: string,
): Effect.Effect<void> =>
  compiler.reach(entry).pipe(
    Effect.flatMap((deps) =>
      Effect.forEach(
        deps,
        (dep) => Effect.sync(() => ctx.getAssociatedScript(URI.file(dep))),
        { discard: true },
      ),
    ),
  )

const changed = (previous: VirtualCode, next: ts.IScriptSnapshot): boolean =>
  previous.snapshot.getText(0, previous.snapshot.getLength()) !==
  next.getText(0, next.getLength())

const projectIsolated = (
  compiler: LoomCompiler,
  uri: URI,
  snapshot: ts.IScriptSnapshot,
  ctx: CodegenContext<URI>,
): Effect.Effect<VirtualCode> =>
  compiler.compile(editorSource(uri, snapshot), uri.fsPath).pipe(
    Effect.tap(() => associate(compiler, ctx, uri.fsPath)),
    Effect.map((tree) => isolateRoots(tree)),
  )

export const loomLanguagePlugin = (
  runtime: Runtime.Runtime<LoomCompiler | LoomConfig>,
): LanguagePlugin<URI> => ({
  getLanguageId: (uri) => (uri.path.endsWith('.loom') ? 'loom' : undefined),
  createVirtualCode: (uri, languageId, snapshot, ctx) =>
    languageId === 'loom'
      ? Runtime.runSync(runtime)(
          LoomCompiler.pipe(
            Effect.flatMap((compiler) =>
              projectIsolated(compiler, uri, snapshot, ctx),
            ),
          ),
        )
      : undefined,
  updateVirtualCode: (uri, previous, snapshot, ctx) =>
    Runtime.runSync(runtime)(
      LoomCompiler.pipe(
        Effect.flatMap((compiler) =>
          (changed(previous, snapshot)
            ? Effect.asVoid(compiler.invalidate(uri.fsPath))
            : Effect.void
          ).pipe(Effect.zipRight(projectIsolated(compiler, uri, snapshot, ctx))),
        ),
      ),
    ),
})

const tsLanguages: ReadonlySet<string> = new Set([
  'typescript',
  'tsx',
  'javascript',
  'jsx',
])

const moduleMarker = '\nexport {}\n'

const isolateRoots = (code: VirtualCode): VirtualCode => ({
  ...code,
  snapshot: tsLanguages.has(code.languageId)
    ? stringSnapshot(
        code.snapshot.getText(0, code.snapshot.getLength()) + moduleMarker,
      )
    : code.snapshot,
  embeddedCodes: Array.map(code.embeddedCodes ?? [], (child) =>
    isolateRoots(child),
  ),
})

const dedupeByName = (
  plugins: ReadonlyArray<LanguageServicePlugin>,
): ReadonlyArray<LanguageServicePlugin> =>
  Array.fromIterable(
    new Map(plugins.map((plugin) => [plugin.name ?? plugin, plugin])).values(),
  )

const collect = (
  active: ReadonlyArray<LanguageService>,
  tsdk: typeof import('typescript'),
  settings: Record<string, Record<string, unknown>>,
  frameQuery: FrameQueryApi,
  composition: CompositionApi,
): Effect.Effect<ReadonlyArray<LanguageServicePlugin>> =>
  Effect.gen(function* () {
    const registry = yield* LanguageRegistry
    const collected = yield* Effect.forEach(registry.all, (service) =>
      service.plugins({ settings: settings[service.id] ?? {} }).pipe(
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
    Effect.provideService(FrameQuery, FrameQuery.make(frameQuery)),
    Effect.provideService(Composition, Composition.make(composition)),
  )

const frameQueryOver = (
  runtime: Runtime.Runtime<LoomCompiler>,
): FrameQueryApi => ({
  diagnostics: (path) =>
    Runtime.runSync(runtime)(
      LoomCompiler.pipe(Effect.flatMap((compiler) => compiler.diagnose(path))),
    ),
  definition: (path, offset) =>
    Runtime.runSync(runtime)(
      LoomCompiler.pipe(
        Effect.flatMap((compiler) => compiler.definition(path, offset)),
      ),
    ),
  references: (path, offset) =>
    Runtime.runSync(runtime)(
      LoomCompiler.pipe(
        Effect.flatMap((compiler) => compiler.references(path, offset)),
      ),
    ),
  rename: (path, offset) =>
    Runtime.runSync(runtime)(
      LoomCompiler.pipe(
        Effect.flatMap((compiler) => compiler.rename(path, offset)),
      ),
    ),
  renameRange: (path, offset) =>
    Runtime.runSync(runtime)(
      LoomCompiler.pipe(
        Effect.flatMap((compiler) => compiler.renameRange(path, offset)),
      ),
    ),
})

const compositionOver = (
  runtime: Runtime.Runtime<LoomCompiler>,
): CompositionApi => ({
  rootsFor: (path) =>
    Runtime.runSync(runtime)(
      LoomCompiler.pipe(
        Effect.flatMap((compiler) => compiler.composition(path)),
      ),
    ),
})

export const loomServicePlugins = (
  tsdk: typeof import('typescript'),
  root: string,
): Effect.Effect<
  ReadonlyArray<LanguageServicePlugin>,
  never,
  LoomConfig | LoomCompiler
> =>
  Effect.gen(function* () {
    const config = yield* LoomConfig
    const manifest = yield* config.manifest(root)
    const languages = Object.keys(manifest?.languages ?? {})
    const settings = manifest?.settings ?? {}
    const runtime = yield* Effect.runtime<LoomCompiler>()
    yield* Effect.sync(() => installHostRuntime(tsdk))
    const active = yield* loadActive(languages, root)
    return yield* collect(
      active,
      tsdk,
      settings,
      frameQueryOver(runtime),
      compositionOver(runtime),
    )
  })
