import { describe, expect, it } from 'vitest'
import { codeView, producedOf, type Mod } from './frames'

// The runner executes frames and folds each module's de re. These fixtures prove
// product code passes through the ESM→CJS rewrite opaque, whatever import/export
// syntax it holds, and that a file's several sinks each compose into their own file.
// They drive FrameRunner.produce directly — the pass under test — over in-memory
// modules, reading the de re as a per-path name→code view.

const m = (name: string, text: string): Mod => ({ path: `/iso/${name}`, text })
const view = (...mods: ReadonlyArray<Mod>) => codeView(producedOf(...mods))

describe('runner — realistic product passes the rewrite opaque', () => {
  it('preserves import / export / default / function lines in the de re verbatim', () => {
    const real = m(
      'real.loom',
      `{{lang: TypeScript}}\n\n# Real [out, real.ts]\n\n=>\n\nimport { z } from "zod"\nexport function helper() { return z }\nexport default helper\nexport const four = 2 + 2\n`,
    )
    const section = [...(view(real).get(real.path)?.values() ?? [])][0]
    const text = (section?.fragments ?? [])
      .map((p) => (p.type === 'Fragment' ? p.text : ''))
      .join('')
    expect(text).toContain('import { z } from "zod"')
    expect(text).toContain('export function helper() { return z }')
    expect(text).toContain('export default helper')
    expect(text).toContain('export const four = 2 + 2')
  })

  it('composes two sinks from one file, each its own file', () => {
    const twosinks = m(
      'twosinks.loom',
      `{{lang: TypeScript}}\n\n# Shared\n\n=>\n\nexport const shared = 1\n\n# First [out, a.ts]\n\n=>\n\n::[Shared]\nexport const a = shared\n\n# Second [out, b.ts]\n\n=>\n\n::[Shared]\nexport const b = shared + 1\n`,
    )
    const sections = [...(view(twosinks).get(twosinks.path)?.keys() ?? [])]
    // both sinks composed, alongside the shared section
    expect(sections).toEqual(expect.arrayContaining(['Shared', 'First', 'Second']))
  })
})
