import * as ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { URI } from 'vscode-uri'
import { createProductProgram } from '../src/ProductProgram'
import { productTarget } from '../src/TypescriptService'

// productTarget is the delegation core of the service plugin: it gates an embedded
// document on its language, and for a TypeScript Product hands its text to a
// ProductProgram. The tree emits one document per composition root, members folded
// in, so productTarget no longer asks which documents are roots — every TypeScript
// document it is handed is already a Product to check. These tests drive it with a
// real program, no Volar server, and confirm a TypeScript Product is served while a
// non-TypeScript document and a non-embedded uri are declined.

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
  it('serves a TypeScript Product: the program reports the section it set', async () => {
    const program = createProductProgram(ts, options)
    const target = productTarget(
      decoded('main'),
      'typescript',
      'export const x: string = 123\n',
      () => program,
    )
    expect(target).toBeDefined()
    const diagnostics = await target!.program.diagnostics(target!.fileName)
    program.dispose()
    expect(diagnostics.some((d) => /not assignable/.test(d.message))).toBe(true)
  })

  it('names a tsx Product with a .tsx synthetic file', () => {
    const program = createProductProgram(ts, options)
    const target = productTarget(
      decoded('view'),
      'tsx',
      'export const v = 1\n',
      () => program,
    )
    program.dispose()
    expect(target?.fileName).toBe('/project/doc.loom.view.tsx')
  })

  it('declines a non-TypeScript document', () => {
    const program = createProductProgram(ts, options)
    const target = productTarget(
      decoded('config'),
      'json',
      '{ "a": 1 }\n',
      () => program,
    )
    program.dispose()
    expect(target).toBeUndefined()
  })

  it('declines a uri that is not an embedded document', () => {
    const program = createProductProgram(ts, options)
    const target = productTarget(undefined, 'typescript', '', () => program)
    program.dispose()
    expect(target).toBeUndefined()
  })
})
