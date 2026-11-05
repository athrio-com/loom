import { describe, expect, it } from 'bun:test'
import {
  type CodeAction,
  type CompletionList,
  createMessageConnection,
  type Diagnostic,
  FileChangeType,
  type InlayHint,
  StreamMessageReader,
  StreamMessageWriter,
  type TextEdit,
} from '@volar/language-server/node'
import { Array, Cache, Effect, Layer, Ref, Result, Semaphore } from 'effect'
import { LoomConfig } from '@athrio/loom-config/LoomConfig'
import { DocumentSource, LoomCompiler } from '../src/LoomCompiler'
import { FileSystemSettings } from '../src/WorkspaceSettings'
import { LoomDiskCache } from '../src/LoomDiskCache'
import { FileSystemSource } from '../src/WorkspaceSource'
import type { LanguageServer, LanguageServerProject, LanguageServicePlugin } from '@volar/language-server/node'
import { URI } from 'vscode-uri'
import {
  classicTypeScript,
  closeOf,
  projectOver,
  rebuildUnder,
  refreshProject,
  workspaceProject,
} from '../src/LoomServer'
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
  const fixes = async (path: string, line: number): Promise<ReadonlyArray<CodeAction>> =>
    (await connection.sendRequest<CodeAction[] | null>('textDocument/codeAction', {
      textDocument: { uri: pathToFileURL(path).href },
      range: { start: { line, character: 0 }, end: { line: line + 1, character: 0 } },
      context: { diagnostics: [] },
    })) ?? []
  const hints = async (
    path: string,
  ): Promise<ReadonlyArray<{ readonly position: unknown; readonly label: unknown }>> =>
    Array.map(
      (await connection.sendRequest<InlayHint[] | null>('textDocument/inlayHint', {
        textDocument: { uri: pathToFileURL(path).href },
        range: { start: { line: 0, character: 0 }, end: { line: 10_000, character: 0 } },
      })) ?? [],
      (hint) => ({ position: hint.position, label: hint.label }),
    )
  const completions = async (
    path: string,
    line: number,
    character: number,
  ): Promise<ReadonlyArray<{ readonly label: unknown; readonly textEdit: unknown }>> =>
    Array.map(
      (
        (await connection.sendRequest<CompletionList | null>('textDocument/completion', {
          textDocument: { uri: pathToFileURL(path).href },
          position: { line, character },
        })) ?? { items: [] }
      ).items,
      (item) => ({ label: item.label, textEdit: item.textEdit }),
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
  return { open, edit, shut, format, diagnostics, fixes, hints, completions, changed, close }
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
    'const reported = new Map()',
    `const { Composition } = globalThis.${runtimeKey}.modules['@athrio/loom-lang-services/LanguageService']`,
    'const count = (uri) => reported.set(uri, (reported.get(uri) ?? 0) + 1).get(uri)',
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
    `          ? [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: composed(composition)${counted ? " + ' #' + count(document.uri)" : ''} }]`,
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
    const opened = chapterAt(root, 'main.loom', chapter('Main', anchor('Answer')))
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
    const opened = chapterAt(root, 'main.loom', chapter('Main', anchor('Answer')))
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
    const opened = chapterAt(root, 'main.loom', chapter('Main', anchor('Answer')))
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
    chapterAt(root, 'main.loom', chapter('Main [main.ts]', 'const main = 1'))
    const note = chapterAt(root, 'note.loom', chapter('Note [note.ts]', "const note = 'saved'"))
    const closed = chapterAt(root, 'answer.loom', chapter('Answer [answer.ts]', 'const answer = 42'))
    const editor = await editorAt(root)
    try {
      await editor.open(main)
      await editor.open(note)
      await editor.edit(note, chapter('Note [note.ts]', "const note = 'unsaved'"))
      expect(await editor.diagnostics(note)).toEqual([
        "const answer = 42 | const main = 1 | const note = 'unsaved'",
      ])
      expect(await editor.diagnostics(main)).toEqual([
        "const answer = 42 | const main = 1 | const note = 'unsaved'",
      ])
      chapterAt(root, 'answer.loom', chapter('Answer [answer.ts]', 'const answer = 43'))
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
    chapterAt(root, 'main.loom', chapter('Main [main.ts]', 'const main = 1'))
    const note = chapterAt(root, 'note.loom', chapter('Note [note.ts]', "const note = 'saved'"))
    const editor = await editorAt(root)
    try {
      await editor.open(main)
      await editor.open(note)
      await editor.edit(note, chapter('Note [note.ts]', "const note = 'unsaved'"))
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
    const opened = chapterAt(root, 'main.loom', chapter('Main', anchor('Answer')))
    const answer = chapterAt(root, 'answer.loom', chapter('Answer', 'const answer = 42'))
    const editor = await editorAt(root)
    try {
      await editor.open(opened)
      await editor.open(answer)
      expect(await editor.diagnostics(opened)).toEqual([])
      await editor.edit(answer, chapter('Question', 'const answer = 42'))
      await editor.edit(opened, chapter('Main', anchor('Question')))
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
    chapterAt(root, 'main.loom', chapter('Main [main.ts]', 'const main = 1'))
    const note = chapterAt(root, 'note.loom', chapter('Note [note.ts]', "const note = 'saved'"))
    const editor = await editorAt(root)
    try {
      await editor.open(main)
      await editor.open(note)
      expect(await editor.diagnostics(main)).toEqual(["const main = 1 | const note = 'saved'"])
      await editor.edit(note, chapter('Note [note.ts]', "const note = 'unsaved'"))
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
    chapterAt(root, 'main.loom', chapter('Main [main.ts]', 'const main = 1'))
    const note = chapterAt(root, 'note.loom', chapter('Note [note.ts]', "const note = 'saved'"))
    const editor = await editorAt(root)
    try {
      await editor.open(main)
      await editor.open(note)
      expect(await editor.diagnostics(main)).toEqual(["const main = 1 | const note = 'saved' #1"])
      await editor.edit(
        note,
        chapter('Note [note.ts]', "const note = 'saved'").replace(
          '[note.ts]\n',
          '[note.ts]\n\nA word of prose.\n',
        ),
      )
      expect(await editor.diagnostics(main)).toEqual(["const main = 1 | const note = 'saved' #1"])
      await editor.edit(note, chapter('Note [note.ts]', "const note = 'edited'"))
      expect(await editor.diagnostics(main)).toEqual(["const main = 1 | const note = 'edited' #2"])
    } finally {
      editor.close()
    }
  }, 30_000)
})

const configuredWith = (answer: number): string =>
  lines('languages:', '  typescript: {}', 'variables:', `  answer: ${answer}`)

const readingAnswer = lines(
  '---',
  'Language: TypeScript',
  '---',
  '',
  '# Main [main.ts]',
  '',
  '{{ answer = ${answer} }}',
  '',
  '=>',
  '',
  `const main = ${anchor('answer')}`,
)

describe('LoomServer — a configuration that changes', () => {
  it('composes an open chapter under the new configuration, keeping unsaved text', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'loom-server-')))
    const main = join(root, 'corpus', 'main.loom')
    install(root, checking(main))
    configure(root, configuredWith(42))
    chapterAt(root, 'main.loom', readingAnswer)
    const note = chapterAt(root, 'note.loom', chapter('Note [note.ts]', "const note = 'saved'"))
    const editor = await editorAt(root)
    try {
      await editor.open(main)
      await editor.open(note)
      await editor.edit(note, chapter('Note [note.ts]', "const note = 'unsaved'"))
      expect(await editor.diagnostics(main)).toEqual(["const main = 42 | const note = 'unsaved'"])
      configure(root, configuredWith(43))
      await editor.changed(join(root, '.loom', 'config.yaml'))
      expect(await editor.diagnostics(main)).toEqual(["const main = 43 | const note = 'unsaved'"])
    } finally {
      editor.close()
    }
  }, 30_000)
})

const creating = lines(
  `const { Effect } = globalThis.${runtimeKey}.modules.effect`,
  'const created = { count: 0 }',
  'export default {',
  "  id: 'typescript',",
  "  displayName: 'TypeScript',",
  "  extensions: ['.ts'],",
  '  plugins: () => Effect.succeed([{',
  "    name: 'creating',",
  '    capabilities: { diagnosticProvider: { interFileDependencies: false, workspaceDiagnostics: false } },',
  '    create: () => {',
  '      created.count += 1',
  '      const mine = created.count',
  '      return {',
  "        provideDiagnostics: (document) => document.languageId === 'typescript'",
  "          ? [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: 'created ' + mine }]",
  '          : [],',
  '      }',
  '    },',
  '  }]),',
  '}',
)

describe('LoomServer — a compiler setting that changes', () => {
  it('builds the services afresh when a tsconfig.json or a package.json changes', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'loom-server-')))
    install(root, creating)
    configure(root, activated)
    const main = chapterAt(root, 'main.loom', chapter('Main [main.ts]', 'const main = 1'))
    const editor = await editorAt(root)
    try {
      await editor.open(main)
      expect(await editor.diagnostics(main)).toEqual(['created 1'])
      writeFileSync(join(root, 'tsconfig.json'), '{}\n')
      await editor.changed(join(root, 'tsconfig.json'), FileChangeType.Created)
      expect(await editor.diagnostics(main)).toEqual(['created 2'])
      writeFileSync(join(root, 'package.json'), '{}\n')
      await editor.changed(join(root, 'package.json'), FileChangeType.Created)
      expect(await editor.diagnostics(main)).toEqual(['created 3'])
    } finally {
      editor.close()
    }
  }, 30_000)
})

const fakeTypeScript = (folder: string, from: string): void => {
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, 'typescript.js'), `module.exports = { from: ${JSON.stringify(from)} }\n`)
}

const editorCopy = (root: string): string => {
  fakeTypeScript(join(root, 'editor', 'lib'), 'editor')
  return join(root, 'editor', 'lib')
}

const projectAt = (root: string): string => {
  const typescript = join(root, 'project', 'node_modules', 'typescript')
  fakeTypeScript(join(typescript, 'lib'), 'project')
  writeFileSync(join(typescript, 'package.json'), JSON.stringify({ name: 'typescript', version: '6.0.0' }))
  return join(root, 'project')
}

describe('LoomServer — where a TypeScript 6 comes from', () => {
  it('prefers the project\'s copy, then the editor\'s, and loads each once', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'loom-classic-')))
    const tsdk = editorCopy(root)
    const project = projectAt(root)
    const bare = join(root, 'bare')
    mkdirSync(bare)
    const fromOf = (result: ReturnType<ReturnType<typeof classicTypeScript>>): unknown =>
      Result.isSuccess(result) ? (result.success as unknown as { from: string }).from : result.failure
    const withEditor = classicTypeScript({ typescript: { tsdk } })
    expect(fromOf(withEditor(project))).toBe('project')
    expect(fromOf(withEditor(bare))).toBe('editor')
    const first = withEditor(project)
    const again = withEditor(project)
    expect(Result.isSuccess(first) && Result.isSuccess(again) && first.success === again.success).toBe(true)
  })
})

describe('LoomServer — a fix for an ambiguous anchor', () => {
  it('offers the path through each part as a quick fix', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'loom-server-')))
    configure(root, inactive)
    const setup = (part: string, code: string): string =>
      lines(
        '---',
        part,
        'Chapter 1: Setup',
        'Language: TypeScript',
        '---',
        '',
        '# Setup',
        '',
        '=>',
        '',
        code,
      )
    chapterAt(root, 'setup-one.loom', setup('Part I: Saying things', 'const one = 1'))
    chapterAt(root, 'setup-two.loom', setup('Part II: Doing things', 'const two = 2'))
    const main = chapterAt(root, 'main.loom', chapter('Main', anchor('Setup')))
    const editor = await editorAt(root)
    try {
      await editor.open(main)
      const actions = await editor.fixes(main, 8)
      expect(
        actions
          .map((action) => [
            action.title,
            action.kind,
            Object.values(action.edit?.changes ?? {})
              .flat()
              .map((edit) => [edit.newText, edit.range.start.character, edit.range.end.character]),
          ])
          .sort(),
      ).toEqual([
        ['Write the path `Doing things, Setup`', 'quickfix', [['Doing things, Setup', 3, 8]]],
        ['Write the path `Saying things, Setup`', 'quickfix', [['Saying things, Setup', 3, 8]]],
      ])
      expect(
        actions.every((action) =>
          Object.keys(action.edit?.changes ?? {}).every((uri) => uri.endsWith('/main.loom')),
        ),
      ).toBe(true)
    } finally {
      editor.close()
    }
  }, 30_000)
})

describe('LoomServer — the title beside a number', () => {
  it('shows the chapter title after a chapter named by number', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'loom-server-')))
    configure(root, inactive)
    chapterAt(
      root,
      'words.loom',
      lines(
        '---',
        'Part I, Chapter 2: Words',
        'Language: TypeScript',
        '---',
        '',
        '# Words',
        '',
        '## Saying hello',
        '',
        '=>',
        '',
        'const hi = 1',
      ),
    )
    const main = chapterAt(root, 'main.loom', chapter('Main', anchor('Chapter 2, Saying hello')))
    const editor = await editorAt(root)
    try {
      await editor.open(main)
      expect(await editor.hints(main)).toEqual([
        { position: { line: 8, character: 12 }, label: 'Words' },
      ])
    } finally {
      editor.close()
    }
  }, 30_000)
})

describe('LoomServer — a label as it is typed', () => {
  it('offers the label an anchor takes between its braces', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'loom-server-')))
    configure(root, inactive)
    const main = chapterAt(root, 'main.loom', chapter('Main', `${anchor('Greeting')}{To b}`))
    const editor = await editorAt(root)
    try {
      await editor.open(main)
      expect(await editor.completions(main, 8, 17)).toEqual([
        {
          label: 'To be settled',
          textEdit: {
            range: { start: { line: 8, character: 13 }, end: { line: 8, character: 17 } },
            newText: 'To be settled',
          },
        },
        {
          label: 'Reference',
          textEdit: {
            range: { start: { line: 8, character: 13 }, end: { line: 8, character: 17 } },
            newText: 'Reference',
          },
        },
      ])
    } finally {
      editor.close()
    }
  }, 30_000)
})

const declaring = lines(
  `const { Effect } = globalThis.${runtimeKey}.modules.effect`,
  'export default {',
  "  id: 'typescript',",
  "  displayName: 'TypeScript',",
  "  extensions: ['.ts'],",
  '  plugins: () => Effect.succeed([{',
  "    name: 'declaring',",
  '    capabilities: { documentSymbolProvider: true },',
  '    create: () => ({',
  '      provideDocumentSymbols: (document) =>',
  "        document.languageId !== 'typescript'",
  '          ? undefined',
  '          : [...document.getText().matchAll(/const (\\w+)/g)].map((match) => {',
  '              const start = document.positionAt(match.index + 6)',
  '              const end = document.positionAt(match.index + match[0].length)',
  '              return { name: match[1], kind: 13, range: { start, end }, selectionRange: { start, end } }',
  '            }),',
  '    }),',
  '  }]),',
  '}',
)

describe('LoomServer — names a section must provide', () => {
  it('reports each name an anchor expects that its section does not declare', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'loom-server-')))
    install(root, declaring)
    configure(root, activated)
    chapterAt(
      root,
      'greeting.loom',
      lines(
        '---',
        'Part I, Chapter 2: Greeting',
        'Language: TypeScript',
        '---',
        '',
        '# Greeting',
        '',
        '=>',
        '',
        'const greet = (name: string) => name',
      ),
    )
    const main = chapterAt(
      root,
      'main.loom',
      chapter('Main', `${anchor('Greeting')}{provides=[greet, farewell]}`),
    )
    const local = chapterAt(
      root,
      'local.loom',
      lines(
        '---',
        'Language: TypeScript',
        '---',
        '',
        '# Local',
        '',
        '=>',
        '',
        `${anchor('Helper')}{provides=[help, assist]}`,
        '',
        '## Helper',
        '',
        '=>',
        '',
        'const help = 1',
      ),
    )
    const editor = await editorAt(root)
    try {
      await editor.open(main)
      await editor.open(local)
      expect(await editor.diagnostics(main)).toEqual([
        'Missing symbol: `Greeting` declares no `farewell`, which this anchor says it provides.',
      ])
      expect(await editor.diagnostics(local)).toEqual([
        'Missing symbol: `Helper` declares no `assist`, which this anchor says it provides.',
      ])
    } finally {
      editor.close()
    }
  }, 30_000)
})

describe('LoomServer — a name that waits', () => {
  it('clears when an edit declares the section or the chapter it names', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'loom-server-')))
    configure(root, inactive)
    const wordsHead = [
      '---',
      'Part I, Chapter 2: Words',
      'Language: TypeScript',
      '---',
      '',
      '# Words',
    ]
    const words = chapterAt(root, 'words.loom', lines(...wordsHead))
    const main = chapterAt(root, 'main.loom', chapter('Main', anchor('Words, Saying hello')))
    const other = chapterAt(root, 'other.loom', chapter('Other', anchor('A chapter to come')))
    const editor = await editorAt(root)
    try {
      await editor.open(main)
      await editor.open(words)
      await editor.open(other)
      expect(await editor.diagnostics(main)).toEqual([
        'Unresolved anchor: no section named `Words, Saying hello`.',
      ])
      await editor.edit(
        words,
        lines(...wordsHead, '', '## Saying hello', '', '=>', '', 'const hi = 1'),
      )
      expect(await editor.diagnostics(main)).toEqual([])
      expect(await editor.diagnostics(other)).toEqual([
        'Unresolved anchor: no section named `A chapter to come`.',
      ])
      const later = chapterAt(
        root,
        'later.loom',
        lines(
          '---',
          'Part I, Chapter 3: A chapter to come',
          'Language: TypeScript',
          '---',
          '',
          '# A chapter to come',
          '',
          '=>',
          '',
          'const later = 1',
        ),
      )
      await editor.changed(later, FileChangeType.Created)
      expect(await editor.diagnostics(other)).toEqual([])
    } finally {
      editor.close()
    }
  }, 30_000)

  it('offers quick fixes that declare the missing section or mark it to be settled', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'loom-server-')))
    configure(root, inactive)
    const main = chapterAt(root, 'main.loom', chapter('Main', anchor('Saying goodbye')))
    const editor = await editorAt(root)
    try {
      await editor.open(main)
      const actions = await editor.fixes(main, 8)
      expect(
        actions.map((action) => [
          action.title,
          Object.values(action.edit?.changes ?? {})
            .flat()
            .map((edit) => [edit.newText, edit.range.start.line, edit.range.start.character]),
        ]).sort(),
      ).toEqual([
        ['Declare the section `Saying goodbye`', [['\n# Saying goodbye\n', 9, 0]]],
        ['Mark `Saying goodbye` to be settled', [['{To be settled}', 8, 18]]],
      ])
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

const closedEditor = {
  documents: { all: () => [], get: () => undefined },
  workspaceFolders: { all: [] },
  configurations: { get: async () => undefined, onDidChange: () => ({ dispose: () => {} }) },
  fileWatcher: { onDidChangeWatchedFiles: () => ({ dispose: () => {} }) },
} as unknown as LanguageServer

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
    const closed = (loom: URI, text: string) =>
      Effect.runSync(
        closeOf(loom, text).pipe(
          Effect.provide(DocumentSource.layer.pipe(Layer.provideMerge(FileSystemSource))),
        ),
      )
    expect(closed(uri, chapter('Saved', 'const saved = 1'))).toEqual([])
    expect(closed(uri, chapter('Saved', 'const saved = 2'))).toEqual([
      { uri: uri.toString(), type: FileChangeType.Changed },
    ])
    expect(closed(gone, chapter('Gone', 'const gone = 1'))).toEqual([
      { uri: gone.toString(), type: FileChangeType.Deleted },
    ])
  })

  it('notes every open loom a configuration change evicts, nested workspaces included', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'loom-server-')))
    configure(root, inactive)
    configure(join(root, 'nested'), inactive)
    const own = URI.file(join(root, 'corpus', 'main.loom'))
    const nested = URI.file(join(root, 'nested', 'corpus', 'note.loom'))
    const outside = URI.file(join(realpathSync(mkdtempSync(join(tmpdir(), 'loom-other-'))), 'x.loom'))
    const edited = await Effect.runPromise(Ref.make<ReadonlySet<string>>(new Set()))
    await Effect.runPromise(
      rebuildUnder(serverWith(own, nested, outside), edited, `${root}/`).pipe(
        Effect.provide(
          LoomCompiler.layer.pipe(
            Layer.provide(DocumentSource.layer),
            Layer.provide(LoomDiskCache.layer),
            Layer.provideMerge(FileSystemSource),
            Layer.provide(FileSystemSettings),
            Layer.provide(LoomConfig.layer),
          ),
        ),
      ),
    )
    expect([...(await Effect.runPromise(Ref.get(edited)))].sort()).toEqual(
      [own.fsPath, nested.fsPath].sort(),
    )
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

  it('projects a loom the editor has closed from disk, and reads it once', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'loom-server-')))
    configure(root, inactive)
    const text = chapter('Answer', 'const answer = 42')
    const closed = URI.file(chapterAt(root, 'answer.loom', text))
    const languageService = await projectOver(closedEditor, []).getLanguageService(closed)
    const first = languageService.context.language.scripts.get(closed)
    const again = languageService.context.language.scripts.get(closed)
    expect(first?.snapshot.getText(0, first.snapshot.getLength())).toBe(text)
    expect(first?.generated?.root.snapshot.getText(0, text.length)).toBe(text)
    expect(again?.snapshot).toBe(first?.snapshot)
  })
})
