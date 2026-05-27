# Loom Frame — Reframing

## Sections as Services

Every Section in a Loom document projects to an `Effect.Service` class.
The Service exposes three fields: `name` — the heading text as a plain
string — `preamble` — the section's prose context — and `code` — the
composed product code (effectful, since composing it may resolve other
sections). This is the complete, uniform surface of every section in the Frame.

Sections without Warp declarations use `succeed:` — their fields are
static values, constructed once. Sections with Warp declarations use
`effect: Effect.gen(...)` — their fields depend on other sections resolved
through Effect's dependency injection. The shape is identical from the
outside; only the construction mechanism differs.

**Tags determine visibility.** A section with an explicit `[Tag]` is
exported — `export class Add extends Effect.Service...` — and forms part
of the document's public API, referenceable from other files via Warp
declarations. A tagless section is private — no `export`, not importable
across files. Its class name and service identifier are derived by hashing
the heading name. Tagless sections are reachable only within the same
document via name anchors in code blocks.

## Heading Levels and Document Structure

All headings — regardless of level — create sections. The document is a
flat `LoomSection[]` with no nesting, no parent containers. Heading levels
are prose organisation for the human reader; they carry no structural
meaning in the Frame. Lines before the first heading form the Document
Preamble — `document.preamble`.

## Warp Declarations and Name Anchors

There are two ways to reference another section from a code block.

**Warp declarations** — written in the preamble as `{{m: Mul}}` — are
explicit, tag-based dependency declarations. The Frame projects each
declaration into a `const m = yield* Mul` statement and a
`dependencies: [Mul.Default]` entry. The bound name `m` is then used as
an anchor `{{m}}` in the code block to inline the resolved `.code` field.
Cross-file Warp declarations generate an `import type` automatically.
Only exported (tagged) sections are reachable via Warp declarations.

**Name anchors** — written directly in the code block as
`{{Imports}}` or `{{Multiplier Function}}` — reference a private
(tagless) section within the same file by its heading name. The
synthesiser resolves the name to the section's hash, hoists a
`yield*` and `dependencies[]` entry internally, and inlines the
`.code` field at the anchor site. No preamble declaration is needed.
The internal binding name is hash-derived and not user-visible.

A single-word name anchor (`{{Imports}}`) is resolved as a preamble
Warp binding first; if no match is found, heading name lookup follows.

## Preamble as a First-Class Field

The section's preamble prose — everything written between the heading and
the `=>` Arrow, excluding Warp declarations — becomes the `preamble` field
on the Service's `succeed` or `return` object. It appears in two places:
as a TSDoc comment on the Service class (visible in IDE hover and
cross-references) and as a queryable string field at runtime. Post-tilde
prose is authoring context; it lives in the `.loom` source and is not
projected into the Frame.

## The Dependency Graph for Free

The complete dependency graph of any Loom document is a first-class
parse-time artifact. Warp annotations are the edges: each `{{m: Mul}}`
in a section's preamble is an explicit, named dependency edge to another
section. No analysis pass, no inference — the edges are the annotations,
and they are traversable directly from the AST.

Effect Layers are opaque at runtime: you can run a layer, not inspect
its dependency structure without executing. The graph the CLI walks is
the AST's Warp map, not the compiled Frame. The Frame's `dependencies:`
arrays and `yield*` calls faithfully reflect that map at the TypeScript
level — so Effect's DI actually executes the graph — but the authoritative,
traversable source is always the AST.

Each node in the Warp graph carries semantic content: the section's
`preamble` (why it exists and what it does) and the code it produces.
A CLI tool walks from any entry section through its Warp edges, collecting
structured context and code at every step — for documentation generation,
impact analysis, LLM prompt construction, or selective execution.

Effect's `Graph` module is a natural candidate for representing this
derived graph. It provides topological sort, depth-first and breadth-first
traversal, cycle detection, transitive reachability, and `toGraphViz` /
`toMermaid` output — all built-in. The AST itself remains Schema-defined
and serializable; `Graph` is a separate structure derived from the AST's
Warp annotations after parsing, used only for traversal and analysis.

## Emission Order and Cycles

The Frame synthesiser emits sections in topological order derived from the
Warp graph, not in document order. This is assumed to be necessary because
of how JavaScript class declarations behave.

A `class` declaration in JavaScript is subject to the Temporal Dead Zone
(TDZ): the name is hoisted into scope, but the binding is not initialised
until the declaration is actually evaluated at runtime. Accessing it before
that point throws a `ReferenceError`. Since `dependencies: [Mul.Default]`
is evaluated eagerly when `Sq`'s class body runs, `Mul` must already be
initialised — meaning it must appear earlier in the emitted file. If the
synthesiser emitted sections in document order and a dependency appeared
below its dependent, the Frame would throw at module load time.

Topological order resolves this: dependencies are always emitted before the
sections that depend on them. The Warp graph the synthesiser already builds
gives this order directly — no additional analysis pass is required.

Cycles are a related assumption. A same-file cycle (A's Warp names B, B's
names A) has no valid topological order and would produce a TDZ error
regardless of how the file is arranged. The synthesiser detects cycles via
the Warp graph and surfaces them as LSP diagnostics — inline squiggles in
the editor via Volar, not hard failures. The Frame is still emitted as best
as possible; the diagnostic annotates the offending Warp anchors in the
source. Loom's principle is to always produce the best possible projection
and speak through the language server, not to withhold output.

Both of these are assumptions pending confirmation against the actual
Effect runtime behaviour of `Effect.Service` and its `dependencies` field.

## Tangle Sections

File emission is declared in the source document, not in code. A section
whose specifier is a file path — `{src/main/scala/Arithmetic.scala}` rather
than a Tag label — is a tangle section. The specifier signals to the Frame
synthesiser that this section's purpose is emission, not composition.

The code block of a tangle section contains only Warp anchors:

```
## Tangling the library {src/main/scala/Arithmetic.scala}

Emits the complete arithmetic library.

{{i: Imports}}
{{m: Main}}

=>

{{i}}
{{m}}
```

Tangle sections use the same Warp mechanics as every other section. Preamble
Warp declarations (`{{i: Imports}}`, `{{m: Main}}`) are where tag resolution
happens and dependencies are declared. Code block anchors (`{{i}}`, `{{m}}`)
dereference the bound names to inline the resolved `.code` fields in order.
The synthesiser generates `yield*` and `dependencies[]` from the preamble
declarations, and wraps the composed result in a `tangle(path, ...)` call
instead of returning `{ name, preamble, code }`. No special anchor form,
no shortcut — consistent Warp syntax throughout.

A tangle section is a sink in the Warp graph: other sections never declare
it as a dependency. It consumes the graph; nothing consumes it. Tangle
sections are always tagless — private by convention. The synthesiser
recognises a file path specifier by the presence of path separators,
distinguishing it from a Tag label without additional syntax.

## The `{Loom}` Specifier

A `{Loom}` specifier marks a section as a power-user escape hatch. Its
code block is projected literally into the Frame as-is — raw
TypeScript/Effect code that bypasses the standard Service projection. This
is for cases the projection model does not cover: custom runtime setup,
low-level Effect wiring, or anything that requires direct access to the
Frame's TypeScript surface.

`{Loom}` sections carry no dependency management role. Cross-file
dependencies are declared via Warp annotations on individual sections and
wired automatically by the synthesiser. There is no module-level dependency
DSL; Effect's DI derives the full graph from Warp declarations alone.

## Providing Dependencies

Loom owns the composition root. The Frame synthesises a top-level
provision automatically — it identifies which sections are roots of the
dependency graph (sections that no other section depends on), assembles
their `Default` layers, and emits the `Effect.provide` call. The user
writes sections and declares Warps. Loom derives the full wiring from
that and generates it into the Frame. The user never writes imports,
never assembles layers manually, and never touches the entry point.

## What This Enables

The combination — uniform Services, Warp graph in the AST, preamble as
data, automatic DI — makes the Frame a semantic index of the document,
not just a type-checking surface. The IDE uses the Frame for navigation
and diagnostics. The CLI uses the AST's Warp graph for context-aware
tooling. Effect uses the Frame for execution. All three consumers read
from the same source document, with no duplication.

## Example Loom Document Frame

```typescript
// =============================================================================
// SynthesizedFrameExample.ts
//
// Synthesized Frame for arithmetic.loom.
//
// Projection rules:
//   - Tagged sections  → export class — public API, importable cross-file.
//   - Tagless sections → class (no export) — private, same-file only.
//   - Sections emitted in topological order (dependencies before dependents).
//   - Explicit [Tag]  → class name = tag label, service identifier = tag label.
//   - No [Tag]        → class name = hash of heading name, identifier = same hash.
//   - Heading name stored as `name` field on every section.
//   - Preamble Warp declaration ({{a: Add}}) → yield* + dependencies[].
//   - Name anchor ({{Imports}}) in code block → internal yield* by hash, hoisted.
//   - Tangle section ({path} specifier) → private, tangle() return, graph sink.
//   - {Loom} specifier → code block projected literally (escape hatch only).
//   - Composition root → auto-synthesised by Loom from graph leaf analysis.
//   - compose / tangle are provisional primitives — module home not yet built
//     (see how-lsp.md). There is no separate Code value type; product code is
//     the AST's CodeWeft text. The import below is illustrative.
// =============================================================================

import { compose, tangle } from "@literate/core"
import { Effect, Layer } from "effect"


// =============================================================================
// Private sections — tagless, no export, same-file only
// =============================================================================

// # Imports — name anchor target: {{Imports}}
class S_f1e7d2 extends Effect.Service<S_f1e7d2>()("S_f1e7d2", {
  succeed: {
    name:     `Imports`,
    preamble: `Provides the only outside dependency.`,
    code: compose(`import scala.math.pow`)
  }
}) {}


// =============================================================================
// Public sections — tagged, exported
// =============================================================================

export class Add extends Effect.Service<Add>()("Add", {
  succeed: {
    name:     `Adder`,
    preamble: `Adds two integers.`,
    code: compose(`def add(x: Int, y: Int): Int = x + y`)
  }
}) {}


export class Mul extends Effect.Service<Mul>()("Mul", {
  succeed: {
    name:     `Multiplier`,
    preamble: `Multiplies two integers.`,
    code: compose(`def mul(x: Int, y: Int): Int = x * y`)
  }
}) {}


export class Sq extends Effect.Service<Sq>()("Sq", {
  effect: Effect.gen(function* () {
    const _S_f1e7d2 = yield* S_f1e7d2   // {{Imports}} — hoisted internally
    return {
      name:     `Square`,
      preamble: `Built on top of mul.`,
      code: compose(_S_f1e7d2.code, `def square(x: Int): Int = mul(x, x)`)
    }
  }),
  dependencies: [S_f1e7d2.Default]
}) {}


export class Pow extends Effect.Service<Pow>()("Pow", {
  effect: Effect.gen(function* () {
    const _S_f1e7d2 = yield* S_f1e7d2   // {{Imports}} — hoisted internally
    return {
      name:     `Power`,
      preamble: `\`pow\` works in \`Double\`; the result is rounded back to \`Int\`.`,
      code: compose(_S_f1e7d2.code, `def power(base: Int, exp: Int): Int = pow(base, exp).toInt`)
    }
  }),
  dependencies: [S_f1e7d2.Default]
}) {}


export class Main extends Effect.Service<Main>()("Main", {
  effect: Effect.gen(function* () {
    const a = yield* Add
    const s = yield* Sq
    const p = yield* Pow
    return {
      name:     `Entry point`,
      preamble: `Smoke tests for Add, Sq, and Pow.`,
      code: compose(
        a.code,
        s.code,
        p.code,
        `object Arithmetic extends App {
  println(s"add(2, 3)    = ${add(2, 3)}")
  println(s"mul(4, 5)    = ${mul(4, 5)}")
  println(s"square(7)    = ${square(7)}")
  println(s"power(2, 10) = ${power(2, 10)}")
}`
      )
    }
  }),
  dependencies: [Add.Default, Sq.Default, Pow.Default]
}) {}


export class Build extends Effect.Service<Build>()("Build", {
  succeed: {
    name:     `Build script`,
    preamble: `Compile the single file, then run the resulting class.`,
    code: compose(
`#!/usr/bin/env bash
scalac src/main/scala/Arithmetic.scala -d out
scala -cp out Arithmetic`
    )
  }
}) {}


// =============================================================================
// Tangle sections — private sinks, hash-derived names, no export
// =============================================================================

// # Tangling the library {src/main/scala/Arithmetic.scala}
class S_d2c5b9 extends Effect.Service<S_d2c5b9>()("S_d2c5b9", {
  effect: Effect.gen(function* () {
    const i = yield* S_f1e7d2
    const m = yield* Main
    return tangle("src/main/scala/Arithmetic.scala", compose(i.code, m.code))
  }),
  dependencies: [S_f1e7d2.Default, Main.Default]
}) {}


// # Tangling the build script {scripts/build.sh}
class S_a1b3c7 extends Effect.Service<S_a1b3c7>()("S_a1b3c7", {
  effect: Effect.gen(function* () {
    const b = yield* Build
    return tangle("scripts/build.sh", b.code)
  }),
  dependencies: [Build.Default]
}) {}


// =============================================================================
// Auto-synthesised composition root — emitted by Loom, not by the user.
// Graph leaves: S_d2c5b9, S_a1b3c7.
// =============================================================================

export const LoomMain = Effect.provide(
  Effect.gen(function* () {
    yield* S_d2c5b9
    yield* S_a1b3c7
  }),
  Layer.merge(S_d2c5b9.Default, S_a1b3c7.Default)
)
```
