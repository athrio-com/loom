import { describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { LanguageServerFailed, spawnLanguageServer } from '../src/LanguageServerProcess'
import { running, settled, standInServer, startedIn } from './StandInServer'

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
    expect(stand.lines().slice(1)).toEqual([
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
    expect((failure as LanguageServerFailed).message).toContain('could not start')
    expect((failure as LanguageServerFailed).message).toContain('ENOENT')
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
    expect((failure as LanguageServerFailed).message).toContain('working folder')
    expect((failure as LanguageServerFailed).message).toContain('does not exist')
    expect(alive).toBe(false)
  })

  it('reports a server that exits as soon as it starts', async () => {
    const stand = standInServer()
    const quitter = join(stand.folder, 'quitter')
    writeFileSync(quitter, '#!/bin/sh\nexit 3\n', { mode: 0o755 })
    const { failure, alive } = await unstartable(quitter, stand.folder)
    expect(failure).toBeInstanceOf(LanguageServerFailed)
    expect(alive).toBe(false)
  })

  it('stops a server that answers with a message it cannot read', async () => {
    const stand = standInServer()
    const server = spawnLanguageServer(stand.command, [], stand.folder, 'typescript', {})
    const failure = await server
      .request('textDocument/hover', { textDocument: { uri: `file://${join(stand.folder, 'garble.ts')}` } })
      .then(
        () => undefined,
        (error: unknown) => error,
      )
    await settled()
    expect(failure).toBeInstanceOf(LanguageServerFailed)
    expect(server.alive()).toBe(false)
    expect(startedIn(stand.lines()).every((pid) => !running(pid))).toBe(true)
  })
})

describe('LanguageServerProcess tells an error answer from a crash', () => {
  const hoverFailure = async (file: string, args: ReadonlyArray<string> = []) => {
    const stand = standInServer()
    const server = spawnLanguageServer(stand.command, args, stand.folder, 'typescript', {})
    const failure = await server
      .request('textDocument/hover', { textDocument: { uri: `file://${join(stand.folder, file)}` } })
      .then(
        () => undefined,
        (error: unknown) => error as LanguageServerFailed,
      )
    await settled()
    const alive = server.alive()
    server.dispose()
    return { failure, alive }
  }

  it('repeats the words of a server that answered with an error', async () => {
    const { failure, alive } = await hoverFailure('refuse.ts')
    expect(failure?.message).toContain('answered: no project here')
    expect(alive).toBe(true)
  })

  it('repeats the words of a server that refused to start', async () => {
    const { failure, alive } = await hoverFailure('a.ts', ['--refuse'])
    expect(failure?.message).toContain('refused to start: cannot read tsconfig.json')
    expect(alive).toBe(false)
  })

  it('reports a server that crashed mid-request as not running', async () => {
    const { failure, alive } = await hoverFailure('boom.ts')
    expect(failure?.message).toContain('is not running')
    expect(failure?.message).toContain('(exited with code 1)')
    expect(failure?.message).toContain('it last said: panic: stand-in crashed on boom.ts')
    expect(failure?.message).not.toContain('answered')
    expect(alive).toBe(false)
  })

  it('reports the error line of a server that dies the way Node does, not its banner', async () => {
    const { failure } = await hoverFailure('throw.ts')
    expect(failure?.message).toContain('it last said: TypeError: stand-in threw on throw.ts')
  })

  it('reports the newest header, even one written without a line end', async () => {
    const { failure } = await hoverFailure('starve.ts')
    expect(failure?.message).toContain('(exited with code 2)')
    expect(failure?.message).toContain('it last said: fatal error: runtime: out of memory')
  })

  it('sends a request before a document opened after it', async () => {
    const stand = standInServer()
    const server = spawnLanguageServer(stand.command, [], stand.folder, 'typescript', {})
    const hover = server.request('textDocument/hover', {
      textDocument: { uri: `file://${join(stand.folder, 'a.ts')}` },
      position: { line: 0, character: 0 },
    })
    server.keepOpen([{ path: join(stand.folder, 'b.ts'), text: 'b' }])
    await hover
    await settled()
    const lines = stand.lines()
    expect(lines.indexOf('textDocument/hover a.ts')).toBeLessThan(lines.indexOf('textDocument/didOpen b.ts v1'))
    server.dispose()
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

describe('LanguageServerProcess runs under Node', () => {
  const node = spawnSync('node', ['--version']).status === 0

  it.skipIf(!node)('starts a server and gets an answer when Node runs it', () => {
    const stand = standInServer()
    const script = join(stand.folder, 'under-node.ts')
    const bridge = join(import.meta.dir, '..', 'src', 'LanguageServerProcess.ts')
    writeFileSync(
      script,
      `import { spawnLanguageServer } from ${JSON.stringify(bridge)}\n` +
        `const server = spawnLanguageServer(${JSON.stringify(stand.command)}, [], ${JSON.stringify(stand.folder)}, 'typescript', {})\n` +
        `server.request('textDocument/hover', {}).then(\n` +
        `  (hover) => { console.log(JSON.stringify(hover)); server.dispose() },\n` +
        `  (error) => { console.log('failed: ' + error.message); server.dispose() },\n` +
        `)\n`,
    )
    const run = spawnSync('node', [script], { cwd: join(import.meta.dir, '..'), encoding: 'utf8', timeout: 20_000 })
    expect(run.stdout.trim()).toBe(JSON.stringify({ contents: 'stand-in' }))
  })

  it.skipIf(!node)('survives a server that dies while it reads a flood of documents', () => {
    const stand = standInServer()
    const script = join(stand.folder, 'flood.ts')
    const bridge = join(import.meta.dir, '..', 'src', 'LanguageServerProcess.ts')
    writeFileSync(
      script,
      `import { join } from 'node:path'\n` +
        `import { spawnLanguageServer } from ${JSON.stringify(bridge)}\n` +
        `const folder = ${JSON.stringify(stand.folder)}\n` +
        `const server = spawnLanguageServer(${JSON.stringify(stand.command)}, [], folder, 'typescript', {})\n` +
        `const big = '//'.repeat(200_000)\n` +
        `server.keepOpen([\n` +
        `  { path: join(folder, 'crash.ts'), text: 'x' },\n` +
        `  ...Array.from({ length: 40 }, (_, i) => ({ path: join(folder, 'p' + i + '.ts'), text: big })),\n` +
        `])\n` +
        `server.request('textDocument/hover', {}).then(\n` +
        `  () => console.log('answered'),\n` +
        `  (error) => console.log('failed: ' + error.message),\n` +
        `)\n` +
        `setTimeout(() => { console.log('survived'); server.dispose() }, 1500)\n`,
    )
    const run = spawnSync('node', [script], { cwd: join(import.meta.dir, '..'), encoding: 'utf8', timeout: 20_000 })
    expect(run.stdout).toContain('is not running')
    expect(run.stdout).toContain('survived')
    expect(run.status).toBe(0)
  })
})
