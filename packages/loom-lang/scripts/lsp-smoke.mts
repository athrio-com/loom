// Headless proof that the Loom Frame LSP activates over the real protocol.
//
// Spawns the shipped server bundle (the very file the VS Code extension
// launches) with --stdio, drives it like a client, opens checker.loom — whose
// `{{x: Ghost}}` Warp names a missing section — and asserts the frame's tsc
// diagnostic surfaces on the `Ghost` line of the .loom. Then opens a clean
// document and asserts the frame is error-free.

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../../..')

const { StreamMessageReader, StreamMessageWriter, createMessageConnection } =
  await import(
    pathToFileURL(
      resolve(
        repo,
        'node_modules/.pnpm/vscode-jsonrpc@8.2.1/node_modules/vscode-jsonrpc/node.js',
      ),
    ).href
  )
const server = resolve(repo, 'packages/loom-vscode/dist/server.js')
const tsdk = resolve(repo, 'node_modules/typescript/lib')
const fixturesDir = resolve(here, '../test/fixtures')
const checker = resolve(fixturesDir, 'checker.loom')
const checkerText = readFileSync(checker, 'utf8')

const cleanText = `{{lang: TypeScript}}

# Entry [Main]

=>

export const main: number = 1
`

const child = spawn('node', [server, '--stdio'], {
  stdio: ['pipe', 'pipe', 'pipe'],
})
child.stderr.on('data', (b) => process.stderr.write(`  [server] ${b}`))

const conn = createMessageConnection(
  new StreamMessageReader(child.stdout),
  new StreamMessageWriter(child.stdin),
)

const diagsByUri = new Map<string, any[]>()
conn.onNotification('textDocument/publishDiagnostics', (p: any) =>
  diagsByUri.set(p.uri, p.diagnostics),
)
conn.onNotification('window/logMessage', () => {})

// Volar drives the client back: answer its requests so it doesn't stall or crash.
conn.onRequest('workspace/configuration', (p: any) =>
  (p.items ?? []).map(() => null),
)
conn.onRequest('client/registerCapability', () => null)
conn.onRequest('client/unregisterCapability', () => null)
conn.onRequest('window/workDoneProgress/create', () => null)

conn.listen()

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const open = (uri: string, text: string) =>
  conn.sendNotification('textDocument/didOpen', {
    textDocument: { uri, languageId: 'loom', version: 1, text },
  })

let pullCapable = false

const diagnosticsFor = async (uri: string): Promise<any[]> => {
  for (let i = 0; i < 60; i++) {
    if (pullCapable) {
      const report: any = await conn
        .sendRequest('textDocument/diagnostic', {
          textDocument: { uri },
        })
        .catch(() => undefined)
      if (report?.items?.length) return report.items
    }
    if (diagsByUri.get(uri)?.length) return diagsByUri.get(uri)!
    await sleep(250)
  }
  return diagsByUri.get(uri) ?? []
}

const main = async () => {
  const rootUri = pathToFileURL(fixturesDir).toString()
  const init: any = await conn.sendRequest('initialize', {
    processId: process.pid,
    rootUri,
    workspaceFolders: [{ uri: rootUri, name: 'fixtures' }],
    initializationOptions: { typescript: { tsdk } },
    capabilities: {
      textDocument: {
        synchronization: { dynamicRegistration: false },
        publishDiagnostics: {},
        diagnostic: { dynamicRegistration: false },
        hover: { contentFormat: ['plaintext', 'markdown'] },
      },
      workspace: { configuration: true, workspaceFolders: true },
    },
  })
  pullCapable = Boolean(init.capabilities?.diagnosticProvider)
  console.log(
    `initialize ok — diagnosticProvider=${pullCapable}, ` +
      `hoverProvider=${Boolean(init.capabilities?.hoverProvider)}`,
  )
  await conn.sendNotification('initialized', {})

  let failures = 0

  // Negative case: the Ghost Warp must error on its own .loom line.
  const cu = pathToFileURL(checker).toString()
  open(cu, checkerText)
  const cDiags = await diagnosticsFor(cu)
  const ghost = cDiags.find((d) => /Ghost/.test(d.message))
  const ghostLine = checkerText.split('\n').findIndex((l) => l.includes('Ghost'))
  console.log(`\nchecker.loom diagnostics (${cDiags.length}):`)
  for (const d of cDiags)
    console.log(`  line ${d.range.start.line}: ${d.message}`)
  if (ghost && ghost.range.start.line === ghostLine) {
    console.log(`PASS: Ghost error mapped to .loom line ${ghostLine}`)
  } else {
    console.log(
      `FAIL: expected a 'Ghost' diagnostic on line ${ghostLine}, got ${
        ghost ? `line ${ghost.range.start.line}` : 'none'
      }`,
    )
    failures++
  }

  // Positive case: a clean frame must produce no diagnostics.
  const clu = pathToFileURL(resolve(fixturesDir, '__clean__.loom')).toString()
  open(clu, cleanText)
  await sleep(1500)
  const clean = await diagnosticsFor(clu)
  if (clean.length === 0) {
    console.log(`PASS: clean .loom has no frame diagnostics`)
  } else {
    console.log(`FAIL: clean .loom should be error-free, got:`)
    for (const d of clean) console.log(`  line ${d.range.start.line}: ${d.message}`)
    failures++
  }

  // Bonus: hover somewhere on the Ghost line to prove a language feature answers.
  const hover: any = await conn
    .sendRequest('textDocument/hover', {
      textDocument: { uri: cu },
      position: { line: ghostLine, character: 6 },
    })
    .catch((e) => ({ error: String(e) }))
  console.log(`\nhover on Ghost line: ${JSON.stringify(hover?.contents ?? hover)}`)

  // Anchor ⇄ heading: definition, references, and no hover on the heading.
  const navText = `{{lang: TypeScript}}

# Helper

The helper constant.

=>

export const helper = 1

# Bundle {dist/out.ts}

=>

{{Helper}}
`
  const nu = pathToFileURL(resolve(fixturesDir, '__nav__.loom')).toString()
  open(nu, navText)
  await sleep(2000)
  const navLines = navText.split('\n')
  const anchorLine = navLines.findIndex((l) => l.includes('{{Helper}}'))
  const anchorCol = navLines[anchorLine].indexOf('{{Helper}}') + 2
  const headingLine = navLines.findIndex((l) => l === '# Helper')
  const headingCol = navLines[headingLine].indexOf('Helper')
  const lineOf = (d: any) =>
    (d.range ?? d.targetSelectionRange ?? d.targetRange)?.start.line

  // (1) go-to-def on the anchor → the heading, and only the heading.
  const defn: any = await conn
    .sendRequest('textDocument/definition', {
      textDocument: { uri: nu },
      position: { line: anchorLine, character: anchorCol },
    })
    .catch((e) => ({ error: String(e) }))
  const dlocs = Array.isArray(defn) ? defn : defn ? [defn] : []
  console.log(`\ngo-to-def on {{Helper}} → ${JSON.stringify(defn)}`)
  if (dlocs.some((d: any) => lineOf(d) === headingLine) &&
      !dlocs.some((d: any) => lineOf(d) === anchorLine)) {
    console.log(`PASS: definition is the heading (line ${headingLine}), not the anchor`)
  } else {
    console.log(`FAIL: definition lines ${JSON.stringify(dlocs.map(lineOf))}`)
    failures++
  }

  // (2) find-references on the heading → the anchor, never itself.
  const refs: any = await conn
    .sendRequest('textDocument/references', {
      textDocument: { uri: nu },
      position: { line: headingLine, character: headingCol },
      context: { includeDeclaration: false },
    })
    .catch((e) => ({ error: String(e) }))
  const rlocs = Array.isArray(refs) ? refs : []
  const refLines = rlocs.map((d: any) => d.range?.start.line)
  console.log(`references on heading → lines ${JSON.stringify(refLines)}`)
  // The anchor is the reference; the heading line, if present, is the
  // definition (one `const _N` declaration) — the clean def↔reference shape.
  const anchorRefs = refLines.filter((l: number) => l === anchorLine).length
  const headingRefs = refLines.filter((l: number) => l === headingLine).length
  if (anchorRefs === 1 && headingRefs <= 1 && refLines.length <= 2) {
    console.log(`PASS: anchor is the reference; heading is the single definition`)
  } else {
    console.log(`FAIL: expected one anchor reference + at most the definition`)
    failures++
  }

  // (3) hover on the heading → nothing. The heading span is kind `heading`:
  // locate-only, so hover is off and the synthetic `const _N: N` never shows.
  const hh: any = await conn
    .sendRequest('textDocument/hover', {
      textDocument: { uri: nu },
      position: { line: headingLine, character: headingCol },
    })
    .catch((e) => ({ error: String(e) }))
  const hhText = JSON.stringify(hh?.contents ?? hh ?? null)
  console.log(`hover on heading → ${hhText}`)
  if (hh == null) {
    console.log(`PASS: heading carries no hover (no synthetic alias annotation)`)
  } else {
    console.log(`FAIL: heading should have no hover, got ${hhText}`)
    failures++
  }

  await conn.sendRequest('shutdown').catch(() => {})
  conn.sendNotification('exit').catch(() => {})
  conn.dispose()
  child.kill()
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('harness error:', e)
  child.kill()
  process.exit(2)
})
