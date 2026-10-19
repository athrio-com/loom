import { describe, expect, it } from 'bun:test'
import { createLanguage, type VirtualCode } from '@volar/language-core'
import { Layer, ManagedRuntime } from 'effect'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { URI } from 'vscode-uri'
import { LoomConfig } from '@athrio/loom-config/LoomConfig'
import { DocumentSource, LoomCompiler, stringSnapshot } from '../src/LoomCompiler'
import { loomLanguagePlugin } from '../src/LoomLanguagePlugin'
import { PackageConfig } from '../src/PackageConfig'

const runtime = ManagedRuntime.make(
  Layer.mergeAll(LoomCompiler.layer, LoomConfig.layer).pipe(
    Layer.provide(DocumentSource.layer),
    Layer.provide(PackageConfig.layer),
    Layer.provide(LoomConfig.layer),
  ),
)

const lines = (...rows: ReadonlyArray<string>): string => `${rows.join('\n')}\n`

const loomOf = (code: string): string =>
  lines('---', 'Language: TypeScript', '---', '', '# Answer', '', '=>', '', code)

const textOf = (code: VirtualCode | undefined): string =>
  code === undefined ? '' : code.snapshot.getText(0, code.snapshot.getLength())

describe('LoomLanguagePlugin — a script Volar deletes', () => {
  it('builds a new script at the same path from the text it is given', () => {
    const language = createLanguage<URI>([loomLanguagePlugin(runtime)], new Map(), () => {})
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'loom-plugin-')))
    const copy = URI.file(join(folder, 'answer.loom.tmp'))
    const written = loomOf('const  answer  =  42')
    language.scripts.set(copy, stringSnapshot(written), 'loom')
    language.scripts.set(copy, stringSnapshot(loomOf('const answer = 42')), 'loom')
    language.scripts.delete(copy)
    const again = language.scripts.set(copy, stringSnapshot(written), 'loom')
    expect(textOf(again?.generated?.root)).toBe(written)
  })
})
