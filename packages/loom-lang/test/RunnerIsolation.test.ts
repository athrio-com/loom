import { Effect } from 'effect'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { ComposedCode } from '#ast/ProductAst'
import { LoomCompiler, DocumentSource } from '../src/LoomCompiler'
import { PackageConfig } from '../src/PackageConfig'

// The runner executes frames, so a broken frame can fail at run time. These fixtures
// prove the two guarantees that keep the runnable frame trustworthy: a fault is
// contained to its own module's de re (the
// corpus does not collapse), and product code passes through the ESM→CJS rewrite
// opaque, whatever import/export syntax it holds.

const dir = mkdtempSync(join(tmpdir(), 'loom-iso-'))
const w = (name: string, src: string): string => {
  const path = join(dir, name)
  writeFileSync(path, src)
  return path
}

// good is healthy and standalone. baddep is broken — a Warp to a tag nothing defines.
// importer references the broken module. entry imports both importer and good, and
// composes good. entry's reachable corpus therefore holds a broken module.
const baddep = w(
  'baddep.loom',
  `{{lang: TypeScript}}\n\n# Bad [BadDep]\n\n{{x: Ghost}}\n\n=>\n\n::[x]\nexport const bad = 1\n`,
)
const importer = w(
  'importer.loom',
  `{{lang: TypeScript}}\n\n# Pull {Loom}\n\n=>\n\nimport { BadDep } from "./baddep.loom"\n\n# Imp [Imp]\n\n{{b: BadDep}}\n\n=>\n\n::[b]\nexport const imp = 1\n`,
)
const good = w(
  'good.loom',
  `{{lang: TypeScript}}\n\n# Good [Good]\n\n=>\n\nexport const good = 1\n`,
)
const entry = w(
  'entry.loom',
  `{{lang: TypeScript}}\n\n# Pull {Loom}\n\n=>\n\nimport { Imp } from "./importer.loom"\nimport { Good } from "./good.loom"\n\n# Entry [Entry]\n\n{{g: Good}}\n\n=>\n\n::[g]\nexport const e = 1\n`,
)

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

afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('runner isolation — a broken frame is contained, not contagious', () => {
  it('keeps a healthy module’s de re when a sibling in the corpus is broken', async () => {
    const { output } = await composedOf(entry)
    // the broken module and the one that references it lose their de re
    expect(output.code.get(baddep)?.has('BadDep') ?? false).toBe(false)
    expect(output.code.get(importer)?.has('Imp') ?? false).toBe(false)
    // the healthy modules keep theirs — no corpus-wide collapse
    expect(output.code.get(good)?.has('Good')).toBe(true)
    expect(output.code.get(entry)?.has('Entry')).toBe(true)
  })
})

describe('runner — realistic product passes the rewrite opaque', () => {
  it('preserves import / export / default / function lines in the de re verbatim', async () => {
    const real = w(
      'real.loom',
      `{{lang: TypeScript}}\n\n# Real {out/real.ts}\n\n=>\n\nimport { z } from "zod"\nexport function helper() { return z }\nexport default helper\nexport const four = 2 + 2\n`,
    )
    const { output } = await composedOf(real)
    const section = [...(output.code.get(real)?.values() ?? [])][0]
    const text = (section?.parts ?? [])
      .map((p) => (p.type === 'Fragment' ? p.text : ''))
      .join('')
    expect(text).toContain('import { z } from "zod"')
    expect(text).toContain('export function helper() { return z }')
    expect(text).toContain('export default helper')
    expect(text).toContain('export const four = 2 + 2')
  })

  it('composes two sinks from one file, each its own file', async () => {
    const twosinks = w(
      'twosinks.loom',
      `{{lang: TypeScript}}\n\n# Shared [Shared]\n\n=>\n\nexport const shared = 1\n\n# First {out/a.ts}\n\n{{s: Shared}}\n\n=>\n\n::[s]\nexport const a = shared\n\n# Second {out/b.ts}\n\n{{s: Shared}}\n\n=>\n\n::[s]\nexport const b = shared + 1\n`,
    )
    const { output } = await composedOf(twosinks)
    const files = [...(output.code.get(twosinks)?.keys() ?? [])]
    // both sinks composed, alongside the shared section
    expect(files).toEqual(expect.arrayContaining(['Shared', 'First', 'Second']))
  })
})
