import { describe, expect, it } from 'bun:test'
import {
  createMessageConnection,
  type Diagnostic,
  FileChangeType,
  type Location,
  type LocationLink,
  StreamMessageReader,
  StreamMessageWriter,
  type WorkspaceEdit,
} from '@volar/language-server/node'
import { Array, Effect, ManagedRuntime, Redacted } from 'effect'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { RemoteEnvironment, WorkspaceSource } from '../src/WorkspaceSource'
import { WorkspaceSettings } from '../src/WorkspaceSettings'
import { type StorageStub, storageStub } from './storageStub'

const key = 'the-key-the-tests-share'

const lines = (...rows: ReadonlyArray<string>): string => `${rows.join('\n')}\n`

const anchor = (name: string): string => `::${'['}${name}]`

const greeting = lines(
  '# Saying hello',
  '',
  '=>',
  '',
  "export const greet = (name: string) => 'Hello, ' + name",
)

const program = lines('# The program', '', '=>', '', anchor('Saying hello'), '', "greet('world')")

const stubWithBoth = (): StorageStub =>
  storageStub(key, [
    ['corpus/greeting.loom', greeting],
    ['corpus/hello.loom', program],
  ])

const remote = (stub: StorageStub, secret: string) =>
  ManagedRuntime.make(RemoteEnvironment({ url: stub.url, key: Redacted.make(secret) }))

describe('RemoteSource — a workspace kept behind a URL', () => {
  it('opens a workspace over HTTP and answers the rest by rule', async () => {
    const stub = stubWithBoth()
    const runtime = remote(stub, key)
    try {
      await runtime.runPromise(
        Effect.gen(function* () {
          const source = yield* WorkspaceSource
          const settings = yield* WorkspaceSettings
          const hello = stub.locationOf('corpus/hello.loom')
          const opened = yield* source.open(stub.url)
          expect([...opened.looms.keys()].sort()).toEqual(
            [stub.locationOf('corpus/greeting.loom'), hello].sort(),
          )
          expect(yield* source.read(hello)).toBe(program)
          expect(yield* source.corpusOf(hello)).toHaveLength(2)
          expect(source.workspaceOf(hello)).toBe(stub.url)
          expect(yield* source.placeOf(hello, 'src/hello.ts')).toBe('src/hello.ts')
          expect(source.locationOf(source.uriOf(hello))).toBe(hello)
          yield* settings.manifest(stub.url)
          expect((yield* settings.resolve(hello)).primaryLanguage).toBe('typescript')
        }),
      )
    } finally {
      stub.stop()
    }
  })

  it('refuses a wrong key without naming it', async () => {
    const stub = stubWithBoth()
    const runtime = remote(stub, 'not-the-key')
    try {
      const failure = await runtime.runPromise(
        WorkspaceSource.pipe(Effect.flatMap((source) => Effect.flip(source.open(stub.url)))),
      )
      expect(failure.message).toContain(stub.url)
      expect(failure.message).not.toContain('not-the-key')
    } finally {
      stub.stop()
    }
  })
})

const serverEntry = fileURLToPath(new URL('../src/index.ts', import.meta.url))

const editorOver = (stub: StorageStub, secret: string) => {
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== 'LOOM_HOME')),
    LOOM_STORAGE_URL: stub.url,
    LOOM_STORAGE_KEY: secret,
  }
  const child = spawn(process.execPath, [serverEntry, '--stdio'], {
    env,
    stdio: ['pipe', 'pipe', 'ignore'],
  })
  const connection = createMessageConnection(
    new StreamMessageReader(child.stdout),
    new StreamMessageWriter(child.stdin),
  )
  connection.onRequest(() => null)
  connection.listen()
  const initialize = (): Promise<unknown> =>
    connection.sendRequest('initialize', {
      processId: process.pid,
      rootUri: null,
      workspaceFolders: null,
      capabilities: { workspace: { didChangeWatchedFiles: { dynamicRegistration: true } } },
    })
  const close = (): void => {
    connection.dispose()
    child.kill()
  }
  return { connection, initialize, close }
}

const targetOf = (link: Location | LocationLink): string =>
  'targetUri' in link ? link.targetUri : link.uri

describe('LoomServer — a workspace kept in remote storage', () => {
  it('serves its looms with no folder, and follows a change', async () => {
    const stub = stubWithBoth()
    const editor = editorOver(stub, key)
    try {
      await editor.initialize()
      await editor.connection.sendNotification('initialized', {})
      const hello = stub.locationOf('corpus/hello.loom')
      const greetingUri = stub.locationOf('corpus/greeting.loom')
      await editor.connection.sendNotification('textDocument/didOpen', {
        textDocument: { uri: hello, languageId: 'loom', version: 1, text: program },
      })
      const diagnostics = async (): Promise<ReadonlyArray<string>> =>
        Array.map(
          (
            await editor.connection.sendRequest<{ readonly items: ReadonlyArray<Diagnostic> }>(
              'textDocument/diagnostic',
              { textDocument: { uri: hello } },
            )
          ).items,
          (diagnostic) => diagnostic.message,
        )
      expect(await diagnostics()).toEqual([])
      const position = { line: 4, character: 5 }
      const links = await editor.connection.sendRequest<ReadonlyArray<Location | LocationLink>>(
        'textDocument/definition',
        { textDocument: { uri: hello }, position },
      )
      expect(Array.map(links, targetOf)).toEqual([greetingUri])
      const edit = await editor.connection.sendRequest<WorkspaceEdit>('textDocument/rename', {
        textDocument: { uri: hello },
        position,
        newName: 'Saying hi',
      })
      expect(Object.keys(edit.changes ?? {}).sort()).toEqual([greetingUri, hello].sort())
      stub.write('corpus/greeting.loom', greeting.replace('Saying hello', 'Saying goodbye'))
      await editor.connection.sendNotification('workspace/didChangeWatchedFiles', {
        changes: [{ uri: greetingUri, type: FileChangeType.Changed }],
      })
      expect((await diagnostics()).join('\n')).toContain('Saying hello')
    } finally {
      editor.close()
      stub.stop()
    }
  }, 30_000)

  it('fails the initialize request on a wrong key, without naming the key', async () => {
    const stub = stubWithBoth()
    const editor = editorOver(stub, 'not-the-key')
    try {
      const failure = await editor.initialize().then(
        () => 'accepted',
        (error: Error) => error.message,
      )
      expect(failure).toContain(stub.url)
      expect(failure).not.toContain('not-the-key')
    } finally {
      editor.close()
      stub.stop()
    }
  }, 30_000)
})
