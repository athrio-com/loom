import { Option } from 'effect'
import { describe, expect, it } from 'vitest'
import { producedOf, type Mod } from './frames'

// Two modules in one corpus each define a section named `Bit`. The frame's
// Effect.Service tag was once the bare section name, so the two `Bit` services
// collided in the wired corpus layer — one shadowed the other, and a section that
// referenced its own `Bit` could be handed the neighbour's. The tag is now the
// section's module-qualified identity (`<path>#<name>`), so the two stay distinct.
// The proof: a.loom's `UseA` must refer to a.loom's `Bit`, b.loom's `UseB` to
// b.loom's — never each other's.

const m = (name: string, text: string): Mod => ({ path: `/collide/${name}`, text })

const moduleSrc = (mark: string, use: string) => `{{lang: TypeScript}}

# A bit [Bit]

=>

const bit = "${mark}"

# Use it [${use}]

{{x = Bit}}

=>

::[x]
const ${use.toLowerCase()} = bit
`

const mainSrc = `{{lang: TypeScript}}

# Imports {Loom}

=>

import { UseA } from "./a.loom"
import { UseB } from "./b.loom"

# Both of them [Both]

{{a = UseA}}
{{b = UseB}}

=>

::[a]
::[b]
const both = 1
`

const a = m('a.loom', moduleSrc('A', 'UseA'))
const b = m('b.loom', moduleSrc('B', 'UseB'))
const main = m('main.loom', mainSrc)

const products = producedOf(a, b, main)

const codeAt = (path: string, name: string) =>
  products.get(path)?.code.find((c) => c.origin.name === name)

const refTargetOf = (path: string, name: string) => {
  const composed = codeAt(path, name)
  const ref = composed?.fragments.find((p) => p.type !== 'Fragment') as
    | { readonly target: Option.Option<{ path: string; name: string }> }
    | undefined
  return ref ? Option.getOrNull(ref.target) : undefined
}

describe('two modules defining the same section name do not collide', () => {
  it('runs the whole corpus — every module produces its de re', () => {
    expect(codeAt(a.path, 'UseA')).toBeDefined()
    expect(codeAt(b.path, 'UseB')).toBeDefined()
  })

  it('each section refers to its own Bit, not the neighbour with the same name', () => {
    // Were the bare-name tag still in use, both UseA and UseB would resolve to a
    // single shared `Bit`, and one of these targets would name the wrong file.
    expect(refTargetOf(a.path, 'UseA')).toEqual({ path: a.path, name: 'Bit' })
    expect(refTargetOf(b.path, 'UseB')).toEqual({ path: b.path, name: 'Bit' })
  })
})
