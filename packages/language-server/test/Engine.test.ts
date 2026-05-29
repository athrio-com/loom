import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { Loom } from "#ast/Loom"
import type { LoomDocument } from "#ast/LoomAst"
import { Engine } from "#projectors/synth/Engine"

// =============================================================================
// Engine — integration against `frame-synth.loom` as the rules document.
//
// Minimum-first phase. The fixture below is a one-section, no-Warp,
// no-tangle input. The expected projection is a single `Effect.Service`
// class with a `succeed: { name, preamble, code }` body — the static
// branch of `serviceBody`. The engine reads the rules from disk, parses
// the input fixture, and produces the projected text. Assertions target
// the surface features (the wrapper, the body fields, the export
// visibility) rather than exact whitespace, so cosmetic shifts in the
// rules' template don't ripple through.
// =============================================================================

const rulesPath   = resolve(__dirname, "../src/projectors/synth/frame-synth.loom")
const rulesSource = readFileSync(rulesPath, "utf8")

const ast = (text: string): LoomDocument =>
  Effect.runSync(
    Effect.gen(function* () {
      const loom = yield* Loom
      return yield* loom.ast(text)
    }).pipe(Effect.provide(Loom.Default)),
  )

const render = (input: string): string =>
  Effect.runSync(
    Effect.gen(function* () {
      const engine = yield* Engine
      return engine.render(ast(rulesSource), rulesSource, ast(input), input)
    }).pipe(
      Effect.provide(Loom.Default),
      Effect.provide(Engine.Default),
    ),
  )

// =============================================================================
// Trivial input — one tagged Section, no Warps, no tangle sinks. Projects
// to one exported Service class with the static `succeed:` branch.
// =============================================================================

const trivialInput = `{{lang: TypeScript}}

# Adder [Add]

Adds two integers.

=>

export const add = (x: number, y: number): number => x + y
`

describe("Engine — trivial projection", () => {
  const output = render(trivialInput)

  it("emits the core import header", () => {
    expect(output).toContain(`import { Effect } from "effect"`)
  })

  it("emits an exported Service class named after the section tag", () => {
    expect(output).toContain(
      `export class Add extends Effect.Service<Add>()("Add",`,
    )
  })

  it("emits a static-branch service body with the heading text as `name`", () => {
    expect(output).toContain("name: `Adder`")
  })

  it("emits the section's preamble prose as `preamble`", () => {
    expect(output).toContain("preamble: `Adds two integers.`")
  })

  it("emits the section's product code as `code`", () => {
    expect(output).toContain(
      "code: `export const add = (x: number, y: number): number => x + y`",
    )
  })

  it("closes the class declaration", () => {
    expect(output).toContain(") {}")
  })
})
