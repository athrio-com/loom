import { Effect } from 'effect'
import { NodeContext } from '@effect/platform-node'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { LoomTangler } from '../src/LoomTangler'
import { DocumentSource } from '../src/LoomCompiler'
import { PackageConfig } from '../src/PackageConfig'

// Regression: the runner must tangle cross-file modules whose product code itself
// contains `import`/`export` lines — which most real source does. The ESM→CJS
// rewrite once scanned the whole frame text, so a product line beginning with
// `export` was caught by the export rule, the module re-exported a name nothing
// declared, and the run silently produced nothing (no sink, no file). `toEvalable`
// now masks the fragment template literals before rewriting, so product passes
// through opaque. This tangles a real two-file corpus end to end and reads the
// emitted file back.

const dir = mkdtempSync(join(tmpdir(), 'loom-xtangle-'))
const lib = join(dir, 'lib.loom')
const app = join(dir, 'app.loom')

const libSrc = `{{lang: TypeScript}}

# Doubler [Double]

=>

export const double = (x: number): number => x * 2
`

const appSrc = `{{lang: TypeScript}}

# Pulling in the library {Loom}

=>

import { Double } from "./lib.loom"

# The program {out/app.ts}

{{d = Double}}

=>

::[d]
export const four = double(2)
`

const run = <A>(e: Effect.Effect<A, unknown, LoomTangler>): Promise<A> =>
  Effect.runPromise(
    e.pipe(
      Effect.provide(LoomTangler.Default),
      Effect.provide(DocumentSource.Default),
      Effect.provide(PackageConfig.Default),
      Effect.provide(NodeContext.layer),
    ) as Effect.Effect<A>,
  )

beforeAll(() => {
  writeFileSync(lib, libSrc)
  writeFileSync(app, appSrc)
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('cross-file tangle through the runner', () => {
  it('emits a sink that inlines exported product from another file', async () => {
    const written = await run(
      Effect.gen(function* () {
        const tangler = yield* LoomTangler
        return yield* tangler.tangle(app)
      }),
    )
    expect(written).toHaveLength(1)
    expect(written[0]!.path).toBe(join(dir, 'out/app.ts'))

    const out = readFileSync(join(dir, 'out/app.ts'), 'utf8')
    // the dependency, transcluded across the file boundary, export keyword intact
    expect(out).toContain('export const double = (x: number): number => x * 2')
    // the sink's own code
    expect(out).toContain('export const four = double(2)')
    // composition order: the dependency before the code that uses it
    expect(out.indexOf('const double')).toBeLessThan(out.indexOf('const four'))
  })
})
