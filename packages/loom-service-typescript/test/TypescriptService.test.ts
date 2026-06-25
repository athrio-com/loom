import * as ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { URI } from 'vscode-uri'
import type { ProductQueryApi } from '@athrio/loom-lang-services/LanguageService'
import { createProductProgram } from '../src/ProductProgram'
import { productTarget } from '../src/TypescriptService'

// productTarget is the delegation core of the service plugin: it gates an embedded
// document on the host's root query and, for a root, hands the section's text to a
// ProductProgram. These tests drive it with a fixture ProductQuery and a real
// program — no Volar server — and confirm a root is served while a fragment and a
// non-embedded uri are declined.

const options: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: true,
  skipLibCheck: true,
  noEmit: true,
}

const loomPath = '/project/doc.loom'
const queryWith = (roots: ReadonlyArray<string>): ProductQueryApi => ({
  roots: () => new Set(roots),
})
const decoded = (id: string): readonly [URI, string] => [URI.file(loomPath), id]

describe('productTarget routes a section to its program', () => {
  it('serves a root: the program reports the section it set', async () => {
    const program = createProductProgram(ts, options)
    const target = productTarget(
      decoded('main'),
      'export const x: string = 123\n',
      queryWith(['main']),
      () => program,
    )
    expect(target).toBeDefined()
    const diagnostics = await target!.program.diagnostics(target!.fileName)
    program.dispose()
    expect(diagnostics.some((d) => /not assignable/.test(d.message))).toBe(true)
  })

  it('declines a fragment the root query does not list', () => {
    const program = createProductProgram(ts, options)
    const target = productTarget(
      decoded('helper'),
      'export const y = 1\n',
      queryWith(['main']),
      () => program,
    )
    program.dispose()
    expect(target).toBeUndefined()
  })

  it('declines a uri that is not an embedded document', () => {
    const program = createProductProgram(ts, options)
    const target = productTarget(undefined, '', queryWith(['main']), () => program)
    program.dispose()
    expect(target).toBeUndefined()
  })
})
