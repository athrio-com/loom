import { chmodSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface StandIn {
  readonly command: string
  readonly log: string
  readonly folder: string
  readonly lines: () => ReadonlyArray<string>
}

const standInSource = (log: string): string => `#!/usr/bin/env bun
const { appendFileSync } = require('node:fs')
const log = (line) => appendFileSync(${JSON.stringify(log)}, line + '\\n')
log('started ' + process.pid)
let buffer = Buffer.alloc(0)
const write = (message) => {
  const body = JSON.stringify({ jsonrpc: '2.0', ...message })
  process.stdout.write('Content-Length: ' + Buffer.byteLength(body) + '\\r\\n\\r\\n' + body)
}
const reply = (id, result) => write({ id, result })
const handle = (message) => {
  const uri = message.params?.textDocument?.uri ?? ''
  const version = message.params?.textDocument?.version
  log(message.method + (uri ? ' ' + uri.split('/').pop() : '') + (version ? ' v' + version : ''))
  const crash = () => {
    process.stderr.write('goroutine 1 [running]:\\npanic: stand-in crashed on ' + uri.split('/').pop() + '\\n\\tmain.go:1\\n')
    process.exit(1)
  }
  if (uri.includes('crash') && message.method !== 'textDocument/didClose') return crash()
  if (uri.includes('boom') && message.method === 'textDocument/hover') return crash()
  if (uri.includes('garble') && message.method === 'textDocument/hover') {
    return process.stdout.write('Content-Length: 9\\r\\n\\r\\nnot json!')
  }
  if (message.id === undefined) return
  if (uri.includes('refuse') && message.method === 'textDocument/hover') {
    return write({ id: message.id, error: { code: -32803, message: 'no project here' } })
  }
  if (message.method === 'initialize' && process.argv.includes('--refuse')) {
    return write({ id: message.id, error: { code: -32603, message: 'cannot read tsconfig.json' } })
  }
  if (message.method === 'initialize') return reply(message.id, { capabilities: {} })
  if (uri.includes('slow') && message.method === 'textDocument/hover') {
    return setTimeout(() => {
      log('answered ' + uri.split('/').pop())
      reply(message.id, { contents: 'stand-in' })
    }, 300)
  }
  if (message.method === 'textDocument/hover') return reply(message.id, { contents: 'stand-in' })
  if (message.method === 'textDocument/diagnostic') return reply(message.id, { kind: 'full', items: [] })
  return reply(message.id, null)
}
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk])
  for (;;) {
    const end = buffer.indexOf('\\r\\n\\r\\n')
    if (end < 0) return
    const length = Number(/Content-Length: (\\d+)/i.exec(buffer.subarray(0, end).toString())[1])
    if (buffer.length < end + 4 + length) return
    const body = buffer.subarray(end + 4, end + 4 + length).toString()
    buffer = buffer.subarray(end + 4 + length)
    handle(JSON.parse(body))
  }
})
`

export const standInServer = (): StandIn => {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'loom-stand-in-')))
  const command = join(folder, 'stand-in-server')
  const log = join(folder, 'log')
  writeFileSync(log, '')
  writeFileSync(command, standInSource(log))
  chmodSync(command, 0o755)
  return {
    command,
    log,
    folder,
    lines: () => readFileSync(log, 'utf8').split('\n').filter((line) => line !== ''),
  }
}

export const settled = (ms = 300): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export const startedIn = (lines: ReadonlyArray<string>): ReadonlyArray<number> =>
  lines.filter((line) => line.startsWith('started ')).map((line) => Number(line.split(' ')[1]))

export const running = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
