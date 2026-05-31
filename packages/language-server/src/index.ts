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
import { loomLanguagePlugin } from './LoomLanguagePlugin'

// =============================================================================
// LSP entry point — an Effect program launched via `NodeRuntime.runMain`.
//
// The program wires Volar's connection and server, registers the Loom
// language plugin alongside HTML/CSS/Markdown services, and yields to
// `Effect.never` to keep the fiber alive while Volar drives JSON-RPC
// callbacks. The plugin is a plain Volar `LanguagePlugin` — Volar holds it
// and invokes its hooks on its own dispatch loop.
// =============================================================================

const program = Effect.gen(function* () {
  const connection = createConnection()
  const server = createServer(connection)

  connection.onInitialize((params) =>
    server.initialize(params, createSimpleProject([loomLanguagePlugin]), [
      createHtmlService(),
      createCssService(),
      createMarkdownService(),
    ]),
  )
  connection.onInitialized(server.initialized)
  connection.onShutdown(server.shutdown)
  connection.listen()

  yield* Effect.never
})

NodeRuntime.runMain(program)
