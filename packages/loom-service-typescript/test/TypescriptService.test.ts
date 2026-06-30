import * as ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { URI } from 'vscode-uri'
import type { ComposedFile } from '@athrio/loom-lang-services/LanguageService'
import { createProductProgram } from '../src/ProductProgram'
import { productTarget } from '../src/TypescriptService'

// productTarget is the delegation core of the service plugin: it gates an embedded
// document on its language, reads the file's composition — every root in the corpus
// that tangles to a file, at that path — and hands the whole set to a ProductProgram,
// the edited root carrying the live buffer. The tree emits one document per root, so
// productTarget asks only which root the document edits. These tests drive it with a
// real program, no Volar server: a TypeScript Product is served at its tangle path
// with the live buffer overriding disk, an import across roots resolves against the
// composition, a root that tangles nowhere is checked beside its .loom under a
// synthetic name, and a non-TypeScript document and a non-embedded uri are declined.

const options: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: true,
  skipLibCheck: true,
  noEmit: true,
}

const loomPath = '/project/doc.loom'
const decoded = (id: string): readonly [URI, string] => [URI.file(loomPath), id]

describe('productTarget routes a Product to its program', () => {
  it('serves a TypeScript Product at its tangle path, the live buffer overriding disk', async () => {
    const program = createProductProgram(ts, options)
    const roots: ReadonlyArray<ComposedFile> = [
      { path: '/project/doc.ts', content: 'export const x = 1\n', loomPath, rootId: 'main' },
    ]
    const target = productTarget(
      decoded('main'),
      'typescript',
      'export const x: string = 123\n', // a type error live in the buffer, not on disk
      () => program,
      () => roots,
    )
    expect(target?.fileName).toBe('/project/doc.ts')
    const diagnostics = await target!.program.diagnostics(target!.fileName)
    program.dispose()
    expect(diagnostics.some((d) => /not assignable/.test(d.message))).toBe(true)
  })

  it('resolves an import across roots against their composition', async () => {
    const program = createProductProgram(ts, options)
    const roots: ReadonlyArray<ComposedFile> = [
      { path: '/project/a.ts', content: '', loomPath: '/project/a.loom', rootId: 'a' },
      {
        path: '/project/b.ts',
        content: 'export const b = 2\n',
        loomPath: '/project/b.loom',
        rootId: 'b',
      },
    ]
    const target = productTarget(
      [URI.file('/project/a.loom'), 'a'],
      'typescript',
      "import { b } from './b.js'\nexport const a: number = b + 1\n",
      () => program,
      () => roots,
    )
    expect(target?.fileName).toBe('/project/a.ts')
    const diagnostics = await target!.program.diagnostics(target!.fileName)
    program.dispose()
    expect(diagnostics.some((d) => /Cannot find module/.test(d.message))).toBe(false)
    expect(diagnostics.some((d) => d.severity === 1)).toBe(false)
  })

  it('names a tsx Product by its tangle path', () => {
    const program = createProductProgram(ts, options)
    const roots: ReadonlyArray<ComposedFile> = [
      { path: '/project/view.tsx', content: 'export const v = 1\n', loomPath, rootId: 'view' },
    ]
    const target = productTarget(
      decoded('view'),
      'tsx',
      'export const v = 1\n',
      () => program,
      () => roots,
    )
    program.dispose()
    expect(target?.fileName).toBe('/project/view.tsx')
  })

  it('declines a non-TypeScript document', () => {
    const program = createProductProgram(ts, options)
    const target = productTarget(
      decoded('config'),
      'json',
      '{ "a": 1 }\n',
      () => program,
      () => [],
    )
    program.dispose()
    expect(target).toBeUndefined()
  })

  it('declines a uri that is not an embedded document', () => {
    const program = createProductProgram(ts, options)
    const target = productTarget(undefined, 'typescript', '', () => program, () => [])
    program.dispose()
    expect(target).toBeUndefined()
  })

  it('checks a root that tangles nowhere beside its .loom under a synthetic name', async () => {
    const program = createProductProgram(ts, options)
    const roots: ReadonlyArray<ComposedFile> = [
      { path: '/project/doc.ts', content: 'export const x = 1\n', loomPath, rootId: 'main' },
    ]
    const target = productTarget(
      decoded('fresh'),
      'typescript',
      'export const f: string = 1\n', // a type error in a root with no file sink
      () => program,
      () => roots,
    )
    expect(target?.fileName).toBe('/project/doc.loom.fresh.ts')
    const diagnostics = await target!.program.diagnostics(target!.fileName)
    program.dispose()
    expect(diagnostics.some((d) => /not assignable/.test(d.message))).toBe(true)
  })
})
