import type { Plugin } from 'vite'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface LoomDevtoolsOptions {
  readonly project: string
  readonly port?: number
  readonly db?: string
}

const alreadyServing = (port: number): Promise<boolean> =>
  fetch(`http://localhost:${port}/notes/feed?project=_probe`)
    .then(() => true)
    .catch(() => false)

const startDevtools = async (port: number, database: string): Promise<() => void> => {
  const { Effect, Fiber, Layer } = await import('effect')
  const { BunServices } = await import('@effect/platform-bun')
  const { notesServer, devtoolsLogger } = await import('./api')
  const { sqliteStore } = await import('./store')
  mkdirSync(dirname(database), { recursive: true })
  const fiber = Effect.runFork(
    Layer.launch(notesServer(port, sqliteStore(database))).pipe(
      Effect.provide(devtoolsLogger),
      Effect.provide(BunServices.layer),
    ),
  )
  return () => void Effect.runFork(Fiber.interrupt(fiber))
}

export const loomDevtools = (options: LoomDevtoolsOptions): Plugin => {
  const port = options.port ?? 5710
  const database = options.db ?? join(process.cwd(), '.loom', 'devtools.sqlite')
  let stop: (() => void) | undefined
  return {
    name: 'loom-devtools',
    apply: 'serve',
    configureServer: async (server) => {
      if (await alreadyServing(port)) {
        console.log(`[loom-devtools] using the Devtools already on http://localhost:${port}`)
      } else {
        stop = await startDevtools(port, database).then(
          (dispose) => {
            console.log(`[loom-devtools] Devtools on http://localhost:${port} — notes in ${database}`)
            return dispose
          },
          (cause) => {
            console.warn('[loom-devtools] could not start the Devtools — run Vite under Bun (`bun --bun vite`)', cause)
            return undefined
          },
        )
      }
      server.httpServer?.on('close', () => stop?.())
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
