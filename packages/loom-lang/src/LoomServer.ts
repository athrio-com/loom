import { Layer, ManagedRuntime } from 'effect'
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
    const tsdk = loadTsdkByPath(
      (params.initializationOptions as { typescript: { tsdk: string } })
        .typescript.tsdk,
      params.locale,
    )
    const folder = params.workspaceFolders?.[0]?.uri
    const root = folder ? fileURLToPath(folder) : process.cwd()
    const servicePlugins = await runtime.runPromise(
      loomServicePlugins(runtime, tsdk.typescript, root),
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
