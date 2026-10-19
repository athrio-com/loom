import { describe, expect, it } from 'bun:test'
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type TextEdit,
} from '@volar/language-server/node'
import { Array } from 'effect'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
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

const workspaceAt = (root: string, service: string): string => {
  const store = join(root, '.loom', 'services', 'node_modules', servicePackage('typescript'))
  mkdirSync(store, { recursive: true })
  mkdirSync(join(root, 'corpus'))
  writeFileSync(join(root, '.loom', 'config.yaml'), lines('languages:', '  typescript: {}'))
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
  const loom = join(root, 'corpus', 'answer.loom')
  writeFileSync(loom, loomOf('const  answer  =  42'))
  return loom
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
    capabilities: {},
    initializationOptions: { typescript: { tsdk } },
  })
  await connection.sendNotification('initialized', {})
  const format = async (path: string): Promise<ReadonlyArray<TextEdit>> => {
    const uri = pathToFileURL(path).href
    const text = readFileSync(path, 'utf8')
    await connection.sendNotification('textDocument/didOpen', {
      textDocument: { uri, languageId: 'loom', version: 1, text },
    })
    const edits = await connection.sendRequest<TextEdit[] | null>('textDocument/formatting', {
      textDocument: { uri },
      options: { tabSize: 2, insertSpaces: true },
    })
    return edits ?? []
  }
  const close = (): void => {
    connection.dispose()
    child.kill()
  }
  return { format, close }
}

describe('LoomServer — a loom in a nested workspace', () => {
  it('is formatted by the services of its own workspace', async () => {
    const outer = realpathSync(mkdtempSync(join(tmpdir(), 'loom-server-')))
    const outerLoom = workspaceAt(outer, standIn(false))
    const nestedLoom = workspaceAt(join(outer, 'nested'), standIn(true))
    const editor = await editorAt(outer)
    try {
      expect(await editor.format(outerLoom)).toEqual([])
      expect(Array.map(await editor.format(nestedLoom), (edit) => edit.newText)).toEqual([
        loomOf('const answer = 42'),
      ])
    } finally {
      editor.close()
    }
  }, 30_000)
})
