import { describe, expect, it as it_ } from 'bun:test'
import { effectify } from '@athrio/effect-test'
const it = effectify(it_)
import { Effect, Layer, Option } from 'effect'
import type { Source } from '#ast/LoomCorpusAstBuilder'
import { DocumentSource, LoomCompiler } from '../src/LoomCompiler'
import { PackageConfig } from '../src/PackageConfig'

// compiler.compile assembles the Volar tree from the LoomVirtualCodeBuilder
// passes — root (loom, the source mirror) → prose (Markdown) + one product per
// section (fromProduct) — and `toVolar` adapts it to Volar's runtime VirtualCode.
// The probes capture a *warm* runtime (layers built) and then `Runtime.runSync`
// the projection — exactly what the plugin does on Volar's synchronous callback.
// The source imports nothing, so the corpus is one file.

const input = `---
Language: TypeScript
---

# Adder

Adds two integers.

=>

export const add = (x: number, y: number): number => x + y
`

const source: Source = { read: () => Effect.succeed(input), list: Option.none() }

const layer = Layer.provide(
  LoomCompiler.layer,
  Layer.merge(DocumentSource.layer, PackageConfig.layer),
)

describe('VirtualCode — root projection', () => {
  it.effect('builds the tree via Runtime.runSync on a warm runtime', () =>
    Effect.gen(function* () {
      const root = yield* LoomCompiler.pipe(Effect.flatMap((c) => c.compile(source, '')))

      expect(root.id).toBe('root')
      expect(root.languageId).toBe('loom')
      // root → [prose (Markdown), Add (de re product)] — no frame
      expect(root.embeddedCodes).toHaveLength(2)

      // the prose document — the file's prose projected as Markdown
      const prose = root.embeddedCodes![0]!
      expect(prose.id).toBe('prose')
      expect(prose.languageId).toBe('prose')

      // the de re product for the Adder section — its raw code, in its language,
      // keyed by the section name lowercased (Volar requires lowercase ids)
      const product = root.embeddedCodes![1]!
      expect(product.id).toBe('adder')
      expect(product.languageId).toBe('typescript')
      expect(
        product.snapshot.getText(0, product.snapshot.getLength()),
      ).toContain('export const add = (x: number, y: number)')
    }).pipe(Effect.provide(layer)),
  )

  it.effect('projects a {Config} section as YAML for highlighting', () =>
    Effect.gen(function* () {
      const cfg: Source = {
        read: () =>
          Effect.succeed(
            `---\nLanguage: TypeScript\n---\n\n# Workspace {Config}\n\nThe project's languages.\n\n=>\n\nlanguages:\n  typescript: {}\n`,
          ),
        list: Option.none(),
      }
      const root = yield* LoomCompiler.pipe(Effect.flatMap((c) => c.compile(cfg, '')))
      // root → [prose, the {Config} product]; its body reads as YAML
      const product = root.embeddedCodes![1]!
      expect(product.languageId).toBe('yaml')
    }).pipe(Effect.provide(layer)),
  )
})
