import { describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import { parseDocument, ParseLayer } from './parse'
import { buildProduct } from '#ast/ProductBuilder'
import type { LoomModule, Path } from '@athrio/loom-ast/LoomCorpusAst'
import { rootNamesAt } from '#ast/LoomVirtualCodeBuilder'

// rootNamesAt decides which sections are composition roots. The rule: a section is
// a root until another same-file section folds it in. Every reference is a
// same-file NameRef — a `::[…]` name anchor — and it demotes its target to a
// fragment of the referrer. A section nothing names stays a root. These tests pin
// that rule, building each module's de re `Product` from real `.loom` source so the
// names come off the pass under test, not a hand-built fixture.

const moduleOf = (path: Path, text: string): LoomModule => {
  const doc = Effect.runSync(parseDocument(text).pipe(Effect.provide(ParseLayer)))
  return { path, text, doc, product: buildProduct(doc, path) }
}

const corpus = (
  ...mods: ReadonlyArray<readonly [Path, string]>
): ReadonlyMap<Path, LoomModule> =>
  new Map(mods.map(([path, text]) => [path, moduleOf(path, text)] as const))

describe('rootNamesAt — which sections are composition roots', () => {
  it('demotes a same-file target a name anchor names', () => {
    // Main names Helper with `::[Helper]`, so Helper folds into Main and only Main
    // is left a root.
    const main = `---
Language: TypeScript
---

# Main

=>

::[Helper]
const m = 1

# Helper

=>

const h = 1
`
    const modules = corpus(['a.loom', main])
    expect(rootNamesAt(modules, 'a.loom')).toEqual(new Set(['main']))
  })

  it('keeps a section nothing names a root of its own', () => {
    // Neither section references the other, so both stay roots.
    const both = `---
Language: TypeScript
---

# Main

=>

const m = 1

# Aside

=>

const a = 2
`
    const modules = corpus(['a.loom', both])
    expect(rootNamesAt(modules, 'a.loom')).toEqual(new Set(['main', 'aside']))
  })
})
