import { Effect } from 'effect'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { ComposedCode } from '@athrio/loom-core/ProductAst'
import { LoomCompiler, DocumentSource } from '../src/LoomCompiler'
import { PackageConfig } from '../src/PackageConfig'

// The runner wires each module's service cone in dependency order and folds the
// layers (Layer.provideMerge). These fixtures exercise the graph shapes the fold
// must handle: a shared dependency reached two ways (a diamond), a chain several
// levels deep, and a cycle — which Effect cannot build, so the run must contain it
// rather than hang or crash.

const dir = mkdtempSync(join(tmpdir(), 'loom-wiring-'))
const w = (name: string, src: string): string => {
  const path = join(dir, name)
  writeFileSync(path, src)
  return path
}
const composedOf = (path: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const c = yield* LoomCompiler
      return yield* c.composed(path)
    }).pipe(
      Effect.provide(LoomCompiler.Default),
      Effect.provide(DocumentSource.Default),
      Effect.provide(PackageConfig.Default),
    ) as Effect.Effect<{
      output: { code: ReadonlyMap<string, ReadonlyMap<string, ComposedCode>> }
    }>,
  )

const sectionsOf = (
  out: { code: ReadonlyMap<string, ReadonlyMap<string, ComposedCode>> },
  path: string,
): string[] => [...(out.code.get(path)?.keys() ?? [])]

const refCount = (
  out: { code: ReadonlyMap<string, ReadonlyMap<string, ComposedCode>> },
  path: string,
  name: string,
): number =>
  (out.code.get(path)?.get(name)?.parts ?? []).filter((p) => p.type !== 'Fragment')
    .length

afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('runner wires the service cone over real graph shapes', () => {
  it('resolves a diamond: A→B,C and B,C→D, the shared D reached both ways', async () => {
    const dia = w(
      'dia.loom',
      `{{lang: TypeScript}}\n\n# Dee [D]\n\n=>\n\nconst d = 0\n\n# Bee [B]\n\n{{d = D}}\n\n=>\n\n::[d]\nconst b = 1\n\n# Cee [C]\n\n{{d = D}}\n\n=>\n\n::[d]\nconst c = 1\n\n# Aaa [A]\n\n{{b = B}}\n{{c = C}}\n\n=>\n\n::[b]\n::[c]\nconst a = 1\n`,
    )
    const { output } = await composedOf(dia)
    // every node composed — the fold built the shared D without conflict
    expect(sectionsOf(output, dia).sort()).toEqual(['A', 'B', 'C', 'D'])
    // A transcludes both of its dependencies
    expect(refCount(output, dia, 'A')).toBe(2)
    expect(refCount(output, dia, 'B')).toBe(1)
    expect(refCount(output, dia, 'C')).toBe(1)
  })

  it('resolves a deep chain A→B→C→D end to end', async () => {
    const deep = w(
      'deep.loom',
      `{{lang: TypeScript}}\n\n# Dee [D]\n\n=>\n\nconst d = 0\n\n# Cee [C]\n\n{{d = D}}\n\n=>\n\n::[d]\nconst c = 1\n\n# Bee [B]\n\n{{c = C}}\n\n=>\n\n::[c]\nconst b = 1\n\n# Aaa [A]\n\n{{b = B}}\n\n=>\n\n::[b]\nconst a = 1\n`,
    )
    const { output } = await composedOf(deep)
    expect(sectionsOf(output, deep).sort()).toEqual(['A', 'B', 'C', 'D'])
    expect(refCount(output, deep, 'A')).toBe(1)
  })

  it('contains a Warp cycle: the cyclic file yields no de re, the run does not crash', async () => {
    // A's Warp names B, B's names A — Effect cannot build a circular layer set.
    // The cyclic module's run fails and is caught, so it composes nothing; the
    // run still returns. (The cycle also surfaces as a TS diagnostic on the
    // frame, ts2488 at the `yield*`, the same way an unbound Warp does.)
    const cyc = w(
      'cyc.loom',
      `{{lang: TypeScript}}\n\n# Aaa [A]\n\n{{b = B}}\n\n=>\n\n::[b]\nconst a = 1\n\n# Bbb [B]\n\n{{a = A}}\n\n=>\n\n::[a]\nconst b = 1\n`,
    )
    const { output } = await composedOf(cyc)
    expect(output.code.has(cyc)).toBe(true) // the run completed, no crash
    expect(sectionsOf(output, cyc)).toEqual([]) // the cycle built no de re
  })
})
