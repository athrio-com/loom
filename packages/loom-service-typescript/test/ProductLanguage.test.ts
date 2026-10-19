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
