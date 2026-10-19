import * as ts from 'typescript'
import { describe, expect, it } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { URI } from 'vscode-uri'
import { productLanguage } from '../src/ProductProgram'

const textOf = (snapshot: ts.IScriptSnapshot | undefined): string =>
  snapshot === undefined ? '' : snapshot.getText(0, snapshot.getLength())

describe('productLanguage — a file read from disk', () => {
  it('keeps its snapshot until the file changes', () => {
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'loom-product-')))
    const file = join(folder, 'library.d.ts')
    const uri = URI.file(file)
    writeFileSync(file, 'export declare const answer: number\n')
    const language = productLanguage(ts, new Map())
    const first = language.scripts.get(uri)?.snapshot
    const again = language.scripts.get(uri)?.snapshot
    const later = new Date(Date.now() + 10_000)
    writeFileSync(file, 'export declare const answer: string\n')
    utimesSync(file, later, later)
    const changed = language.scripts.get(uri)?.snapshot
    rmSync(folder, { recursive: true })
    const gone = language.scripts.get(uri)
    expect(again).toBe(first)
    expect(changed).not.toBe(first)
    expect(textOf(changed)).toBe('export declare const answer: string\n')
    expect(gone).toBeUndefined()
  })
})

import { Array } from 'effect'
import { createProductProgram } from '../src/ProductProgram'

describe('createProductProgram — a root it holds but does not list', () => {
  it('answers an import from a root it lists', async () => {
    const program = createProductProgram(ts, {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      strict: true,
      skipLibCheck: true,
      noEmit: true,
      allowImportingTsExtensions: true,
    })
    program.sync(
      [
        {
          path: '/held/caller.ts',
          text: "import { answer } from './library.ts'\nexport const wrong: string = answer\n",
        },
      ],
      [{ path: '/held/library.ts', text: 'export const answer = 42\n' }],
    )
    const messages = Array.map(await program.diagnostics('/held/caller.ts'), (d) => d.message)
    program.dispose()
    expect(messages.some((message) => /not assignable to type 'string'/.test(message))).toBe(true)
    expect(messages.some((message) => /Cannot find module/.test(message))).toBe(false)
  })
})
