import * as ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { withLoomBaseline } from '../src/LoomBaseline'

// The frame checks under a fixed baseline, the same in every package. withLoomBaseline
// decorates the editor's TypeScript so Volar's config parse returns that baseline and
// discards whatever the consumer's tsconfig.json set — the consumer's options reach the
// product's own program, never the frame's.

describe('withLoomBaseline bakes the frame options', () => {
  it('returns the baseline and discards the consumer options the parse found', () => {
    const baked = withLoomBaseline(ts)
    const parsed = baked.parseJsonConfigFileContent(
      { compilerOptions: { strict: false, target: 'es5', noUnusedLocals: true } },
      ts.sys,
      '/project',
    )
    expect(parsed.options.strict).toBe(true)
    expect(parsed.options.target).toBe(ts.ScriptTarget.ES2022)
    expect(parsed.options.module).toBe(ts.ModuleKind.ESNext)
    expect(parsed.options.moduleResolution).toBe(ts.ModuleResolutionKind.Bundler)
    expect(parsed.options.noEmit).toBe(true)
    // A consumer lint never reaches the frame.
    expect(parsed.options.noUnusedLocals).toBeUndefined()
  })

  it('leaves the file list intact, replacing only the options', () => {
    const baked = withLoomBaseline(ts)
    const parsed = baked.parseJsonConfigFileContent(
      { files: ['a.ts'], compilerOptions: { strict: false } },
      ts.sys,
      '/project',
    )
    expect(parsed.fileNames.some((f) => f.endsWith('a.ts'))).toBe(true)
  })
})
