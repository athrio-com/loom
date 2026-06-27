import { describe, expect, it } from '@effect/vitest'
import { Effect, Layer, Runtime } from 'effect'
import type { Source } from '#ast/LoomCorpusAstBuilder'
import { DocumentSource, LoomCompiler } from '../src/LoomCompiler'
import { PackageConfig } from '../src/PackageConfig'

// compiler.compile assembles the Volar tree from the two LoomVirtualCodeBuilder
// passes — root (loom) → frame (typescript, fromFrame) + one product per section
// (fromProduct) — and `toVolar` adapts it to Volar's runtime VirtualCode. The
// probes capture a *warm* runtime (layers built) and then `Runtime.runSync` the
// projection — exactly what the plugin does on Volar's synchronous callback. The
// source imports nothing, so the corpus is one file.

const input = `{{lang: TypeScript}}

# Adder [Add]

Adds two integers.

=>

export const add = (x: number, y: number): number => x + y
`

const source: Source = { read: () => Effect.succeed(input) }

const layer = Layer.provide(
  LoomCompiler.Default,
  Layer.merge(DocumentSource.Default, PackageConfig.Default),
)

describe('VirtualCode — root → frame projection', () => {
  it.effect('builds the tree via Runtime.runSync on a warm runtime', () =>
    Effect.gen(function* () {
      const runtime = yield* Effect.runtime<LoomCompiler>()
      const root = Runtime.runSync(runtime)(
        LoomCompiler.pipe(Effect.flatMap((c) => c.compile(source, ''))),
      )

      expect(root.id).toBe('root')
      expect(root.languageId).toBe('loom')
      // root → [frame (de dicto), Add (de re product)]
      expect(root.embeddedCodes).toHaveLength(2)

      const frame = root.embeddedCodes![0]!
      expect(frame.id).toBe('frame')
      expect(frame.languageId).toBe('loom')
      expect(frame.embeddedCodes).toEqual([]) // the frame has no children
      const gen = frame.snapshot.getText(0, frame.snapshot.getLength())
      expect(gen).toContain('export class Add')
      expect(frame.mappings.length).toBeGreaterThan(0)

      // the de re product for the Add section — its raw code, in its language,
      // keyed by the section name lowercased (Volar requires lowercase ids)
      const product = root.embeddedCodes![1]!
      expect(product.id).toBe('add')
      expect(product.languageId).toBe('typescript')
      expect(
        product.snapshot.getText(0, product.snapshot.getLength()),
      ).toContain('export const add = (x: number, y: number)')
    }).pipe(Effect.provide(layer)),
  )

  it.effect('maps the frame class name back to the [Add] tag in the .loom', () =>
    Effect.gen(function* () {
      const runtime = yield* Effect.runtime<LoomCompiler>()
      const root = Runtime.runSync(runtime)(
        LoomCompiler.pipe(Effect.flatMap((c) => c.compile(source, ''))),
      )

      const frame = root.embeddedCodes![0]!
      const gen = frame.snapshot.getText(0, frame.snapshot.getLength())
      const genAt = gen.indexOf('class Add') + 'class '.length

      const m = frame.mappings.find(
        (cm) =>
          cm.generatedOffsets[0]! <= genAt &&
          genAt < cm.generatedOffsets[0]! + cm.generatedLengths![0]!,
      )
      expect(m).toBeDefined()
      // source side hugs the inner label of `[Add]`, not the whole tag
      expect(m!.sourceOffsets[0]).toBe(input.indexOf('[Add]') + 1)
      expect(
        input.slice(m!.sourceOffsets[0]!, m!.sourceOffsets[0]! + m!.lengths[0]!),
      ).toBe('Add')
      // the tag is locate-only: navigation reaches and renames the section, but
      // semantic is off, so hovering [Add] no longer surfaces the generated
      // `class Add` — the Effect.Service machinery stays out of the author's view
      expect(m!.data.navigation).toBe(true)
      expect(m!.data.semantic).toBeFalsy()
      expect(m!.data.completion).toBeFalsy()
    }).pipe(Effect.provide(layer)),
  )

  it.effect('projects a {Config} section as YAML for highlighting', () =>
    Effect.gen(function* () {
      const runtime = yield* Effect.runtime<LoomCompiler>()
      const cfg: Source = {
        read: () =>
          Effect.succeed(
            `{{lang: TypeScript}}\n\n# Workspace {Config}\n\nThe project's languages.\n\n=>\n\nlanguages:\n  typescript: {}\n`,
          ),
      }
      const root = Runtime.runSync(runtime)(
        LoomCompiler.pipe(Effect.flatMap((c) => c.compile(cfg, ''))),
      )
      // root → [frame, the {Config} product]; its body reads as YAML
      const product = root.embeddedCodes![1]!
      expect(product.languageId).toBe('yaml')
    }).pipe(Effect.provide(layer)),
  )
})
