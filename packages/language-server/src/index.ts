import { Effect } from "effect"
import { NodeRuntime } from "@effect/platform-node"
import {
  createConnection,
  createServer,
  createSimpleProject,
} from "@volar/language-server/node"
import { create as createHtmlService } from "volar-service-html"
import { create as createCssService } from "volar-service-css"
import { create as createMarkdownService } from "volar-service-markdown"
import { loomLanguagePlugin } from "./languagePlugin"

// =============================================================================
// LSP entry point — an Effect program.
//
// Per CLAUDE.md the LSP must boot from NodeRuntime.runMain. The program body
// today is the boot itself plus `Effect.never` to keep the fiber alive while
// Volar's JSON-RPC callbacks run. There is no Service to provide yet — the
// plugin is a plain object with three pure functions; Volar holds it and
// invokes those functions on its own dispatch loop.
//
// When the projector (SourceStream → WeftsStream → DocumentParser → embedded
// virtual codes) lands and needs Effect-resolved dependencies, the plugin
// graduates back into an Effect.Service and is provided as a Layer here.
// =============================================================================

const program = Effect.gen(function* () {
  const connection = createConnection()
  const server = createServer(connection)

  connection.onInitialize((params) =>
    server.initialize(
      params,
      createSimpleProject([loomLanguagePlugin]),
      [createHtmlService(), createCssService(), createMarkdownService()],
    ),
  )
  connection.onInitialized(server.initialized)
  connection.onShutdown(server.shutdown)
  connection.listen()

  yield* Effect.never
})

NodeRuntime.runMain(program)
