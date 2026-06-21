import { Effect, Option } from 'effect'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type RunOutput } from '#ast/FrameRunner'
import { DocumentSource, LoomCompiler } from '../src/LoomCompiler'
import { PackageConfig } from '../src/PackageConfig'

// Two modules in one corpus each define a section named `Bit`. The frame's
// Effect.Service tag was once the bare section name, so the two `Bit` services
// collided in the wired corpus layer — one shadowed the other, and a section that
// referenced its own `Bit` could be handed the neighbour's. The tag is now the
// section's module-qualified identity (`<path>#<name>`), so the two stay distinct.
// The proof: a.loom's `UseA` must refer to a.loom's `Bit`, b.loom's `UseB` to
// b.loom's — never each other's.

const dir = mkdtempSync(join(tmpdir(), 'loom-collide-'))
const a = join(dir, 'a.loom')
const b = join(dir, 'b.loom')
const main = join(dir, 'main.loom')

const moduleSrc = (mark: string, use: string) => `{{lang: TypeScript}}

# A bit [Bit]

=>

const bit = "${mark}"

# Use it [${use}]

{{x: Bit}}

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

{{a: UseA}}
{{b: UseB}}

=>

::[a]
::[b]
const both = 1
`

let output: RunOutput

beforeAll(async () => {
  writeFileSync(a, moduleSrc('A', 'UseA'))
  writeFileSync(b, moduleSrc('B', 'UseB'))
  writeFileSync(main, mainSrc)
  output = await Effect.runPromise(
    Effect.gen(function* () {
      const compiler = yield* LoomCompiler
      return (yield* compiler.composed(main)).output
    }).pipe(
      Effect.provide(LoomCompiler.Default),
      Effect.provide(DocumentSource.Default),
      Effect.provide(PackageConfig.Default),
    ),
  )
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

const refTargetOf = (path: string, name: string) => {
  const composed = output.code.get(path)?.get(name)
  const ref = composed?.parts.find((p) => p.type === 'Ref') as
    | { readonly target: Option.Option<{ path: string; name: string }> }
    | undefined
  return ref ? Option.getOrNull(ref.target) : undefined
}

describe('two modules defining the same section name do not collide', () => {
  it('runs the whole corpus — every module produces its de re', () => {
    expect(output.code.has(a)).toBe(true)
    expect(output.code.has(b)).toBe(true)
    expect(output.code.get(a)!.has('UseA')).toBe(true)
    expect(output.code.get(b)!.has('UseB')).toBe(true)
  })

  it('each section refers to its own Bit, not the neighbour with the same name', () => {
    // Were the bare-name tag still in use, both UseA and UseB would resolve to a
    // single shared `Bit`, and one of these targets would name the wrong file.
    expect(refTargetOf(a, 'UseA')).toEqual({ path: a, name: 'Bit' })
    expect(refTargetOf(b, 'UseB')).toEqual({ path: b, name: 'Bit' })
  })
})
