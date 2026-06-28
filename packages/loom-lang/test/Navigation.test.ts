import { describe, expect, it } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { DocumentSource, LoomCompiler } from '../src/LoomCompiler'
import { LoomMemo } from '../src/LoomMemo'
import { PackageConfig } from '../src/PackageConfig'
import { defaultAnchorDelims } from '@athrio/loom-ast/LoomTokens'

// The compiler's navigation verbs over an in-memory DocumentSource. `doc` holds
// a tangle sink whose `::[The greeting]` anchor names a section in the same file,
// so definition follows the anchor to that heading and references finds both the
// heading and the anchor. Offsets are taken straight from the source text.

const doc = `{{lang: TypeScript}}

# The greeting

=>

const hi = "hi"

# The bundle {out/bundle.ts}

=>

::[The greeting]
export const out = hi
`

const files: Record<string, string> = { '/doc.loom': doc }

const TestDocs = Layer.succeed(
  DocumentSource,
  new DocumentSource({ read: (path: string) => Effect.succeed(files[path] ?? '') }),
)

const TestConfig = Layer.succeed(
  PackageConfig,
  new PackageConfig({
    resolve: () =>
      Effect.succeed({
        delims: defaultAnchorDelims,
        primaryLanguage: undefined,
        packageRoot: undefined,
        workspaceRoot: undefined,
      }),
  }),
)

const layer = Layer.provide(
  Layer.merge(LoomCompiler.Default, LoomMemo.Default),
  Layer.merge(TestDocs, TestConfig),
)

const anchorOffset = doc.indexOf('::[The greeting]') + 4 // inside the anchor name
const titleOffset = doc.indexOf('# The greeting') + 3 // inside the heading title

describe('LoomCompiler — navigation over anchors and sections', () => {
  it.effect('definition jumps from an anchor to the section it names', () =>
    Effect.gen(function* () {
      const c = yield* LoomCompiler
      const target = yield* c.definition('/doc.loom', anchorOffset)
      expect(target?.path).toBe('/doc.loom')
      // "The greeting" heading title — line 2 (0-based), after the "# " marker
      expect(target?.range.start).toEqual({ line: 2, character: 2 })
    }).pipe(Effect.provide(layer)),
  )

  it.effect('references lists the heading and every anchor that names it', () =>
    Effect.gen(function* () {
      const c = yield* LoomCompiler
      const refs = yield* c.references('/doc.loom', titleOffset)
      // the heading on line 2 and the `::[The greeting]` anchor on line 12
      expect(refs.map((r) => r.range.start.line).sort((a, b) => a - b)).toEqual([2, 12])
    }).pipe(Effect.provide(layer)),
  )

  it.effect('definition finds nothing under a position that is not an anchor', () =>
    Effect.gen(function* () {
      const c = yield* LoomCompiler
      const target = yield* c.definition('/doc.loom', doc.indexOf('const hi'))
      expect(target).toBeUndefined()
    }).pipe(Effect.provide(layer)),
  )
})
