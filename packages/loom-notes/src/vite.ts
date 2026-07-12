import type { Plugin } from 'vite'

export interface LoomNotesOptions {
  readonly project: string
  readonly port?: number
  readonly autostart?: boolean
}

const daemonUp = (port: number, project: string): Promise<boolean> =>
  fetch(`http://localhost:${port}/notes/feed?project=${project}`)
    .then((response) => response.ok)
    .catch(() => false)

const ensureDaemon = async (options: LoomNotesOptions, port: number): Promise<void> => {
  if (await daemonUp(port, options.project)) return
  if (options.autostart) {
    Bun.spawn(['loom', 'start'], { detached: true, stdio: ['ignore', 'ignore', 'ignore'] }).unref()
    console.log(`[loom-notes] started the notes server on http://localhost:${port}`)
  } else {
    console.warn('[loom-notes] the notes server is not running — start it with `loom start`')
  }
}

export const loomNotes = (options: LoomNotesOptions): Plugin => {
  const port = options.port ?? 5710
  return {
    name: 'loom-notes',
    apply: 'serve',
    configureServer: () => void ensureDaemon(options, port),
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
