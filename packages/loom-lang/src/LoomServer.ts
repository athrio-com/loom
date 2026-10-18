import { Data, Effect, Layer, ManagedRuntime, Option, Schema, pipe } from 'effect'
import {
  createConnection,
  createServer,
  createTypeScriptProject,
  loadTsdkByPath,
} from '@volar/language-server/node'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LoomCompiler, DocumentSource } from './LoomCompiler'
import { PackageConfig } from './PackageConfig'
import { LoomConfig } from '@athrio/loom-config/LoomConfig'
import { loomLanguagePlugin, loomServicePlugins } from './LoomLanguagePlugin'

const EditorTsdkSchema = Schema.Struct({
  typescript: Schema.Struct({ tsdk: Schema.String }),
})

const editorTsdk = (options: unknown): Option.Option<string> =>
  Option.map(
    Schema.decodeUnknownOption(EditorTsdkSchema)(options),
    (decoded) => decoded.typescript.tsdk,
  )

const installedTsdk = (from: string): Option.Option<string> =>
  Option.map(
    Option.liftThrowable(() =>
      createRequire(from).resolve('typescript/lib/typescript.js'),
    )(),
    dirname,
  )

export class MissingTypeScript extends Data.TaggedError('MissingTypeScript')<{
  readonly root: string
}> {
  get message(): string {
    return `Loom's language server needs TypeScript 6 or earlier, and found none in ${this.root} or beside Loom. TypeScript 7 has no JavaScript API for it to load. Install one in the project with \`bun add -d typescript@6\`, or have the editor send its path as \`initializationOptions.typescript.tsdk\`.`
  }
}

const tsdkFor = (
  options: unknown,
  root: string,
): Effect.Effect<string, MissingTypeScript> =>
  pipe(
    editorTsdk(options),
    Option.orElse(() => installedTsdk(join(root, 'package.json'))),
    Option.orElse(() => installedTsdk(import.meta.url)),
    Option.match({
      onNone: () => Effect.fail(new MissingTypeScript({ root })),
      onSome: (tsdk) => Effect.succeed(tsdk),
    }),
  )

const runtime = ManagedRuntime.make(
  Layer.mergeAll(LoomCompiler.layer, LoomConfig.layer).pipe(
    Layer.provide(DocumentSource.layer),
    Layer.provide(PackageConfig.layer),
    Layer.provide(LoomConfig.layer),
  ),
)

export const startLanguageServer = (): void => {
  const connection = createConnection()
  const server = createServer(connection)

  connection.onInitialize(async (params) => {
    const folder = params.workspaceFolders?.[0]?.uri
    const root = folder ? fileURLToPath(folder) : process.cwd()
    const { tsdk, servicePlugins } = await runtime.runPromise(
      Effect.gen(function* () {
        const path = yield* tsdkFor(params.initializationOptions, root)
        const tsdk = yield* Effect.sync(() =>
          loadTsdkByPath(path, params.locale),
        )
        const servicePlugins = yield* loomServicePlugins(
          runtime,
          tsdk.typescript,
          root,
        )
        return { tsdk, servicePlugins }
      }),
    )
    return server.initialize(
      params,
      createTypeScriptProject(
        tsdk.typescript,
        tsdk.diagnosticMessages,
        () => ({ languagePlugins: [loomLanguagePlugin(runtime)] }),
      ),
      [...servicePlugins],
    )
  })
  connection.onInitialized(() => {
    server.initialized()
    void server.fileWatcher.watchFiles(['**/tsconfig.json', '**/jsconfig.json'])
  })
  connection.onShutdown(server.shutdown)
  connection.listen()
}
