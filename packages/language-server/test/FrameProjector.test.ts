import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { Loom } from "#ast/Loom"
import { projectDocument } from "#projectors/FrameProjector"

// =============================================================================
// FrameProjector — integration against a trivial single-section input.
//
// The projector takes a parsed `LoomDocument` and produces a
// `Mapped` — generated TypeScript code paired with source-to-
// generated mapping records. This suite drives one minimal fixture
// (one tagged Section, no preamble Warps, no tangle sinks) and
// asserts both halves of the output: the surface shape of the
// `genCode` (import header, `export class` wrapper, static-branch
// body) and that at least one mapping ties a known span of the
// generated code back to its position in the input AST.
//
// Surface assertions are intentionally loose with respect to
// whitespace. AST sources are transferred 1:1 — heading text
// carries its trailing space before `[Tag]`, body wefts carry
// their EOLs — so the projected output is byte-faithful rather
// than cosmetically trimmed. The tests check that the structural
// landmarks appear in the code, not their exact framing.
// =============================================================================

const trivialInput = `{{lang: TypeScript}}

# Adder [Add]

Adds two integers.

=>

export const add = (x: number, y: number): number => x + y
`

// `project` is the test-side runtime entry point: parse the input
// `.loom` via `Loom`, hand the resulting AST to `projectDocument`,
// and run the composed `Effect` to a `Mapped`. `runSync` is
// acceptable here — we're at the test's outermost boundary, where
// the Effect program gets executed against the test runner.
const project = (input: string) =>
  Effect.runSync(
    Effect.gen(function* () {
      const loom = yield* Loom
      const ast  = yield* loom.ast(input)
      return yield* projectDocument(ast)
    }).pipe(Effect.provide(Loom.Default)),
  )

describe("FrameProjector — trivial projection", () => {
  const result = project(trivialInput)

  it("emits the core import header", () => {
    expect(result.genCode).toContain(`import { Effect } from "effect"`)
  })

  it("emits an exported Service class named after the section tag", () => {
    expect(result.genCode).toContain(
      `export class Add extends Effect.Service<Add>()("Add",`,
    )
  })

  it("carries the section's heading text into the `name` field", () => {
    expect(result.genCode).toContain("Adder")
    expect(result.genCode).toContain("name: `")
  })

  it("carries the section's preamble prose into the `preamble` field", () => {
    expect(result.genCode).toContain("preamble: `")
    expect(result.genCode).toContain("Adds two integers.")
  })

  it("carries the section's product code into the `code` field", () => {
    expect(result.genCode).toContain(
      "export const add = (x: number, y: number): number => x + y",
    )
    expect(result.genCode).toContain("code: `")
  })

  it("maps the projected preamble prose back to a source PreambleWeft", () => {
    const proseMappings = result.mappings.filter((mp) => mp.kind === "prose")
    expect(proseMappings.length).toBeGreaterThan(0)
    // The prose line "Adds two integers.\n" must appear among the
    // mapped source spans.
    const sources = proseMappings.map((mp) =>
      trivialInput.slice(mp.sourcePosition.start.offset, mp.sourcePosition.end.offset),
    )
    expect(sources).toContain("Adds two integers.\n")
  })

  it("closes the class declaration", () => {
    expect(result.genCode).toContain(") {}")
  })

  // Mapping side: the projected class name `Add` must trace back
  // to the `[Add]` heading position in the input. We find the
  // mapping whose generated span covers the first `Add` occurrence
  // in `export class Add` and assert its source span sits at the
  // tag-label offsets recorded by the AST.
  it("maps the projected class name back to the heading tag label", () => {
    const classNameStart =
      result.genCode.indexOf(`export class `) + `export class `.length
    const mapping = result.mappings.find(
      (mp) =>
        mp.genStart <= classNameStart &&
        mp.genStart + mp.genLength > classNameStart,
    )
    expect(mapping).toBeDefined()
    expect(mapping?.kind).toBe("identifier")
    // The input fragment "[Add]" sits inside `# Adder [Add]`; the
    // tag label "Add" occupies the span between the brackets —
    // offset of `A` is exactly after `# Adder [`.
    const tagLabelStart = trivialInput.indexOf("Add", trivialInput.indexOf("[Add]"))
    expect(mapping?.sourcePosition.start.offset).toBe(tagLabelStart)
  })
})
