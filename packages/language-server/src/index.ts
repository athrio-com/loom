import { Effect } from 'effect'
import { NodeRuntime } from '@effect/platform-node'
import {
  createConnection,
  createServer,
  createTypeScriptProject,
  loadTsdkByPath,
} from '@volar/language-server/node'
import { create as createTypeScriptServices } from 'volar-service-typescript'
import { Loom } from '#ast/Loom'
import { Resolver } from '#projectors/Resolver'
import { Synthesiser } from '#projectors/Synthesiser'
import { FrameAstBuilder } from '#projectors/FrameAstBuilder'
import { loomLanguagePlugin } from './LoomLanguagePlugin'

// =============================================================================
// LSP entry point — an Effect program launched via `NodeRuntime.runMain`.
//
// Providing the pipeline layers warms them, and `Effect.runtime` captures that
// warm runtime for the plugin (Volar's hooks are synchronous; the plugin runs
// the projection on it). The project is TypeScript-aware
// (`createTypeScriptProject`), so Volar type-checks the synthesised frame — the
// `typescript` embedded code the plugin exposes via `typescript.getServiceScript`
// — and the TypeScript language service surfaces composition diagnostics, mapped
// back to the `.loom`.
//
// `typescript` is not bundled: the client passes its `lib/` directory as
// `initializationOptions.typescript.tsdk` and `loadTsdkByPath` loads it, so the
// frame checks against a real standard library (`lib.*.d.ts` resolve from that
// dir). (Prose services — HTML/CSS/Markdown — are dropped for now: they pull in a
// `vscode-uri` ESM-interop break at bundle time, and aren't needed here.)
// =============================================================================

const program = Effect.gen(function* () {
  const runtime = yield* Effect.runtime<
    Loom | FrameAstBuilder | Synthesiser | Resolver
  >()

  const connection = createConnection()
  const server = createServer(connection)

  connection.onInitialize((params) => {
    const tsdk = loadTsdkByPath(
      (params.initializationOptions as { typescript: { tsdk: string } })
        .typescript.tsdk,
      params.locale,
    )
    return server.initialize(
      params,
      createTypeScriptProject(tsdk.typescript, tsdk.diagnosticMessages, () => ({
        languagePlugins: [loomLanguagePlugin(runtime)],
      })),
      createTypeScriptServices(tsdk.typescript),
    )
  })
  connection.onInitialized(server.initialized)
  connection.onShutdown(server.shutdown)
  connection.listen()

  yield* Effect.never
}).pipe(
  Effect.provide(Loom.Default),
  Effect.provide(FrameAstBuilder.Default),
  Effect.provide(Synthesiser.Default),
  Effect.provide(Resolver.Default),
)

NodeRuntime.runMain(program)
