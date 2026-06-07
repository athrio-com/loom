import { describe, expect, it } from '@effect/vitest'
import { Effect, Option } from 'effect'
import { Loom } from '#ast/Loom'
import { buildFrame } from '#ast/FrameAstBuilder'
import { buildCode, type ModuleInput } from '#ast/ProductAstBuilder'

// buildCode is the de re structure pass, per module: Frame AST → `code`
// (name → ComposedCode). Each content section becomes a ComposedCode whose parts
// are Fragments (own product text, sliced from source) and Refs (resolved edges —
// a local section, or cross-file via the module's import bindings; an unresolved
// binding is `Option.none`). Flattening to text is fromProduct's job (see
// LoomVirtualCodeBuilder.test); here we check the structure it produces.

const parse = (src: string) =>
  Effect.runSync(
    Effect.gen(function* () {
      const loom = yield* Loom
      return yield* loom.ast(src)
    }).pipe(Effect.provide(Loom.Default)),
  )

const sad = `{{lang: TypeScript}}

# Negate [Neg]

=>

const negate = (x: number) => -x
`

const fun = `{{lang: TypeScript}}

# Imports {Loom}

=>

import { Neg } from "./Sad.loom"

# Negated double [Negd]

{{n: Neg}}

=>

{{n}}
const negDouble = (x: number) => negate(x) * 2
`

const sadMod: ModuleInput = {
  path: '/Sad.loom',
  text: sad,
  frame: buildFrame(parse(sad)),
  imports: new Map(),
}
const funMod: ModuleInput = {
  path: '/Fun.loom',
  text: fun,
  frame: buildFrame(parse(fun)),
  imports: new Map([['Neg', '/Sad.loom']]),
}
const sadCode = buildCode(sadMod)
const funCode = buildCode(funMod)

describe('ProductAstBuilder — per-module code map', () => {
  it('builds one ComposedCode per content section, keyed by name', () => {
    expect([...sadCode.keys()]).toEqual(['Neg'])
    expect([...funCode.keys()]).toEqual(['Negd'])
  })

  it('resolves a cross-file Ref target to the imported module + name', () => {
    const negd = funCode.get('Negd')!
    const targets = negd.parts.flatMap((p) =>
      p.type === 'Ref' ? [Option.getOrNull(p.target)] : [],
    )
    // the {{n}} anchor resolves the binding `n` ↦ tag `Neg` ↦ /Sad.loom.
    expect(targets).toContainEqual({ path: '/Sad.loom', name: 'Neg' })
  })

  it('a section with no transclusions is all Fragments', () => {
    const neg = sadCode.get('Neg')!
    expect(neg.parts.every((p) => p.type === 'Fragment')).toBe(true)
  })
})
