import { describe, expect, it } from '@effect/vitest'
import { Effect, Layer, Option } from 'effect'
import type { VirtualCode } from '@volar/language-core'
import type { Source } from '#ast/LoomCorpusAstBuilder'
import { DocumentSource, LoomCompiler } from '../src/LoomCompiler'
import { PackageConfig } from '../src/PackageConfig'

// A type error never gates the de re. `funtype` carries a section with a type error
// (`const bad: number = "oops"`) beside a healthy one. The run composes every
// section's de re regardless — composition assembles text, it does not type-check —
// so a type error in one section costs no section its product. The error itself
// surfaces in the editor through the product's own TypeScript service, a separate
// concern from whether the de re is produced.

const input = `---
Language: TypeScript
---

# Typed badly

=>

const bad: number = "oops"

# Negated double

=>

const negate = (x: number) => -x
const negDouble = (x: number) => negate(x) * 2
`

const source: Source = {
  read: () => Effect.succeed(input),
  list: Option.none(),
}

const layer = Layer.provide(
  LoomCompiler.Default,
  Layer.merge(DocumentSource.Default, PackageConfig.Default),
)

// the de re product for a section is its embedded code, keyed by the section name
// lowercased (`# Negated double` → `negateddouble`).
const productOf = (root: VirtualCode, id: string): string => {
  const find = (vc: VirtualCode): VirtualCode | undefined =>
    vc.id === id ? vc : (vc.embeddedCodes ?? []).map(find).find(Boolean)
  const found = find(root)
  return found ? found.snapshot.getText(0, found.snapshot.getLength()) : ''
}

describe('a type error does not gate the de re', () => {
  it.effect('composes every section despite a type error in one', () =>
    Effect.gen(function* () {
      const root = yield* LoomCompiler.pipe(
        Effect.flatMap((c) => c.compile(source, '/funtype.loom')),
      )
      // the healthy section composes
      expect(productOf(root, 'negateddouble')).toContain(
        'const negate = (x: number) => -x',
      )
      // the type-error section composes too — the run assembles text, never checks it
      expect(productOf(root, 'typedbadly')).toContain('const bad: number = "oops"')
    }).pipe(Effect.provide(layer)),
  )
})
