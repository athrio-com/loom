import { describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { LanguageServerFailed, spawnLanguageServer } from '../src/LanguageServerProcess'
import { settled, standInServer } from './StandInServer'

describe('LanguageServerProcess keeps files open and sends requests in order', () => {
  it('opens, changes and closes files, and sends a request after them', async () => {
    const stand = standInServer()
    const server = spawnLanguageServer(stand.command, [], stand.folder, 'typescript', {})
    server.keepOpen([{ path: join(stand.folder, 'a.ts'), text: 'one' }])
    server.keepOpen([
      { path: join(stand.folder, 'a.ts'), text: 'two' },
      { path: join(stand.folder, 'b.ts'), text: 'three' },
    ])
    server.keepOpen([{ path: join(stand.folder, 'b.ts'), text: 'three' }])
    const hover = await server.request<{ readonly contents: string }>('textDocument/hover', {
      textDocument: { uri: `file://${join(stand.folder, 'b.ts')}` },
      position: { line: 0, character: 0 },
    })
    expect(hover.contents).toBe('stand-in')
    expect(stand.lines()).toEqual([
      'started',
      'initialize',
      'initialized',
      'textDocument/didOpen a.ts v1',
      'textDocument/didOpen b.ts v1',
      'textDocument/didChange a.ts v2',
      'textDocument/didClose a.ts',
      'textDocument/hover b.ts',
    ])
    server.dispose()
  })
})

describe('LanguageServerProcess never takes the host down when a server cannot start', () => {
  const unstartable = async (command: string, folder: string) => {
    const server = spawnLanguageServer(command, [], folder, 'typescript', {})
    server.keepOpen([{ path: join(folder, 'a.ts'), text: 'one' }])
    const failure = await server.request('textDocument/hover', {}).then(
      () => undefined,
      (error: unknown) => error,
    )
    await settled()
    return { failure, alive: server.alive() }
  }

  it('reports a command that does not exist', async () => {
    const stand = standInServer()
    const { failure, alive } = await unstartable(join(stand.folder, 'missing'), stand.folder)
    expect(failure).toBeInstanceOf(LanguageServerFailed)
    expect(alive).toBe(false)
  })

  it('reports a file that cannot be executed', async () => {
    const stand = standInServer()
    const plain = join(stand.folder, 'plain')
    writeFileSync(plain, 'not a program')
    const { failure, alive } = await unstartable(plain, stand.folder)
    expect(failure).toBeInstanceOf(LanguageServerFailed)
    expect(alive).toBe(false)
  })

  it('reports a folder that does not exist', async () => {
    const stand = standInServer()
    const { failure, alive } = await unstartable(stand.command, join(stand.folder, 'gone'))
    expect(failure).toBeInstanceOf(LanguageServerFailed)
    expect(alive).toBe(false)
  })
})

describe('LanguageServerProcess shuts a server down once', () => {
  it('stops the process, and a second dispose does nothing', async () => {
    const stand = standInServer()
    const server = spawnLanguageServer(stand.command, [], stand.folder, 'typescript', {})
    await server.request('textDocument/hover', {})
    server.dispose()
    server.dispose()
    await settled()
    expect(server.alive()).toBe(false)
    expect(stand.lines().filter((line) => line === 'shutdown')).toEqual(['shutdown'])
  })
})
