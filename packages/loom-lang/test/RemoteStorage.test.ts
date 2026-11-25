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
import { Effect, ManagedRuntime, Redacted } from 'effect'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe as wordsOf, lineOf } from '#ast/LoomFailure'
import { contentsRequest } from '../src/LoomServer'
import type { TableOfContents } from '../src/weave/TableOfContentsBuilder'
import { RemoteEnvironment, WorkspaceSource } from '../src/WorkspaceSource'
import { WorkspaceSettings } from '../src/WorkspaceSettings'
import { type StorageStub, storageStub, type StubWorkspace } from './storageStub'

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

const notes = lines('# Notes', '', 'A workspace of its own.')

const both: ReadonlyArray<readonly [string, string]> = [
  ['corpus/greeting.loom', greeting],
  ['corpus/hello.loom', program],
]

const firstWith = (looms: ReadonlyArray<readonly [string, string]>): StubWorkspace => ({
  name: 'first',
  manifest: { primary: 'typescript' },
  looms,
})

const second: StubWorkspace = {
  name: 'second',
  manifest: { primary: 'python' },
  looms: [['corpus/notes.loom', notes]],
}

const stubWithBoth = (): StorageStub => storageStub(key, [firstWith(both), second])

const remote = (stub: StorageStub, secret: string) =>
  ManagedRuntime.make(RemoteEnvironment({ url: stub.storage, key: Redacted.make(secret) }))

describe('RemoteSource — workspaces kept behind one storage address', () => {
  it('opens a workspace over HTTP and answers the rest by rule', async () => {
    const stub = stubWithBoth()
    const runtime = remote(stub, key)
    try {
      await runtime.runPromise(
        Effect.gen(function* () {
          const source = yield* WorkspaceSource
          const settings = yield* WorkspaceSettings
          const workspace = stub.addressOf('first')
          const hello = stub.locationOf('first', 'corpus/hello.loom')
          const opened = yield* source.open(workspace)
          expect([...opened.looms.keys()].sort()).toEqual(
            [stub.locationOf('first', 'corpus/greeting.loom'), hello].sort(),
          )
          expect(yield* source.read(hello)).toBe(program)
          expect(yield* source.corpusOf(hello)).toHaveLength(2)
          expect(source.workspaceOf(hello)).toBe(workspace)
          expect((yield* source.placesOf([hello]))(hello, 'src/hello.ts')).toBe('src/hello.ts')
          expect(source.locationOf(source.uriOf(hello))).toBe(hello)
          yield* settings.manifest(workspace)
          expect((yield* settings.resolve(hello)).primaryLanguage).toBe('typescript')
        }),
      )
    } finally {
      stub.stop()
    }
  })

  it('keeps the workspaces of one storage apart', async () => {
    const stub = stubWithBoth()
    const runtime = remote(stub, key)
    try {
      await runtime.runPromise(
        Effect.gen(function* () {
          const source = yield* WorkspaceSource
          const settings = yield* WorkspaceSettings
          const first = stub.addressOf('first')
          const elsewhere = stub.addressOf('second')
          const hello = stub.locationOf('first', 'corpus/hello.loom')
          const notesLoom = stub.locationOf('second', 'corpus/notes.loom')
          expect(source.workspaceOf(hello)).toBe(first)
          expect(source.workspaceOf(notesLoom)).toBe(elsewhere)
          expect(source.workspaceOf(elsewhere)).toBe(elsewhere)
          expect(source.workspaceOf(stub.storage)).toBe(stub.storage)
          expect(source.workspaceOf('memory:/a.loom')).toBe('memory:/a.loom')
          expect(yield* source.corpusOf(notesLoom)).toEqual([])
          yield* settings.manifest(first)
          yield* settings.manifest(elsewhere)
          expect([...(yield* source.corpusOf(hello))].sort()).toEqual(
            [stub.locationOf('first', 'corpus/greeting.loom'), hello].sort(),
          )
          expect(yield* source.corpusOf(notesLoom)).toEqual([notesLoom])
          expect((yield* settings.resolve(hello)).primaryLanguage).toBe('typescript')
          expect((yield* settings.resolve(notesLoom)).primaryLanguage).toBe('python')
          yield* settings.manifest(first)
          expect([stub.openings('first'), stub.openings('second')]).toEqual([1, 1])
          const refused = yield* Effect.flip(source.keepRelations(notesLoom, []))
          expect(refused.workspace).toBe(elsewhere)
        }),
      )
    } finally {
      stub.stop()
    }
  })

  it('follows a loom that arrives or leaves, in its own workspace alone', async () => {
    const stub = stubWithBoth()
    const runtime = remote(stub, key)
    try {
      await runtime.runPromise(
        Effect.gen(function* () {
          const source = yield* WorkspaceSource
          const hello = stub.locationOf('first', 'corpus/hello.loom')
          const notesLoom = stub.locationOf('second', 'corpus/notes.loom')
          const added = stub.locationOf('second', 'corpus/added.loom')
          yield* source.open(stub.addressOf('first'))
          yield* source.open(stub.addressOf('second'))
          yield* source.relist(added, true)
          expect(yield* source.corpusOf(notesLoom)).toEqual([notesLoom, added])
          yield* source.relist(notesLoom, false)
          expect(yield* source.corpusOf(added)).toEqual([added])
          expect(yield* source.corpusOf(hello)).toHaveLength(2)
        }),
      )
    } finally {
      stub.stop()
    }
  })

  it('forgets a closed workspace, and opens it afresh with its new manifest', async () => {
    const stub = stubWithBoth()
    const runtime = remote(stub, key)
    try {
      await runtime.runPromise(
        Effect.gen(function* () {
          const source = yield* WorkspaceSource
          const settings = yield* WorkspaceSettings
          const workspace = stub.addressOf('second')
          const notesLoom = stub.locationOf('second', 'corpus/notes.loom')
          yield* settings.manifest(workspace)
          expect((yield* settings.resolve(notesLoom)).primaryLanguage).toBe('python')
          stub.configure('second', { primary: 'typescript' })
          yield* source.close(workspace)
          expect(yield* source.corpusOf(notesLoom)).toEqual([])
          expect((yield* settings.resolve(notesLoom)).primaryLanguage).toBeUndefined()
          yield* settings.manifest(workspace)
          expect((yield* settings.resolve(notesLoom)).primaryLanguage).toBe('typescript')
          expect(yield* source.corpusOf(notesLoom)).toEqual([notesLoom])
          expect(stub.openings('second')).toBe(2)
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
      const workspace = stub.addressOf('first')
      const failure = await runtime.runPromise(
        WorkspaceSource.pipe(Effect.flatMap((source) => Effect.flip(source.open(workspace)))),
      )
      expect(lineOf(wordsOf(failure))).toContain(workspace)
      expect(lineOf(wordsOf(failure))).not.toContain('not-the-key')
    } finally {
      stub.stop()
    }
  })
})

const serverEntry = fileURLToPath(new URL('../src/index.ts', import.meta.url))

const editorOver = (stub: StorageStub, secret: string, workspaces: ReadonlyArray<string>) => {
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== 'LOOM_HOME')),
    LOOM_STORAGE_URL: stub.storage,
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
      workspaceFolders: workspaces.map((name) => ({ uri: stub.addressOf(name), name })),
      capabilities: {
        workspace: { didChangeWatchedFiles: { dynamicRegistration: true }, workspaceFolders: true },
      },
    })
  const added = (name: string): Promise<void> =>
    connection.sendNotification('workspace/didChangeWorkspaceFolders', {
      event: { added: [{ uri: stub.addressOf(name), name }], removed: [] },
    })
  const removed = (name: string): Promise<void> =>
    connection.sendNotification('workspace/didChangeWorkspaceFolders', {
      event: { added: [], removed: [{ uri: stub.addressOf(name), name }] },
    })
  const open = (uri: string, text: string): Promise<void> =>
    connection.sendNotification('textDocument/didOpen', {
      textDocument: { uri, languageId: 'loom', version: 1, text },
    })
  const diagnostics = async (uri: string): Promise<ReadonlyArray<string>> =>
    (
      await connection.sendRequest<{ readonly items: ReadonlyArray<Diagnostic> }>(
        'textDocument/diagnostic',
        { textDocument: { uri } },
      )
    ).items.map((diagnostic) => diagnostic.message)
  const reported = (uri: string, type: FileChangeType): Promise<void> =>
    connection.sendNotification('workspace/didChangeWatchedFiles', { changes: [{ uri, type }] })
  const contents = (workspace?: string): Promise<TableOfContents> =>
    workspace === undefined
      ? connection.sendRequest<TableOfContents>(contentsRequest)
      : connection.sendRequest<TableOfContents>(contentsRequest, { workspace })
  const close = (): void => {
    connection.dispose()
    child.kill()
  }
  return { connection, initialize, added, removed, open, diagnostics, reported, contents, close }
}

const chaptersIn = (contents: TableOfContents): ReadonlyArray<string> =>
  contents.books.flatMap((book) => book.orphans.map((chapter) => chapter.path)).sort()

const eventually = (holds: () => boolean, wait = 10_000): Promise<boolean> =>
  holds() || wait <= 0
    ? Promise.resolve(holds())
    : new Promise((resolve) => setTimeout(() => resolve(eventually(holds, wait - 50)), 50))

const targetOf = (link: Location | LocationLink): string =>
  'targetUri' in link ? link.targetUri : link.uri

describe('LoomServer — workspaces kept in remote storage', () => {
  it('serves a workspace with no folder, and follows a change', async () => {
    const stub = stubWithBoth()
    const editor = editorOver(stub, key, ['first'])
    try {
      await editor.initialize()
      await editor.connection.sendNotification('initialized', {})
      const hello = stub.locationOf('first', 'corpus/hello.loom')
      const greetingUri = stub.locationOf('first', 'corpus/greeting.loom')
      await editor.open(hello, program)
      expect(await editor.diagnostics(hello)).toEqual([])
      const position = { line: 4, character: 5 }
      const links = await editor.connection.sendRequest<ReadonlyArray<Location | LocationLink>>(
        'textDocument/definition',
        { textDocument: { uri: hello }, position },
      )
      expect(links.map(targetOf)).toEqual([greetingUri])
      const edit = await editor.connection.sendRequest<WorkspaceEdit>('textDocument/rename', {
        textDocument: { uri: hello },
        position,
        newName: 'Saying hi',
      })
      expect(Object.keys(edit.changes ?? {}).sort()).toEqual([greetingUri, hello].sort())
      stub.write('first', 'corpus/greeting.loom', greeting.replace('Saying hello', 'Saying goodbye'))
      await editor.reported(greetingUri, FileChangeType.Changed)
      expect((await editor.diagnostics(hello)).join('\n')).toContain('Saying hello')
    } finally {
      editor.close()
      stub.stop()
    }
  }, 30_000)

  it('answers the books of each workspace the editor opened', async () => {
    const stub = stubWithBoth()
    const editor = editorOver(stub, key, ['first', 'second'])
    try {
      await editor.initialize()
      await editor.connection.sendNotification('initialized', {})
      const firstChapters = [
        stub.locationOf('first', 'corpus/greeting.loom'),
        stub.locationOf('first', 'corpus/hello.loom'),
      ].sort()
      expect(chaptersIn(await editor.contents(stub.addressOf('first')))).toEqual(firstChapters)
      expect(chaptersIn(await editor.contents(stub.addressOf('second')))).toEqual([
        stub.locationOf('second', 'corpus/notes.loom'),
      ])
      expect(chaptersIn(await editor.contents())).toEqual(firstChapters)
    } finally {
      editor.close()
      stub.stop()
    }
  }, 30_000)

  it('opens a workspace the editor adds while the server runs', async () => {
    const stub = stubWithBoth()
    const editor = editorOver(stub, key, ['first'])
    try {
      await editor.initialize()
      await editor.connection.sendNotification('initialized', {})
      expect(stub.openings('second')).toBe(0)
      await editor.added('second')
      expect(await eventually(() => stub.openings('second') > 0)).toBe(true)
      expect(chaptersIn(await editor.contents(stub.addressOf('second')))).toEqual([
        stub.locationOf('second', 'corpus/notes.loom'),
      ])
    } finally {
      editor.close()
      stub.stop()
    }
  }, 30_000)

  it('opens a workspace afresh once its folder is removed or its configuration changes', async () => {
    const stub = stubWithBoth()
    const editor = editorOver(stub, key, ['first', 'second'])
    try {
      await editor.initialize()
      await editor.connection.sendNotification('initialized', {})
      const second = stub.addressOf('second')
      const first = stub.addressOf('first')
      const notesLoom = stub.locationOf('second', 'corpus/notes.loom')
      expect(chaptersIn(await editor.contents(second))).toEqual([notesLoom])
      const secondOpened = stub.openings('second')
      await editor.removed('second')
      expect(chaptersIn(await editor.contents(second))).toEqual([notesLoom])
      expect(stub.openings('second')).toBeGreaterThan(secondOpened)
      const firstOpened = stub.openings('first')
      stub.configure('first', { primary: 'typescript', width: 80 })
      await editor.reported(`${first}/.loom/config.yaml`, FileChangeType.Changed)
      expect(chaptersIn(await editor.contents(first))).toHaveLength(2)
      expect(stub.openings('first')).toBeGreaterThan(firstOpened)
    } finally {
      editor.close()
      stub.stop()
    }
  }, 30_000)

  it('builds an open loom again under the configuration its workspace has now', async () => {
    const stub = storageStub(key, [firstWith([['corpus/hello.loom', program]])])
    const editor = editorOver(stub, key, ['first'])
    try {
      await editor.initialize()
      await editor.connection.sendNotification('initialized', {})
      const workspace = stub.addressOf('first')
      const hello = stub.locationOf('first', 'corpus/hello.loom')
      await editor.open(hello, program)
      expect((await editor.diagnostics(hello)).join('\n')).toContain('Saying hello')
      stub.configure('first', { primary: 'typescript', anchor: { open: '<<', close: '>>' } })
      await editor.reported(`${workspace}/.loom/config.yaml`, FileChangeType.Changed)
      expect((await editor.diagnostics(hello)).join('\n')).not.toContain('Saying hello')
    } finally {
      editor.close()
      stub.stop()
    }
  }, 30_000)

  it('serves the workspaces it can read, and refuses only a home it cannot', async () => {
    const stub = stubWithBoth()
    const served = editorOver(stub, key, ['first', 'missing'])
    const refused = editorOver(stub, key, ['missing', 'first'])
    try {
      await served.initialize()
      await served.connection.sendNotification('initialized', {})
      expect(chaptersIn(await served.contents(stub.addressOf('first')))).toHaveLength(2)
      const failure = await refused.initialize().then(
        () => 'accepted',
        (error: Error) => error.message,
      )
      expect(failure).toContain(stub.addressOf('missing'))
    } finally {
      served.close()
      refused.close()
      stub.stop()
    }
  }, 30_000)

  it('follows a loom written and deleted, without fetching its workspace again', async () => {
    const stub = storageStub(key, [firstWith([['corpus/hello.loom', program]])])
    const editor = editorOver(stub, key, ['first'])
    try {
      await editor.initialize()
      await editor.connection.sendNotification('initialized', {})
      const workspace = stub.addressOf('first')
      const hello = stub.locationOf('first', 'corpus/hello.loom')
      const greetingUri = stub.locationOf('first', 'corpus/greeting.loom')
      await editor.open(hello, program)
      expect((await editor.diagnostics(hello)).join('\n')).toContain('Saying hello')
      expect(chaptersIn(await editor.contents(workspace))).toEqual([hello])
      const opened = stub.openings('first')
      stub.write('first', 'corpus/greeting.loom', greeting)
      await editor.reported(greetingUri, FileChangeType.Created)
      expect(chaptersIn(await editor.contents(workspace))).toEqual([greetingUri, hello].sort())
      expect(await editor.diagnostics(hello)).toEqual([])
      stub.remove('first', 'corpus/greeting.loom')
      await editor.reported(greetingUri, FileChangeType.Deleted)
      expect(chaptersIn(await editor.contents(workspace))).toEqual([hello])
      expect((await editor.diagnostics(hello)).join('\n')).toContain('Saying hello')
      expect(stub.openings('first')).toBe(opened)
    } finally {
      editor.close()
      stub.stop()
    }
  }, 30_000)

  it('fails the initialize request on a wrong key, without naming the key', async () => {
    const stub = stubWithBoth()
    const editor = editorOver(stub, 'not-the-key', ['first'])
    try {
      const failure = await editor.initialize().then(
        () => 'accepted',
        (error: Error) => error.message,
      )
      expect(failure).toContain(stub.addressOf('first'))
      expect(failure).not.toContain('not-the-key')
    } finally {
      editor.close()
      stub.stop()
    }
  }, 30_000)
})
