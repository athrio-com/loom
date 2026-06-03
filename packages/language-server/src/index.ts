import { Effect } from 'effect'
import { NodeRuntime } from '@effect/platform-node'
import {
  createConnection,
  createServer,
  createSimpleProject,
} from '@volar/language-server/node'
import { create as createHtmlService } from 'volar-service-html'
import { create as createCssService } from 'volar-service-css'
import { create as createMarkdownService } from 'volar-service-markdown'
import { Loom } from '#ast/Loom'
import { Resolver } from '#projectors/Resolver'
import { Synthesiser } from '#projectors/Synthesiser'
import { Transducer } from '#projectors/Transducer'
import { loomLanguagePlugin } from './LoomLanguagePlugin'

// =============================================================================
// LSP entry point — an Effect program launched via `NodeRuntime.runMain`.
//
// Providing the pipeline layers here *warms* them (Effect builds layers
// asynchronously), and `Effect.runtime` captures that warm runtime to hand to
// the Loom language plugin. Volar's plugin hooks are synchronous, so the plugin
// runs its (synchronous) virtual-code projection on this warm runtime via
// `Runtime.runSync` — which is only sound because the layers are already built.
// This is why the server is an Effect program rather than plain Volar: a cold,
// per-callback runtime would throw on the async layer build. The program then
// wires Volar's connection/server alongside HTML/CSS/Markdown services and
// yields to `Effect.never`, staying alive while Volar drives its callbacks.
// =============================================================================

const program = Effect.gen(function* () {
  const runtime = yield* Effect.runtime<
    Loom | Transducer | Synthesiser | Resolver
  >()

  const connection = createConnection()
  const server = createServer(connection)

  connection.onInitialize((params) =>
    server.initialize(
      params,
      createSimpleProject([loomLanguagePlugin(runtime)]),
      [createHtmlService(), createCssService(), createMarkdownService()],
    ),
  )
  connection.onInitialized(server.initialized)
  connection.onShutdown(server.shutdown)
  connection.listen()

  yield* Effect.never
}).pipe(
  Effect.provide(Loom.Default),
  Effect.provide(Transducer.Default),
  Effect.provide(Synthesiser.Default),
  Effect.provide(Resolver.Default),
)

NodeRuntime.runMain(program)
