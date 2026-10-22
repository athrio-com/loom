import { Array } from 'effect'
import { spawn } from 'node:child_process'
import { basename } from 'node:path'
import type { MessageConnection } from 'vscode-jsonrpc/node'
import { URI } from 'vscode-uri'

export interface OpenFile {
  readonly path: string
  readonly text: string
}

export interface LanguageServerProcess {
  readonly keepOpen: (files: ReadonlyArray<OpenFile>) => void
  readonly request: <A>(method: string, params: unknown) => Promise<A>
  readonly alive: () => boolean
  readonly dispose: () => void
}

export const startLanguageServer = (
  command: string,
  args: ReadonlyArray<string>,
  workspace: string,
  languageId: string,
  capabilities: object,
): LanguageServerProcess => {
  const child = spawn(command, [...args], { cwd: workspace, stdio: ['pipe', 'pipe', 'ignore'] })
  const connected: Promise<MessageConnection> = import('vscode-jsonrpc/node').then((rpc) => {
    const connection = rpc.createMessageConnection(
      new rpc.StreamMessageReader(child.stdout),
      new rpc.StreamMessageWriter(child.stdin),
    )
    connection.onRequest(() => null)
    connection.listen()
    return connection
  })
  const state = { running: true }
  const stop = (): void => {
    state.running = false
    void connected.then((connection) => connection.dispose()).catch(() => undefined)
  }
  child.on('exit', stop)
  child.on('error', stop)

  const ready: Promise<MessageConnection> = connected.then((connection) =>
    connection
      .sendRequest('initialize', {
        processId: process.pid,
        rootUri: URI.file(workspace).toString(),
        workspaceFolders: [{ uri: URI.file(workspace).toString(), name: basename(workspace) }],
        capabilities,
      })
      .then(() => connection.sendNotification('initialized', {}))
      .then(() => connection),
  )

  const opened = new Map<string, { readonly text: string; readonly version: number }>()
  const uriOf = (path: string): string => URI.file(path).toString()
  const send = (method: string, params: unknown): void =>
    void ready.then((connection) => connection.sendNotification(method, params)).catch(() => undefined)

  const keepOpen = (files: ReadonlyArray<OpenFile>): void => {
    const wanted = new Map(Array.map(files, (file) => [file.path, file.text] as const))
    Array.fromIterable(opened.keys())
      .filter((path) => !wanted.has(path))
      .forEach((path) => {
        opened.delete(path)
        send('textDocument/didClose', { textDocument: { uri: uriOf(path) } })
      })
    files.forEach((file) => {
      const held = opened.get(file.path)
      if (held === undefined) {
        opened.set(file.path, { text: file.text, version: 1 })
        send('textDocument/didOpen', {
          textDocument: { uri: uriOf(file.path), languageId, version: 1, text: file.text },
        })
      } else if (held.text !== file.text) {
        const version = held.version + 1
        opened.set(file.path, { text: file.text, version })
        send('textDocument/didChange', {
          textDocument: { uri: uriOf(file.path), version },
          contentChanges: [{ text: file.text }],
        })
      }
    })
  }

  return {
    keepOpen,
    request: <A>(method: string, params: unknown): Promise<A> =>
      state.running
        ? ready.then((connection) => connection.sendRequest<A>(method, params))
        : Promise.reject(new Error(`the ${command} language server is not running`)),
    alive: () => state.running,
    dispose: () => {
      if (!state.running) return
      void ready
        .then((connection) =>
          connection.sendRequest('shutdown').then(() => connection.sendNotification('exit')),
        )
        .catch(() => undefined)
        .finally(() => {
          stop()
          child.kill()
        })
    },
  }
}
