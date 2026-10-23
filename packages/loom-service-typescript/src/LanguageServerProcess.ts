import { Array, Data, Option, pipe, Result } from 'effect'
import { spawn } from 'node:child_process'
import { basename } from 'node:path'
import type { MessageConnection, MessageWriter } from 'vscode-jsonrpc/node.js'
import { URI } from 'vscode-uri'

type Rpc = typeof import('vscode-jsonrpc/node.js')

export interface OpenFile {
  readonly path: string
  readonly text: string
}

export interface LanguageServerProcess {
  readonly keepOpen: (files: ReadonlyArray<OpenFile>) => void
  readonly request: <A>(method: string, params: unknown) => Promise<A>
  readonly alive: () => boolean
  readonly uptime: () => number
  readonly dispose: () => void
}

export type FailureReason = Data.TaggedEnum<{
  CouldNotStart: { readonly text: string }
  NotRunning: { readonly said: Option.Option<string> }
  Unreachable: { readonly text: string }
  Answered: { readonly text: string }
  Refused: { readonly text: string }
}>

export const FailureReason = Data.taggedEnum<FailureReason>()

export class LanguageServerFailed extends Data.TaggedError('LanguageServerFailed')<{
  readonly command: string
  readonly reason: FailureReason
  readonly cause?: unknown
}> {
  get message(): string {
    const server = `the ${this.command} language server`
    return FailureReason.$match(this.reason, {
      CouldNotStart: ({ text }) => `${server} could not start: ${text}`,
      NotRunning: ({ said }) =>
        Option.match(said, {
          onNone: () => `${server} is not running`,
          onSome: (last) => `${server} is not running; it last said: ${last}`,
        }),
      Unreachable: ({ text }) => `Loom cannot speak to ${server}: ${text}`,
      Answered: ({ text }) => `${server} answered: ${text}`,
      Refused: ({ text }) => `${server} refused to start: ${text}`,
    })
  }
}

export const spawnLanguageServer = (
  command: string,
  args: ReadonlyArray<string>,
  workspace: string,
  languageId: string,
  capabilities: object,
): LanguageServerProcess => {
  const state = {
    running: true,
    disposed: false,
    startedAt: Date.now(),
    stoppedAt: 0,
    stderr: '',
    partial: '',
    header: Option.none<string>(),
  }
  const child = spawn(command, [...args], { cwd: workspace, stdio: ['pipe', 'pipe', 'pipe'] })
  const stopped = (): void => {
    if (!state.running) return
    state.running = false
    state.stoppedAt = Date.now()
    void connected.then((connection) => connection.dispose()).catch(() => undefined)
    child.kill()
  }
  const spawned = new Promise<void>((resolve, reject) => {
    child.once('spawn', () => resolve())
    child.once('error', (cause) =>
      reject(
        new LanguageServerFailed({
          command,
          reason: FailureReason.CouldNotStart({ text: String((cause as Error)?.message ?? cause) }),
          cause,
        }),
      ),
    )
  })
  child.on('exit', stopped)
  child.on('error', stopped)
  child.stdin.on('error', stopped)
  child.stderr.on('error', stopped)
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))

  const crashHeader = /^(panic:|fatal error:|SIG[A-Z]+:|(?:[A-Z][A-Za-z]*)?[Ee]rror: )/
  const runtimeBanner = /^(Node\.js|Bun) v\d/
  const linesOf = (text: string): ReadonlyArray<string> =>
    Array.filter(
      Array.map(text.split('\n'), (line) => line.trim()),
      (line) => line !== '',
    )

  child.stderr.on('data', (chunk) => {
    const lines = (state.partial + String(chunk)).split('\n')
    state.partial = Option.getOrElse(Array.last(lines), () => '')
    state.header = Option.orElse(
      Array.findLast(linesOf(Array.dropRight(lines, 1).join('\n')), (line) => crashHeader.test(line)),
      () => state.header,
    )
    state.stderr = (state.stderr + String(chunk)).slice(-8192)
  })

  const lastWords = (): Option.Option<string> =>
    pipe(
      Option.orElse(state.header, () =>
        Option.filter(Option.some(state.partial.trim()), (line) => crashHeader.test(line)),
      ),
      Option.orElse(() => Array.findLast(linesOf(state.stderr), (line) => !runtimeBanner.test(line))),
      Option.map((line) => line.slice(0, 300)),
    )

  const guardedWriter = (writer: MessageWriter): MessageWriter => ({
    write: (message) => writer.write(message).catch(() => stopped()),
    get onError() {
      return writer.onError
    },
    get onClose() {
      return writer.onClose
    },
    end: () => writer.end(),
    dispose: () => writer.dispose(),
  })

  const loaded: Promise<Rpc> = spawned.then(() =>
    import('vscode-jsonrpc/node.js').catch((cause: unknown) =>
      Promise.reject(
        new LanguageServerFailed({
          command,
          reason: FailureReason.Unreachable({ text: String((cause as Error)?.message ?? cause) }),
          cause,
        }),
      ),
    ),
  )
  const connected: Promise<MessageConnection> = loaded.then((rpc) => {
    const connection = rpc.createMessageConnection(
      new rpc.StreamMessageReader(child.stdout),
      guardedWriter(new rpc.StreamMessageWriter(child.stdin)),
    )
    connection.onError(stopped)
    connection.onClose(stopped)
    connection.onRequest(() => null)
    connection.listen()
    return connection
  })

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
  connected.catch(() => undefined)
  ready.catch(() => stopped())

  const opened = new Map<string, { readonly text: string; readonly version: number }>()
  const uriOf = (path: string): string => URI.file(path).toString()
  const send = (method: string, params: unknown): void =>
    void ready.then((connection) => connection.sendNotification(method, params)).catch(() => undefined)

  const keepOpen = (files: ReadonlyArray<OpenFile>): void => {
    const wanted = new Set(Array.map(files, (file) => file.path))
    const closing = Array.filter(Array.fromIterable(opened.keys()), (path) => !wanted.has(path))
    const opening = Array.filter(files, (file) => !opened.has(file.path))
    const changing = Array.filter(files, (file) =>
      Option.match(Option.fromNullishOr(opened.get(file.path)), {
        onNone: () => false,
        onSome: (held) => held.text !== file.text,
      }),
    )
    closing.forEach((path) => {
      opened.delete(path)
      send('textDocument/didClose', { textDocument: { uri: uriOf(path) } })
    })
    opening.forEach((file) => {
      opened.set(file.path, { text: file.text, version: 1 })
      send('textDocument/didOpen', {
        textDocument: { uri: uriOf(file.path), languageId, version: 1, text: file.text },
      })
    })
    changing.forEach((file) => {
      const version = (opened.get(file.path)?.version ?? 0) + 1
      opened.set(file.path, { text: file.text, version })
      send('textDocument/didChange', {
        textDocument: { uri: uriOf(file.path), version },
        contentChanges: [{ text: file.text }],
      })
    })
  }

  const clientCodes = (rpc: Rpc): ReadonlySet<number> =>
    new Set([
      rpc.ErrorCodes.MessageWriteError,
      rpc.ErrorCodes.MessageReadError,
      rpc.ErrorCodes.ConnectionInactive,
      rpc.ErrorCodes.PendingResponseRejected,
    ])

  const answerOf = (rpc: Rpc, cause: unknown): Option.Option<string> =>
    cause instanceof rpc.ResponseError && !clientCodes(rpc).has(cause.code)
      ? Option.some(cause.message)
      : Option.none()

  const elapsed = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

  const notRunning = (): Promise<FailureReason> =>
    Promise.race([closed, elapsed(500)]).then(() => FailureReason.NotRunning({ said: lastWords() }))

  const failedWith =
    (heard: (text: string) => FailureReason) =>
    (cause: unknown): Promise<never> =>
      cause instanceof LanguageServerFailed
        ? Promise.reject(cause)
        : loaded
            .then((rpc) =>
              Option.match(answerOf(rpc, cause), {
                onSome: (text) => Promise.resolve(heard(text)),
                onNone: notRunning,
              }),
            )
            .then((reason) => Promise.reject(new LanguageServerFailed({ command, reason, cause })))

  const asked = <A>(connection: MessageConnection, method: string, params: unknown): Promise<A> =>
    Result.match(
      Result.try(() => connection.sendRequest<A>(method, params)),
      {
        onSuccess: (answer) => answer.catch(failedWith((text) => FailureReason.Answered({ text }))),
        onFailure: failedWith((text) => FailureReason.Answered({ text })),
      },
    )

  const shutdownWait = 2000

  return {
    keepOpen,
    request: <A>(method: string, params: unknown): Promise<A> =>
      state.running
        ? ready.then(
            (connection) => asked<A>(connection, method, params),
            failedWith((text) => FailureReason.Refused({ text })),
          )
        : Promise.reject(
            new LanguageServerFailed({ command, reason: FailureReason.NotRunning({ said: lastWords() }) }),
          ),
    alive: () => state.running,
    uptime: () => (state.running ? Date.now() : state.stoppedAt) - state.startedAt,
    dispose: () => {
      if (state.disposed) return
      state.disposed = true
      const shutdown = ready
        .then((connection) =>
          connection.sendRequest('shutdown').then(() => connection.sendNotification('exit')),
        )
        .catch(() => undefined)
      void Promise.race([shutdown, elapsed(shutdownWait)]).finally(() => {
        stopped()
        child.kill()
      })
    },
  }
}
