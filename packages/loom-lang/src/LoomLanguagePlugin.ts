import type {
  CodegenContext,
  LanguagePlugin,
  VirtualCode,
} from '@volar/language-core'
import type { LanguageServicePlugin } from '@volar/language-service'
import type {} from '@volar/typescript'
import { Array, Effect, Layer, Option, pipe, Runtime } from 'effect'
import { readFileSync } from 'node:fs'
import type * as ts from 'typescript'
import { URI } from 'vscode-uri'
import { ReadError, type Source } from '#ast/LoomCorpusAstBuilder'
import { LoomCompiler, stringSnapshot } from './LoomCompiler'
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

const projectIsolated = (
  compiler: LoomCompiler,
  uri: URI,
  snapshot: ts.IScriptSnapshot,
  ctx: CodegenContext<URI>,
): Effect.Effect<VirtualCode> =>
  compiler.virtualCode(editorSource(uri, snapshot), uri.fsPath).pipe(
    Effect.tap(() => associate(compiler, ctx, uri.fsPath)),
    Effect.flatMap((tree) =>
      compiler
        .roots(uri.fsPath)
        .pipe(Effect.map((roots) => isolateRoots(roots, tree))),
    ),
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
            ? Effect.asVoid(compiler.change(uri.fsPath))
            : Effect.void
          ).pipe(Effect.zipRight(projectIsolated(compiler, uri, snapshot, ctx))),
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
    getExtraServiceScripts: (fileName, root) =>
      extraProductScripts(runtime, fileName, root),
  },
})

const tsScriptKinds: ReadonlyMap<
  string,
  { readonly extension: string; readonly scriptKind: ts.ScriptKind }
> = new Map([
  ['typescript', { extension: '.ts', scriptKind: 3 as ts.ScriptKind }],
  ['tsx', { extension: '.tsx', scriptKind: 4 as ts.ScriptKind }],
  ['javascript', { extension: '.js', scriptKind: 1 as ts.ScriptKind }],
  ['jsx', { extension: '.jsx', scriptKind: 2 as ts.ScriptKind }],
])

const activatedLanguages = (
  runtime: Runtime.Runtime<LoomCompiler | LoomConfig>,
  fileName: string,
): ReadonlyArray<string> =>
  Runtime.runSync(runtime)(
    LoomConfig.pipe(
      Effect.flatMap((config) => config.resolve(fileName)),
      Effect.map((resolved) => resolved.languages),
    ),
  )

const rootSectionIds = (
  runtime: Runtime.Runtime<LoomCompiler | LoomConfig>,
  fileName: string,
): ReadonlySet<string> =>
  Runtime.runSync(runtime)(
    LoomCompiler.pipe(Effect.flatMap((compiler) => compiler.roots(fileName))),
  )

const extraProductScripts = (
  runtime: Runtime.Runtime<LoomCompiler | LoomConfig>,
  fileName: string,
  root: VirtualCode,
) => {
  const languages = activatedLanguages(runtime, fileName)
  const roots = rootSectionIds(runtime, fileName)
  const activates = (id: string): boolean =>
    languages.includes('typescript') || languages.includes(id)
  return pipe(
    root.embeddedCodes ?? [],
    Array.filter((code) => roots.has(code.id)),
    Array.filterMap((code) =>
      Option.fromNullable(tsScriptKinds.get(code.languageId)).pipe(
        Option.filter(() => activates(code.languageId)),
        Option.map((kind) => ({
          fileName: `${fileName}.${code.id}${kind.extension}`,
          code,
          extension: kind.extension,
          scriptKind: kind.scriptKind,
        })),
      ),
    ),
  )
}

const moduleMarker = '\nexport {}\n'

const isolateRoots = (
  roots: ReadonlySet<string>,
  code: VirtualCode,
): VirtualCode => ({
  ...code,
  snapshot:
    roots.has(code.id) && tsScriptKinds.has(code.languageId)
      ? stringSnapshot(
          code.snapshot.getText(0, code.snapshot.getLength()) + moduleMarker,
        )
      : code.snapshot,
  embeddedCodes: Array.map(code.embeddedCodes ?? [], (child) =>
    isolateRoots(roots, child),
  ),
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
  settings: Record<string, Record<string, unknown>>,
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
  )

export const loomServicePlugins = (
  tsdk: typeof import('typescript'),
  root: string,
): Effect.Effect<ReadonlyArray<LanguageServicePlugin>, never, LoomConfig> =>
  Effect.gen(function* () {
    const config = yield* LoomConfig
    const { languages, settings } = yield* config.resolve(root)
    return yield* collect(resolveActive(languages), tsdk, settings)
  })
