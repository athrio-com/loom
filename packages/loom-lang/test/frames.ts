import { Effect } from 'effect'
import type { Code, Product } from '@athrio/loom-ast/ProductAst'
import { parseDocument, ParseLayer } from './parse'
import { buildFrame } from '#ast/FrameAstBuilder'
import { FrameRunner } from '#ast/FrameRunner'
import { fromFrame } from '#ast/LoomVirtualCodeBuilder'

// Shared harness for the runner-behaviour tests. FrameRunner.produce takes a map of
// path to frame text and returns one Product per module, so these helpers build the
// frames from in-memory sources and run them directly — no compiler, no disk. Cross-
// file imports resolve by the paths used here (a `"./x.loom"` import resolves against
// the importing module's path).

export type Mod = { readonly path: string; readonly text: string }

export const framesOf = (...mods: ReadonlyArray<Mod>): Map<string, string> =>
  new Map(
    mods.map((m) => {
      const doc = Effect.runSync(
        parseDocument(m.text).pipe(Effect.provide(ParseLayer)),
      )
      return [m.path, fromFrame(buildFrame(doc, m.path)).code] as const
    }),
  )

export const producedOf = (
  ...mods: ReadonlyArray<Mod>
): ReadonlyMap<string, Product> =>
  Effect.runSync(
    FrameRunner.pipe(
      Effect.flatMap((r) => r.produce(framesOf(...mods))),
      Effect.provide(FrameRunner.Default),
    ),
  )

// The de re as a per-path map of section name to its composed code — the view these
// tests read, rebuilt from each module's product.code array.
export const codeView = (
  products: ReadonlyMap<string, Product>,
): ReadonlyMap<string, ReadonlyMap<string, Code>> =>
  new Map(
    [...products].map(([path, product]) => [
      path,
      new Map(product.code.map((c) => [c.origin.name, c])),
    ]),
  )
