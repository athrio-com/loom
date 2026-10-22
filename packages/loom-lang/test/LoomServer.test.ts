import { describe, expect, it } from 'bun:test'
import {
  createMessageConnection,
  type Diagnostic,
  FileChangeType,
  StreamMessageReader,
  StreamMessageWriter,
  type TextEdit,
} from '@volar/language-server/node'
import { Array, Cache, Effect, Ref, Semaphore } from 'effect'
import type { LanguageServer, LanguageServerProject, LanguageServicePlugin } from '@volar/language-server/node'
import { URI } from 'vscode-uri'
import { closeOf, refreshProject, workspaceProject } from '../src/LoomServer'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { servicePackage, serviceVersion } from '@athrio/loom-lang-services/LoomStore'
import { runtimeKey } from '@athrio/loom-lang-services/Runtime'

const lines = (...rows: ReadonlyArray<string>): string => `${rows.join('\n')}\n`

const loomOf = (code: string): string =>
  lines('---', 'Language: TypeScript', '---', '', '# Answer', '', '=>', '', code)

const standIn = (formats: boolean): string =>
  lines(
    `const { Effect } = globalThis.${runtimeKey}.modules.effect`,
    'export default {',
    "  id: 'typescript',",
    "  displayName: 'TypeScript',",
    "  extensions: ['.ts'],",
    '  plugins: () => Effect.succeed([]),',
    ...(formats
      ? ["  format: (request) => Effect.succeed(request.code.replaceAll('  ', ' ')),"]
      : []),
    '}',
  )

const activated = lines('languages:', '  typescript: {}')

const inactive = lines('languages: {}')

const install = (root: string, service: string): void => {
  const store = join(root, '.loom', 'services', 'node_modules', servicePackage('typescript'))
  mkdirSync(store, { recursive: true })
  writeFileSync(
    join(store, 'package.json'),
    JSON.stringify({
      name: servicePackage('typescript'),
      version: serviceVersion,
      type: 'module',
      main: 'index.js',
    }),
  )
  writeFileSync(join(store, 'index.js'), service)
}

const configure = (root: string, config: string): void => {
  mkdirSync(join(root, '.loom'), { recursive: true })
  writeFileSync(join(root, '.loom', 'config.yaml'), config)
}

const loomAt = (root: string): string => {
  mkdirSync(join(root, 'corpus'), { recursive: true })
  const loom = join(root, 'corpus', 'answer.loom')
  writeFileSync(loom, loomOf('const  answer  =  42'))
  return loom
}

const workspaceAt = (root: string, service: string): string => {
  install(root, service)
  configure(root, activated)
  return loomAt(root)
}

const serverEntry = fileURLToPath(new URL('../src/index.ts', import.meta.url))

const tsdk = dirname(createRequire(import.meta.url).resolve('typescript/lib/typescript.js'))

const editorAt = async (folder: string) => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'LOOM_HOME'))
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
  await connection.sendRequest('initialize', {
    processId: process.pid,
    rootUri: pathToFileURL(folder).href,
    workspaceFolders: [{ uri: pathToFileURL(folder).href, name: 'outer' }],
    capabilities: { workspace: { didChangeWatchedFiles: { dynamicRegistration: true } } },
    initializationOptions: { typescript: { tsdk } },
  })
  await connection.sendNotification('initialized', {})
  const open = (path: string): Promise<void> =>
    connection.sendNotification('textDocument/didOpen', {
      textDocument: {
        uri: pathToFileURL(path).href,
        languageId: 'loom',
        version: 1,
        text: readFileSync(path, 'utf8'),
      },
    })
  const edit = (path: string, text: string): Promise<void> =>
    connection.sendNotification('textDocument/didChange', {
      textDocument: { uri: pathToFileURL(path).href, version: Date.now() },
      contentChanges: [{ text }],
    })
  const format = async (path: string): Promise<ReadonlyArray<TextEdit>> =>
    (await connection.sendRequest<TextEdit[] | null>('textDocument/formatting', {
      textDocument: { uri: pathToFileURL(path).href },
      options: { tabSize: 2, insertSpaces: true },
    })) ?? []
  const diagnostics = async (path: string): Promise<ReadonlyArray<string>> =>
    Array.map(
      (
        await connection.sendRequest<{ readonly items: ReadonlyArray<Diagnostic> }>(
          'textDocument/diagnostic',
          { textDocument: { uri: pathToFileURL(path).href } },
        )
      ).items,
      (diagnostic) => diagnostic.message,
    )
  const shut = (path: string): Promise<void> =>
    connection.sendNotification('textDocument/didClose', {
      textDocument: { uri: pathToFileURL(path).href },
    })
  const changed = (path: string, type: FileChangeType = FileChangeType.Changed): Promise<void> =>
    connection.sendNotification('workspace/didChangeWatchedFiles', {
      changes: [{ uri: pathToFileURL(path).href, type }],
    })
  const close = (): void => {
    connection.dispose()
    child.kill()
  }
  return { open, edit, shut, format, diagnostics, changed, close }
}

const texts = (edits: ReadonlyArray<TextEdit>): ReadonlyArray<string> =>
  Array.map(edits, (edit) => edit.newText)

describe('LoomServer — a loom in a nested workspace', () => {
  it('is formatted by the services of its own workspace', async () => {
    const outer = realpathSync(mkdtempSync(join(tmpdir(), 'loom-server-')))
    const outerLoom = workspaceAt(outer, standIn(false))
    const nestedLoom = workspaceAt(join(outer, 'nested'), standIn(true))
    const editor = await editorAt(outer)
    try {
      await editor.open(outerLoom)
      await editor.open(nestedLoom)
      expect(await editor.format(outerLoom)).toEqual([])
      expect(texts(await editor.format(nestedLoom))).toEqual([loomOf('const answer = 42')])
    } finally {
      editor.close()
    }
  }, 30_000)

  it('is served by a language its workspace activates while the server runs', async () => {
    const outer = realpathSync(mkdtempSync(join(tmpdir(), 'loom-server-')))
    workspaceAt(outer, standIn(false))
    const nested = join(outer, 'nested')
    configure(nested, inactive)
    const nestedLoom = loomAt(nested)
    const editor = await editorAt(outer)
    try {
      await editor.open(nestedLoom)
      expect(await editor.format(nestedLoom)).toEqual([])
      install(nested, standIn(true))
      configure(nested, activated)
      await editor.changed(join(nested, '.loom', 'config.yaml'))
      expect(texts(await editor.format(nestedLoom))).toEqual([loomOf('const answer = 42')])
    } finally {
      editor.close()
    }
  }, 30_000)
})

const chapterAt = (root: string, name: string, text: string): string => {
  mkdirSync(join(root, 'corpus'), { recursive: true })
  const path = join(root, 'corpus', name)
  writeFileSync(path, text)
  return path
}

const chapter = (title: string, code: string): string =>
  lines('---', 'Language: TypeScript', '---', '', `# ${title}`, '', '=>', '', code)

const anchor = (name: string): string => `::${'['}${name}]`

const checking = (loom: string, counted = false): string =>
  lines(
    `const { Effect } = globalThis.${runtimeKey}.modules.effect`,
    'let reported = 0',
    `const { Composition } = globalThis.${runtimeKey}.modules['@athrio/loom-lang-services/LanguageService']`,
    'const composed = (composition) =>',
    `  composition.rootsFor(${JSON.stringify(loom)}).map((file) => file.content.trim()).sort().join(' | ')`,
    'export default {',
    "  id: 'typescript',",
    "  displayName: 'TypeScript',",
    "  extensions: ['.ts'],",
    '  plugins: () => Effect.gen(function* () {',
    '    const composition = yield* Composition',
    '    return [{',
    "      name: 'checking',",
    '      capabilities: { diagnosticProvider: { interFileDependencies: false, workspaceDiagnostics: false } },',
    '      create: () => ({',
    "        provideDiagnostics: (document) => document.languageId === 'typescript'",
    `          ? [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: composed(composition)${counted ? " + ' #' + ++reported" : ''} }]`,
    '          : [],',
    '      }),',
    '    }]',
    '  }),',
    '}',
  )

describe('LoomServer — a chapter that changes on disk', () => {
  it('answers an open chapter from the text a closed one holds now', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'loom-server-')))
    configure(root, inactive)
    const opened = chapterAt(root, 'main.loom', chapter('Main', `${anchor('Answer')}(answer.loom)`))
    const closed = chapterAt(root, 'answer.loom', chapter('Answer', 'const answer = 42'))
    const editor = await editorAt(root)
    try {
      await editor.open(opened)
      expect(await editor.diagnostics(opened)).toEqual([])
      chapterAt(root, 'answer.loom', chapter('Question', 'const answer = 42'))
      await editor.changed(closed)
      expect(await editor.diagnostics(opened)).toEqual([
        `Unresolved anchor: no section named \`Answer\`.`,
      ])
    } finally {
      editor.close()
    }
  }, 30_000)

  it('resolves an anchor into a chapter created on disk', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'loom-server-')))
    configure(root, inactive)
    const opened = chapterAt(root, 'main.loom', chapter('Main', `${anchor('Answer')}(answer.loom)`))
    const editor = await editorAt(root)
    try {
      await editor.open(opened)
      expect(await editor.diagnostics(opened)).toEqual([
        `Unresolved anchor: no section named \`Answer\`.`,
      ])
      const created = chapterAt(root, 'answer.loom', chapter('Answer', 'const answer = 42'))
      await editor.changed(created, FileChangeType.Created)
      expect(await editor.diagnostics(opened)).toEqual([])
    } finally {
      editor.close()
    }
  }, 30_000)

  it('fails an anchor into a chapter deleted from disk', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'loom-server-')))
    configure(root, inactive)
    const opened = chapterAt(root, 'main.loom', chapter('Main', `${anchor('Answer')}(answer.loom)`))
    const deleted = chapterAt(root, 'answer.loom', chapter('Answer', 'const answer = 42'))
    const editor = await editorAt(root)
    try {
      await editor.open(opened)
      expect(await editor.diagnostics(opened)).toEqual([])
      rmSync(deleted)
      await editor.changed(deleted, FileChangeType.Deleted)
      expect(await editor.diagnostics(opened)).toEqual([
        `Unresolved anchor: no section named \`Answer\`.`,
      ])
    } finally {
      editor.close()
    }
  }, 30_000)

  it('checks an open chapter again, keeping the unsaved text of the others', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'loom-server-')))
    const main = join(root, 'corpus', 'main.loom')
    install(root, checking(main))
    configure(root, activated)
    chapterAt(root, 'main.loom', chapter('Main {Tangle}[main.ts]', 'const main = 1'))
    const note = chapterAt(root, 'note.loom', chapter('Note {Tangle}[note.ts]', "const note = 'saved'"))
    const closed = chapterAt(root, 'answer.loom', chapter('Answer {Tangle}[answer.ts]', 'const answer = 42'))
    const editor = await editorAt(root)
    try {
      await editor.open(main)
      await editor.open(note)
      await editor.edit(note, chapter('Note {Tangle}[note.ts]', "const note = 'unsaved'"))
      expect(await editor.diagnostics(note)).toEqual([
        "const answer = 42 | const main = 1 | const note = 'unsaved'",
      ])
      expect(await editor.diagnostics(main)).toEqual([
        "const answer = 42 | const main = 1 | const note = 'unsaved'",
      ])
      chapterAt(root, 'answer.loom', chapter('Answer {Tangle}[answer.ts]', 'const answer = 43'))
      await editor.changed(closed)
      expect(await editor.diagnostics(main)).toEqual([
        "const answer = 43 | const main = 1 | const note = 'unsaved'",
      ])
    } finally {
      editor.close()
    }
  }, 30_000)

  it('composes the saved text of a chapter closed without saving', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'loom-server-')))
    const main = join(root, 'corpus', 'main.loom')
    install(root, checking(main))
    configure(root, activated)
    chapterAt(root, 'main.loom', chapter('Main {Tangle}[main.ts]', 'const main = 1'))
    const note = chapterAt(root, 'note.loom', chapter('Note {Tangle}[note.ts]', "const note = 'saved'"))
    const editor = await editorAt(root)
    try {
      await editor.open(main)
      await editor.open(note)
      await editor.edit(note, chapter('Note {Tangle}[note.ts]', "const note = 'unsaved'"))
      expect(await editor.diagnostics(note)).toEqual(["const main = 1 | const note = 'unsaved'"])
      expect(await editor.diagnostics(main)).toEqual(["const main = 1 | const note = 'unsaved'"])
      await editor.shut(note)
      expect(await editor.diagnostics(main)).toEqual(["const main = 1 | const note = 'saved'"])
    } finally {
      editor.close()
    }
  }, 30_000)
})

describe('LoomServer — an edit that reaches other open chapters', () => {
  it('resolves an anchor renamed across two open chapters before either is saved', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'loom-server-')))
    configure(root, inactive)
    const opened = chapterAt(root, 'main.loom', chapter('Main', `${anchor('Answer')}(answer.loom)`))
    const answer = chapterAt(root, 'answer.loom', chapter('Answer', 'const answer = 42'))
    const editor = await editorAt(root)
    try {
      await editor.open(opened)
      await editor.open(answer)
      expect(await editor.diagnostics(opened)).toEqual([])
      await editor.edit(answer, chapter('Question', 'const answer = 42'))
      await editor.edit(opened, chapter('Main', `${anchor('Question')}(answer.loom)`))
      expect(await editor.diagnostics(opened)).toEqual([])
    } finally {
      editor.close()
    }
  }, 30_000)

  it('checks an open chapter against the unsaved code of another', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'loom-server-')))
    const main = join(root, 'corpus', 'main.loom')
    install(root, checking(main))
    configure(root, activated)
    chapterAt(root, 'main.loom', chapter('Main {Tangle}[main.ts]', 'const main = 1'))
    const note = chapterAt(root, 'note.loom', chapter('Note {Tangle}[note.ts]', "const note = 'saved'"))
    const editor = await editorAt(root)
    try {
      await editor.open(main)
      await editor.open(note)
      expect(await editor.diagnostics(main)).toEqual(["const main = 1 | const note = 'saved'"])
      await editor.edit(note, chapter('Note {Tangle}[note.ts]', "const note = 'unsaved'"))
      expect(await editor.diagnostics(main)).toEqual(["const main = 1 | const note = 'unsaved'"])
    } finally {
      editor.close()
    }
  }, 30_000)

  it('checks other open chapters again only when an edit changes what they read', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'loom-server-')))
    const main = join(root, 'corpus', 'main.loom')
    install(root, checking(main, true))
    configure(root, activated)
    chapterAt(root, 'main.loom', chapter('Main {Tangle}[main.ts]', 'const main = 1'))
    const note = chapterAt(root, 'note.loom', chapter('Note {Tangle}[note.ts]', "const note = 'saved'"))
    const editor = await editorAt(root)
    try {
      await editor.open(main)
      await editor.open(note)
      expect(await editor.diagnostics(main)).toEqual(["const main = 1 | const note = 'saved' #1"])
      await editor.edit(
        note,
        chapter('Note {Tangle}[note.ts]', "const note = 'saved'").replace(
          '[note.ts]\n',
          '[note.ts]\n\nA word of prose.\n',
        ),
      )
      expect(await editor.diagnostics(main)).toEqual(["const main = 1 | const note = 'saved' #1"])
      await editor.edit(note, chapter('Note {Tangle}[note.ts]', "const note = 'edited'"))
      expect(await editor.diagnostics(main)).toEqual(["const main = 1 | const note = 'edited' #2"])
    } finally {
      editor.close()
    }
  }, 30_000)
})

const recording = () => {
  const scripts = new Map<string, { isAssociationDirty?: boolean }>()
  const deleted: Array<string> = []
  const language = {
    scripts: {
      get: (uri: URI) => {
        const script = scripts.get(uri.toString()) ?? {}
        scripts.set(uri.toString(), script)
        return script
      },
      delete: (uri: URI) => {
        deleted.push(uri.toString())
      },
    },
  }
  return { languageService: { context: { language } }, scripts, deleted }
}

const projectOf = (
  answering: ReturnType<typeof recording>,
  other: ReturnType<typeof recording>,
): LanguageServerProject =>
  ({
    setup: () => {},
    reload: () => {},
    getLanguageService: async () => answering.languageService,
    getExistingLanguageServices: async () => [
      answering.languageService,
      other.languageService,
    ],
  }) as unknown as LanguageServerProject

const serverWith = (...open: ReadonlyArray<URI>): LanguageServer =>
  ({
    documents: { all: () => Array.map(open, (uri) => ({ uri: uri.toString() })) },
  }) as unknown as LanguageServer

const home = '/nowhere'

const mainUri = URI.file('/nowhere/corpus/main.loom')

const goneUri = URI.file('/nowhere/corpus/gone.loom')

describe('LoomServer — the pass piece by piece', () => {
  it('marks an open loom where it is answered and forgets a deleted one everywhere', async () => {
    const answering = recording()
    const other = recording()
    await Effect.runPromise(
      refreshProject(serverWith(mainUri), home, home, projectOf(answering, other), [goneUri]),
    )
    expect(answering.scripts.get(mainUri.toString())).toEqual({ isAssociationDirty: true })
    expect(other.scripts.has(mainUri.toString())).toBe(false)
    expect(answering.deleted).toEqual([goneUri.toString()])
    expect(other.deleted).toEqual([goneUri.toString()])
  })

  it('turns a close into the change it amounts to', () => {
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'loom-server-')))
    const saved = chapterAt(folder, 'saved.loom', chapter('Saved', 'const saved = 1'))
    const uri = URI.file(saved)
    const gone = URI.file(join(folder, 'corpus', 'gone.loom'))
    expect(closeOf(uri, chapter('Saved', 'const saved = 1'))).toEqual([])
    expect(closeOf(uri, chapter('Saved', 'const saved = 2'))).toEqual([
      { uri: uri.toString(), type: FileChangeType.Changed },
    ])
    expect(closeOf(gone, chapter('Gone', 'const gone = 1'))).toEqual([
      { uri: gone.toString(), type: FileChangeType.Deleted },
    ])
  })

  it('holds a request back while a reprojection runs', async () => {
    const answering = recording()
    const { services, projects, reprojecting, edited } = await Effect.runPromise(
      Effect.all({
        services: Cache.make({
          capacity: Infinity,
          lookup: (_: string) => Effect.succeed<ReadonlyArray<LanguageServicePlugin>>([]),
        }),
        projects: Cache.make({
          capacity: Infinity,
          lookup: (_: string) => Effect.succeed(projectOf(answering, recording())),
        }),
        reprojecting: Semaphore.make(1),
        edited: Ref.make<ReadonlySet<string>>(new Set()),
      }),
    )
    await Effect.runPromise(reprojecting.take(1))
    const answer = Promise.resolve(
      workspaceProject(serverWith(), home, services, projects, reprojecting, edited).getLanguageService(
        mainUri,
      ),
    )
    const waited = await Promise.race([
      answer.then(() => 'answered'),
      new Promise<string>((resolve) => setTimeout(() => resolve('waiting'), 100)),
    ])
    expect(waited).toBe('waiting')
    await Effect.runPromise(reprojecting.release(1))
    expect<unknown>(await answer).toBe(answering.languageService)
  })
})
