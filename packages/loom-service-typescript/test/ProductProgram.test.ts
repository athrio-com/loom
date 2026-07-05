import * as ts from 'typescript'
import { describe, expect, it as it_ } from 'bun:test'
import { effectify } from '@athrio/effect-test'
const it = effectify(it_)
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
    program.sync([{ path: root, text: 'export const x: string = 123\n' }])
    const diagnostics = await program.diagnostics(root)
    program.dispose()
    expect(diagnostics.some((d) => isError(d) && /not assignable/.test(d.message))).toBe(true)
  })

  it('lets the consumer options govern — strictNullChecks on, then off', async () => {
    const source = 'export const value: string = null\n'
    const nullError = (d: Diagnostic): boolean =>
      isError(d) && /not assignable to type 'string'/.test(d.message)

    const strict = createProductProgram(ts, baseOptions({ strict: true }))
    strict.sync([{ path: root, text: source }])
    const strictDiagnostics = await strict.diagnostics(root)
    strict.dispose()

    const loose = createProductProgram(ts, baseOptions({ strict: false }))
    loose.sync([{ path: root, text: source }])
    const looseDiagnostics = await loose.diagnostics(root)
    loose.dispose()

    expect(strictDiagnostics.some(nullError)).toBe(true)
    expect(looseDiagnostics.some(nullError)).toBe(false)
  })

  it('answers hover with the inferred type', async () => {
    const program = createProductProgram(ts, baseOptions())
    program.sync([{ path: root, text: "export const greeting = 'hello'\n" }])
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

describe('the product program offers an auto-import quick-fix across roots', () => {
  // Cross-file auto-import scans the program's exports and loads the TypeScript
  // standard library cold; under full-suite load that runs past the 5s default, so
  // give it the same headroom the other Volar tests take.
  it('suggests importing a name used with no import, and resolves the edit', async () => {
    const program = createProductProgram(
      ts,
      baseOptions({ allowImportingTsExtensions: true }),
    )
    program.sync([
      {
        path: '/proj/library.ts',
        text: 'export const greet = (n: string): string => `Hi ${n}`\n',
      },
      { path: '/proj/caller.ts', text: "console.log(greet('world'))\n" },
    ])

    // the missing-name diagnostic drives the quick-fix: TypeScript reads the error
    // codes in the context to decide which fixes apply
    const diagnostics = await program.diagnostics('/proj/caller.ts')
    const missing = diagnostics.find((d) => /Cannot find name 'greet'/.test(d.message))
    expect(missing).toBeDefined()

    const actions = await program.codeActions('/proj/caller.ts', missing!.range, {
      diagnostics: [missing!],
    })
    const addImport = actions?.find((a) => /^Add import/.test(a.title))
    expect(addImport).toBeDefined()

    // a quick-fix carries its edit inline; resolve only fills in a lazy action
    const resolved =
      addImport!.edit === undefined
        ? await program.resolveCodeAction(addImport!)
        : addImport!
    program.dispose()

    const edits = [
      ...Object.values(resolved.edit?.changes ?? {}).flat(),
      ...(resolved.edit?.documentChanges ?? []).flatMap((change) =>
        'edits' in change ? change.edits : [],
      ),
    ]
    expect(
      edits.some((edit) => /import\b/.test(edit.newText) && edit.newText.includes('greet')),
    ).toBe(true)
  }, 30_000)
})
