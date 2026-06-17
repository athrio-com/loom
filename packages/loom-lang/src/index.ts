import { Effect, Runtime } from 'effect'
import { NodeRuntime } from '@effect/platform-node'
import {
  createConnection,
  createServer,
  createTypeScriptProject,
  loadTsdkByPath,
} from '@volar/language-server/node'
import { fileURLToPath } from 'node:url'
import { LoomCorpusAstBuilder } from '#ast/LoomCorpusAstBuilder'
import { loomLanguagePlugin, loomServicePlugins } from './LoomLanguagePlugin'

const program = Effect.gen(function* () {
  const runtime = yield* Effect.runtime<LoomCorpusAstBuilder>()

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
      createTypeScriptProject(tsdk.typescript, tsdk.diagnosticMessages, () => ({
        languagePlugins: [loomLanguagePlugin(runtime)],
      })),
      [...servicePlugins],
    )
  })
  connection.onInitialized(server.initialized)
  connection.onShutdown(server.shutdown)
  connection.listen()

  yield* Effect.never
}).pipe(Effect.provide(LoomCorpusAstBuilder.Default))

NodeRuntime.runMain(program)
