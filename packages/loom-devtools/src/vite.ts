import type { Plugin } from 'vite'
import type { Effect } from 'effect'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface LoomDevtoolsOptions {
  readonly project: string
  readonly port?: number
  readonly db?: string
}

const startDevtools = async (port: number, database: string): Promise<boolean> => {
  const { Effect, Exit, Fiber, Layer } = await import('effect')
  const { NodeServices } = await import('@effect/platform-node')
  const { notesServer, devtoolsLogger } = await import('./api')
  const { sqliteStore } = await import('./store')
  mkdirSync(dirname(database), { recursive: true })

  const fiber = Effect.runFork(
    Layer.launch(notesServer(port, sqliteStore(database))).pipe(
      Effect.provide(devtoolsLogger),
      Effect.provide(NodeServices.layer),
    ),
  )
  const settled = await Effect.runPromise(
    Effect.race(Fiber.join(fiber), Effect.sleep('150 millis')).pipe(Effect.exit),
  )
  return Exit.match(settled, { onSuccess: () => true, onFailure: () => false })
}

let started: Promise<boolean> | undefined

export const loomDevtools = (options: LoomDevtoolsOptions): Plugin => {
  const port = options.port ?? 5710
  const database = options.db ?? join(process.cwd(), '.loom', 'devtools.sqlite')
  return {
    name: 'loom-devtools',
    apply: 'serve',
    configureServer: async () => {
      started ??= startDevtools(port, database).then(
        (bound) => {
          console.log(
            bound
              ? `[loom-devtools] Devtools on http://localhost:${port} — notes in ${database}`
              : `[loom-devtools] using the Devtools already on http://localhost:${port}`,
          )
          return bound
        },
        (cause) => {
          console.warn('[loom-devtools] could not start the Devtools', cause)
          return false
        },
      )
      await started
    },
    transformIndexHtml: () => [
      {
        tag: 'script',
        attrs: {
          type: 'module',
          src: `http://localhost:${port}/notes.js`,
          'data-loom-project': options.project,
        },
        injectTo: 'body',
      },
    ],
  }
}
