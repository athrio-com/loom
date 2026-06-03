import { describe, expect, it } from '@effect/vitest'
import { Effect, Layer, Runtime } from 'effect'
import { Loom } from '#ast/Loom'
import { Resolver } from '#projectors/Resolver'
import { Synthesiser } from '#projectors/Synthesiser'
import { Transducer } from '#projectors/Transducer'
import { loomVirtualCode, stringSnapshot } from '../src/VirtualCode'

// VirtualCode dispatches the projections and assembles the Volar tree. For now
// that is root (loom) → frame (typescript) from the Synthesiser; the de re
// product codes (Resolver) are not wired, so the frame's `embeddedCodes` is
// empty. The probes capture a *warm* runtime (layers built) and then
// `Runtime.runSync` the projection — exactly what the plugin does on Volar's
// synchronous callback. A cold runtime would throw on the async layer build;
// this proves the per-call projection resolves synchronously on a warm one.

const layer = Layer.mergeAll(
  Loom.Default,
  Transducer.Default,
  Synthesiser.Default,
  Resolver.Default,
)

const input = `{{lang: TypeScript}}

# Adder [Add]

Adds two integers.

=>

export const add = (x: number, y: number): number => x + y
`

describe('VirtualCode — root → frame projection', () => {
  it.effect('builds the tree via Runtime.runSync on a warm runtime', () =>
    Effect.gen(function* () {
      const runtime = yield* Effect.runtime<Loom | Transducer | Synthesiser | Resolver>()
      const root = Runtime.runSync(runtime)(loomVirtualCode(stringSnapshot(input)))

      expect(root.id).toBe('root')
      expect(root.languageId).toBe('loom')
      // root → [frame (de dicto), Add (de re product)]
      expect(root.embeddedCodes).toHaveLength(2)

      const frame = root.embeddedCodes![0]!
      expect(frame.id).toBe('frame')
      expect(frame.languageId).toBe('typescript')
      expect(frame.embeddedCodes).toEqual([]) // the frame has no children
      const gen = frame.snapshot.getText(0, frame.snapshot.getLength())
      expect(gen).toContain('export class Add')
      expect(frame.mappings.length).toBeGreaterThan(0)

      // the de re product for the Add section — its raw code, in its language
      const product = root.embeddedCodes![1]!
      expect(product.id).toBe('Add')
      expect(product.languageId).toBe('typescript')
      expect(
        product.snapshot.getText(0, product.snapshot.getLength()),
      ).toContain('export const add = (x: number, y: number)')
    }).pipe(Effect.provide(layer)),
  )

  it.effect('maps the frame class name back to the [Add] tag in the .loom', () =>
    Effect.gen(function* () {
      const runtime = yield* Effect.runtime<Loom | Transducer | Synthesiser | Resolver>()
      const root = Runtime.runSync(runtime)(loomVirtualCode(stringSnapshot(input)))

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
    }).pipe(Effect.provide(layer)),
  )
})
