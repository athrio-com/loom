import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { Loom } from "#ast/Loom"
import { Document } from "#projectors/synth/Frame"

// =============================================================================
// Frame — integration against a trivial single-section input.
//
// Frame.ts is the projector: a `LoomDocument` flows in, the projected
// TypeScript Frame flows out. This suite drives one minimal fixture —
// one tagged Section, no preamble Warps, no tangle sinks — and
// asserts the surface features of the projection rather than its
// exact whitespace. That keeps the test stable against cosmetic
// shifts in the templates (blank-line spacing, trailing newlines,
// indentation) while still pinning the structural choices: an import
// header, an `export class` wrapper, a static-branch `succeed:` body
// with `name`/`preamble`/`code` fields, the closing `) {}`.
//
// Tests at this level treat `Document` as the entry point. The
// projector's individual templates (`Imports`, `ExportedSection`,
// `StaticBody`, …) are exercised transitively through it. They are
// individually exported and can be tested in isolation when finer
// coverage is needed; for the trivial fixture the integration view
// suffices.
// =============================================================================

const trivialInput = `{{lang: TypeScript}}

# Adder [Add]

Adds two integers.

=>

export const add = (x: number, y: number): number => x + y
`

// `project` is the test-side runtime entry point: parse the input
// `.loom` via `Loom`, hand the resulting AST to `Document`, and run
// the composed `Effect` to a string. `runSync` is acceptable here —
// we are at the test's outermost boundary, where the Effect program
// gets executed against the test runner.
const project = (input: string): string =>
  Effect.runSync(
    Effect.gen(function* () {
      const loom = yield* Loom
      const ast  = yield* loom.ast(input)
      return yield* Document(ast)
    }).pipe(Effect.provide(Loom.Default)),
  )

describe("Frame — trivial projection", () => {
  const output = project(trivialInput)

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
