import { Effect, Runtime } from 'effect'
import { NodeRuntime } from '@effect/platform-node'
import {
  createConnection,
  createServer,
  createTypeScriptProject,
  loadTsdkByPath,
} from '@volar/language-server/node'
import { fileURLToPath } from 'node:url'
import { LoomCompiler, DocumentSource } from './LoomCompiler'
import { PackageConfig } from './PackageConfig'
import { LoomConfig } from '@athrio/loom-config/LoomConfig'
import { loomLanguagePlugin, loomServicePlugins } from './LoomLanguagePlugin'

const program = Effect.gen(function* () {
  const runtime = yield* Effect.runtime<LoomCompiler | LoomConfig>()

  const connection = createConnection()
  const server = createServer(connection)

  connection.onInitialize(async (params) => {
    const tsdk = loadTsdkByPath(
      (params.initializationOptions as { typescript: { tsdk: string } })
        .typescript.tsdk,
      params.locale,
    )
    const folder = params.workspaceFolders?.[0]?.uri
    const root = folder ? fileURLToPath(folder) : process.cwd()
    const servicePlugins = await Runtime.runPromise(runtime)(
      loomServicePlugins(tsdk.typescript, root),
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

  yield* Effect.never
}).pipe(
  Effect.provide(LoomCompiler.Default),
  Effect.provide(DocumentSource.Default),
  Effect.provide(PackageConfig.Default),
  Effect.provide(LoomConfig.Default),
)

export const startLanguageServer = (): void => NodeRuntime.runMain(program)
