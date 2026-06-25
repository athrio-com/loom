import * as ts from 'typescript'
import { describe, expect, it } from 'vitest'
import type { Diagnostic } from '@volar/language-service'
import { createProductProgram } from '../src/ProductProgram'

// The product program is the proof that the planes are separate: it checks the
// product against compiler options the caller hands it, not the frame's baked
// baseline. These tests drive it directly — no Volar server, no .loom — with a
// synthetic root file held in memory, and confirm the options govern the result.

const baseOptions = (overrides: ts.CompilerOptions = {}): ts.CompilerOptions => ({
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: true,
  skipLibCheck: true,
  noEmit: true,
  ...overrides,
})

const root = '/virtual/root.ts'

const isError = (d: Diagnostic): boolean => d.severity === 1

describe('the product program checks roots against the options it is given', () => {
  it('reports a type error in a root', async () => {
    const program = createProductProgram(ts, baseOptions())
    program.setRoot(root, 'export const x: string = 123\n')
    const diagnostics = await program.diagnostics(root)
    program.dispose()
    expect(diagnostics.some((d) => isError(d) && /not assignable/.test(d.message))).toBe(true)
  })

  it('lets the consumer options govern — strictNullChecks on, then off', async () => {
    const source = 'export const value: string = null\n'
    const nullError = (d: Diagnostic): boolean =>
      isError(d) && /not assignable to type 'string'/.test(d.message)

    const strict = createProductProgram(ts, baseOptions({ strict: true }))
    strict.setRoot(root, source)
    const strictDiagnostics = await strict.diagnostics(root)
    strict.dispose()

    const loose = createProductProgram(ts, baseOptions({ strict: false }))
    loose.setRoot(root, source)
    const looseDiagnostics = await loose.diagnostics(root)
    loose.dispose()

    expect(strictDiagnostics.some(nullError)).toBe(true)
    expect(looseDiagnostics.some(nullError)).toBe(false)
  })

  it('answers hover with the inferred type', async () => {
    const program = createProductProgram(ts, baseOptions())
    program.setRoot(root, "export const greeting = 'hello'\n")
    const hover = await program.hover(root, { line: 0, character: 13 })
    program.dispose()
    expect(hover).toBeDefined()
    const contents = hover!.contents
    const text =
      typeof contents === 'object' && contents !== null && 'value' in contents
        ? (contents as { value: string }).value
        : JSON.stringify(contents)
    expect(text).toMatch(/greeting/)
  })
})
