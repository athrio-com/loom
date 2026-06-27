import { describe, expect, it } from 'vitest'
import type { Code } from '@athrio/loom-ast/ProductAst'
import { codeView, producedOf, type Mod } from './frames'

// The runner wires each module's service cone in dependency order and folds the
// layers (Layer.provideMerge). These fixtures exercise the graph shapes the fold
// must handle: a shared dependency reached two ways (a diamond), a chain several
// levels deep, and a cycle — which Effect cannot build, so the run must contain it
// rather than hang or crash. Each drives FrameRunner.produce over one in-memory file.

type CodeView = ReadonlyMap<string, ReadonlyMap<string, Code>>

const m = (name: string, text: string): Mod => ({ path: `/wiring/${name}`, text })
const view = (mod: Mod): CodeView => codeView(producedOf(mod))

const sectionsOf = (code: CodeView, path: string): string[] => [
  ...(code.get(path)?.keys() ?? []),
]

const refCount = (code: CodeView, path: string, name: string): number =>
  (code.get(path)?.get(name)?.fragments ?? []).filter((p) => p.type !== 'Fragment')
    .length

describe('runner wires the service cone over real graph shapes', () => {
  it('resolves a diamond: A→B,C and B,C→D, the shared D reached both ways', () => {
    const dia = m(
      'dia.loom',
      `{{lang: TypeScript}}\n\n# Dee [D]\n\n=>\n\nconst d = 0\n\n# Bee [B]\n\n{{d = D}}\n\n=>\n\n::[d]\nconst b = 1\n\n# Cee [C]\n\n{{d = D}}\n\n=>\n\n::[d]\nconst c = 1\n\n# Aaa [A]\n\n{{b = B}}\n{{c = C}}\n\n=>\n\n::[b]\n::[c]\nconst a = 1\n`,
    )
    const code = view(dia)
    // every node composed — the fold built the shared D without conflict
    expect(sectionsOf(code, dia.path).sort()).toEqual(['A', 'B', 'C', 'D'])
    // A transcludes both of its dependencies
    expect(refCount(code, dia.path, 'A')).toBe(2)
    expect(refCount(code, dia.path, 'B')).toBe(1)
    expect(refCount(code, dia.path, 'C')).toBe(1)
  })

  it('resolves a deep chain A→B→C→D end to end', () => {
    const deep = m(
      'deep.loom',
      `{{lang: TypeScript}}\n\n# Dee [D]\n\n=>\n\nconst d = 0\n\n# Cee [C]\n\n{{d = D}}\n\n=>\n\n::[d]\nconst c = 1\n\n# Bee [B]\n\n{{c = C}}\n\n=>\n\n::[c]\nconst b = 1\n\n# Aaa [A]\n\n{{b = B}}\n\n=>\n\n::[b]\nconst a = 1\n`,
    )
    const code = view(deep)
    expect(sectionsOf(code, deep.path).sort()).toEqual(['A', 'B', 'C', 'D'])
    expect(refCount(code, deep.path, 'A')).toBe(1)
  })

  it('contains a Warp cycle: the cyclic file yields no de re, the run does not crash', () => {
    // A's Warp names B, B's names A — Effect cannot build a circular layer set.
    // The cyclic module's run fails and is caught, so it composes nothing; the
    // run still returns. (The cycle also surfaces as a TS diagnostic on the
    // frame, ts2488 at the `yield*`, the same way an unbound Warp does.)
    const cyc = m(
      'cyc.loom',
      `{{lang: TypeScript}}\n\n# Aaa [A]\n\n{{b = B}}\n\n=>\n\n::[b]\nconst a = 1\n\n# Bbb [B]\n\n{{a = A}}\n\n=>\n\n::[a]\nconst b = 1\n`,
    )
    const code = view(cyc)
    expect(code.has(cyc.path)).toBe(true) // the run completed, no crash
    expect(sectionsOf(code, cyc.path)).toEqual([]) // the cycle built no de re
  })
})
