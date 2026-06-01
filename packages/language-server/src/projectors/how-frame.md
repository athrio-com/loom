# Loom Frame — Reframing

This spec owns two arrows of Loom's transformation pipeline: **transduce**
(`LoomDocument` → `FrameModule`, a macro tree transducer) and **synthesise**
(`FrameModule` → the Frame's synthetic code + source mappings — one projection
of the Frame, a catamorphism with L-attributed offsets). `how-lsp.md` → The
Transformation Pipeline frames the whole chain.

## The Output AST

The Frame is materialised as `FrameModule` — the output AST (`FrameAst.ts`), the
target of `transduce` and the source of `synthesise`. Every byte of the
generated frame is a **token**, of one of two kinds by origin:

- **`FrameSynthToken`** — Loom's predefined glue: keywords, punctuation, the
  separators between list items. It has no `.loom` origin, so it carries **no
  mapping**. (These are the schema's own literals; the constructor fills them, so
  `transduce` supplies only the holes.)
- **`FrameAuthoredToken`** — a span lifted from the `.loom` (a name, a tag, a
  bound variable, a preamble) that resolves into the frame. It carries its
  `source`, hence **one mapping**. Its `kind` (`identifier` | `prose`) selects
  which features the language service forwards there.

**Mapping belongs to authored tokens, never to synth.** A mapping links a
generated span to its `.loom` origin; synth glue has no origin, so it can be no
endpoint — it sits in the unmapped gaps between authored tokens. The
synth/authored and unmapped/mapped splits are one line seen twice: a token has a
`source` iff it is authored.

The two **code blocks** are authored as well, so both are mapped — they differ
only in which virtual code answers for them:

- **`FrameCode`** — a `{Loom}` block, raw de dicto frame code; **always
  TypeScript**, mapping into the one frame virtual code (tsc).
- **`EmbeddedCode`** — a `=>` block, de re product code; mapping into the
  section's **product** virtual code, served by that language's service —
  proxied to the relevant LSP, whatever the section's specifier declares.

So `FrameAuthoredToken` and `FrameCode` answer through the single TypeScript
frame; only `EmbeddedCode` is routed elsewhere (see `how-lsp.md` → The Two Planes
and Composition Drives Type Resolution).

Rendering is the in-order projection of this tree — it emits each token as
declared and introduces no text of its own; no separator, no glue, is applied
"somewhere else". The form is minimal and canonical: the Frame is virtual code
(mapped, not read), carrying only the spacing TypeScript requires. A
pretty-printer is never run over it — derived offsets would shift and the
mappings break — so the canonical form *is* the schema.

## Sections as Services

Every Section in a Loom document projects to an `Effect.Service` class — with
one exception, the `{Loom}` escape hatch (below), whose code splices into the
frame unwrapped. The Service exposes three fields: `name` — the heading text as a plain
string — `preamble` — the section's prose context — and `code` — the
composed product code (effectful, since composing it may resolve other
sections). The `code` field is always a `compose(…)` call — a section with no
transclusions composes its single own fragment — so the shape stays uniform.
This is the complete, uniform surface of every section in the Frame.

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
declaration into a single `const m = yield* Mul` statement inside the
Service's `Effect.gen` body. That `yield*` *is* the dependency: Effect
lifts the `Mul` requirement into the Service's layer type
automatically, so the Frame emits **no** separate `dependencies` array
(see Order Independence below for why that matters). The bound name `m`
is then used as an anchor `{{m}}` in the code block to inline the
resolved `.code` field. When the referenced tag lives in another
`.loom` file, the author brings it into scope with an import; Loom
does not resolve the path (see Cross-Module Dependencies). Only
exported (tagged) sections are reachable via Warp declarations.

**Name anchors** — written directly in the code block as
`{{Imports}}` or `{{Multiplier Function}}` — reference a private
(tagless) section within the same file by its heading name. The
synthesiser resolves the name to the section's hash, hoists a
`yield*` for it internally (the same lazy dependency mechanism as a
Warp declaration), and inlines the `.code` field at the anchor site.
No preamble declaration is needed. The internal binding name is
hash-derived and not user-visible.

A single-word name anchor (`{{Imports}}`) is resolved as a preamble
Warp binding first; if no match is found, heading name lookup follows.

## Composition Is Homogeneous

A composition edge — a Warp declaration or a name anchor — inlines one section's
code into another's. That is only meaningful when both sections carry the
**same specifier**: Scala composes Scala, JSON composes JSON. A cross-specifier
edge has no valid product — there is no single language in which both fragments
form one program — so it is a diagnostic on the offending anchor, not a silent
splice.

The specifier is the whole key; there is no separate plane axis. `{Loom}` is its
own specifier — TypeScript de facto, but never interchangeable with
`{TypeScript}`, and product TypeScript is never treated as frame code. A `{Loom}`
section is not in the composition graph at all (see The `{Loom}` Specifier): it
can be neither a Warp nor an anchor target, so it never enters the homogeneity
check — the rule governs product↔product edges alone.

## Preamble as a First-Class Field

The section's preamble prose — everything written between the heading and
the `=>` Arrow — becomes the `preamble` field on the Service's `succeed`
or `return` object, mapped 1:1: the PreambleWefts are transferred
byte-for-byte, EOLs and blank lines included, exactly as code is. Warp
declarations are *not* excised — a `{{m: Mul}}` sitting in the prose is
part of what the author wrote and appears verbatim in the field. (The
Warp's role as a dependency is carried separately by the `yield*` the
projector emits; excising its span here would only fragment the prose and
break the 1:1 mapping.) The preamble appears in two places, from the one
source span: as a raw `/** … */` TSDoc block above the class (minimal — no
per-line gutter; visible in IDE hover) and as the queryable `preamble` field.
Each occurrence is escaped where it sits — the TSDoc escapes `*/`, the field
escapes `` ` `` and `${` — so the two generated texts differ while both map
back to the same prose span. Post-tilde prose is authoring
context; it lives in the `.loom` source and is not projected into the
Frame.

## The Dependency Graph for Free

The complete dependency graph of any Loom document is a first-class
parse-time artifact. Warp annotations are the edges: each `{{m: Mul}}`
in a section's preamble is an explicit, named dependency edge to another
section. No analysis pass, no inference — the edges are the annotations,
and they are traversable directly from the AST.

Effect Layers are opaque at runtime: you can run a layer, not inspect
its dependency structure without executing. The graph the CLI walks is
the AST's Warp map, not the compiled Frame. The Frame's `yield*` calls
faithfully reflect that map at the TypeScript level — so Effect's DI
actually executes the graph — but the authoritative, traversable source
is always the AST.

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

## Order Independence and Cycles

The Frame synthesiser emits sections in **document order** — the order
they appear in the source is the order they appear in the Frame. There
is no topological sort and no dependency-driven reordering.

This works because no class declaration references another class
*eagerly*. A projected Service has the shape:

```typescript
export class Sq extends Effect.Service<Sq>()("Sq", {
  effect: Effect.gen(function* () {
    const m = yield* Mul
    return { … }
  })
}) {}
```

The only reference to `Mul` is `yield* Mul`, and it lives inside the
generator body that `Effect.gen` wraps but does not run. At module-load
time the generator function is created, `Mul` is captured by closure,
and nothing is evaluated. `Mul` is touched only when the effect later
runs — by which point every class in the module is initialised. The
declaration is *analysed, not evaluated*; declaration order is
irrelevant.

What would break this is an eager reference. The natural one to reach
for is `Effect.Service`'s `dependencies: [Mul.Default]` option — but
that array is an argument to the `Effect.Service<Sq>()(…)` call in the
`extends` clause, evaluated the instant `class Sq` is reached. A `class`
declaration in JavaScript is subject to the Temporal Dead Zone (TDZ):
the name is hoisted into scope, but the binding is not initialised until
the declaration is evaluated. If `Mul` were declared below `Sq`,
`Mul.Default` would be in the TDZ and throw a `ReferenceError` at module
load. The Frame therefore **does not emit `dependencies` arrays at all**.
The dependency is carried by the lazy `yield*` alone.

The trade-off: a Service's `.Default` layer is no longer self-contained.
`Sq.Default` has type `Layer<Sq, never, Mul>` — it *requires* `Mul` from
outside rather than bundling it. Loom owns the composition root and
satisfies every requirement there (see Providing Dependencies), so this
is invisible to the author.

Cycles. A genuine same-file cycle (A's Warp names B, B's names A) is a
real error — Effect cannot build a layer set with a circular
requirement. But detecting it is now decoupled from emission: the Frame
emits in document order regardless, and the cycle surfaces as an LSP
diagnostic on the offending Warp anchors, walked from the AST's Warp
graph. Loom's principle holds — always produce the best possible
projection and speak through the language server, never withhold output.

The lazy-`yield*` mechanism is plain JavaScript and Effect semantics; the
root-wiring form it depends on is noted as pending confirmation in
Providing Dependencies.

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
The synthesiser generates one lazy `yield*` per preamble declaration (no
`dependencies` array, exactly as for an ordinary section), and wraps the
composed result in a `tangle(path, ...)` call instead of returning
`{ name, preamble, code }`. No special anchor form, no shortcut —
consistent Warp syntax throughout.

A tangle section is a sink in the Warp graph: other sections never declare
it as a dependency. It consumes the graph; nothing consumes it. Tangle
sections are always tagless — private by convention. The synthesiser
recognises a file path specifier by the presence of path separators,
distinguishing it from a Tag label without additional syntax.

## The `{Loom}` Specifier

A `{Loom}` specifier marks a section as a power-user escape hatch. It is still a
Section — heading, preamble, code, prose — but its code does not become an
`Effect.Service`. It transduces into a single `FrameCode { text, source }` node: the
code spliced **verbatim and unwrapped** into the frame module, as raw
TypeScript/Effect, in document order. This is for what the projection model does
not cover — custom runtime setup, low-level Effect wiring, direct access to the
frame's TypeScript surface.

Activating `{Loom}` opts out of the framework. A `FrameCode` node is **not in
the composition graph**: no Warp or anchor can target it, Effect DI does not
apply, and a `[Tag]` on a `{Loom}` section has no effect — a diagnostic says so
rather than failing silently. To reuse a `{Loom}` definition you write ordinary
TypeScript — `export const …` here, `import` it there — at which point you are
doing hand-written TypeScript, not Loom composition. From `{Loom}` on, you are
on your own.

The one structural service a `{Loom}` section still provides is carrying
cross-file imports: an `import { Mul } from "./arithmetic.js"` brings an
out-of-file Service into the frame's scope (see Cross-Module Dependencies). Its
`import` lines are hoisted to the head of the frame; the rest of its body is the
`FrameCode` splice. Within a single document there is no module-level dependency
DSL — Effect's DI derives the same-file graph from Warp declarations alone.

## Cross-Module Dependencies

A Warp annotation names a tag: `{{m: Mul}}` depends on the Service tagged
`Mul`. When `Mul` is defined in the same document, the projected
`yield* Mul` resolves to a class declared elsewhere in the same Frame,
order-independently. When `Mul` lives in *another* `.loom` file, the
Frame still emits `yield* Mul` — and `Mul` must be in module scope for
that to compile and run.

Loom does not resolve where `Mul` lives — no filesystem search, no
cross-file tag index, no inference. Path resolution is deferred to
TypeScript. The author brings the Service into scope with an ordinary
import, written in a `{Loom}` section:

```
# Imports {Loom}

=>

import { Mul } from "./arithmetic.js"
```

The projector emits that import verbatim. TypeScript then binds the
imported `Mul` to the `yield* Mul` the Warp generated — ordinary name
resolution. The Warp declares the *logical* dependency (the graph edge);
the import declares the *physical* location (the module). They are
complementary, on different planes, bound by symbol name.

It is a value import (`import { Mul }`), never `import type`: a Service
is used as a value — it is yielded, and provided through `.Default` at
the root — so a type-only import would erase the binding the running
Frame needs. Because the author writes the import, the author chooses
the form; Loom never decides value-vs-type or guesses a path. An
imported Service's `.Default` participates in the root's layer wiring
exactly as a same-file one does (the precise shape of multi-file root
composition is settled when multi-file builds land).

The projector hoists the `import` lines from `{Loom}` sections to the
head of the Frame, regardless of where their sections sit in the
document. The file path lives in the import; the Warp graph records
only the logical tag edge.

## Providing Dependencies

Loom owns the composition root. Because each Service's `.Default` layer
carries unsatisfied requirements — the dependencies its `yield*` calls
declare — the root's job is to satisfy them all at once. It merges every
Service's layer into one set and provides that set back to itself, so
each requirement is met by another member of the same merge:

```typescript
const layers = Layer.mergeAll(Add.Default, Mul.Default, Sq.Default, /* … */)

export const LoomMain = Effect.provide(
  program,                       // yields the tangle sinks to run them
  Layer.provide(layers, layers), // feed the merge into itself to self-wire
)
```

`Layer.mergeAll` is commutative — the order layers are listed in does
not matter — so the root, like the emission, is order-free. The user
writes sections and declares Warps; Loom derives the full wiring and
generates it into the Frame. The user never writes imports, never
assembles layers manually, and never touches the entry point.

The root is synthesised for **every** file, not only those that tangle. Each
`.loom` projects to one self-provided unit: a file with `{path}` sinks runs
them; a library file's root still merges and self-provides, ready to be composed
by an importer. Beyond execution, this per-file root is what makes a document's
sections one interconnected, checkable whole — the basis for cross-section
resolution of product code in the editor (`how-lsp.md` → Composition Drives Type
Resolution). The shape of merging an *imported* Service's layer is settled with
multi-file builds.

The self-provision form (`Layer.provide(layers, layers)`) is pending
confirmation against Effect's actual layer-resolution behaviour. The
mechanism is sound in principle — Effect memoises each service and
resolves the requirement DAG independent of merge order — but the exact
API spelling may differ. This is the one piece of the order-independent
design that warrants a runtime spike before it is relied on.

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
//   - Sections emitted in document order (no eager cross-refs; order is free).
//   - Explicit [Tag]  → class name = tag label, service identifier = tag label.
//   - No [Tag]        → class name = hash of heading name, identifier = same hash.
//   - Heading name stored as `name` field on every section.
//   - Preamble Warp declaration ({{a: Add}}) → lazy yield* inside Effect.gen;
//     no dependencies[] array (see Order Independence).
//   - Name anchor ({{Imports}}) in code block → internal yield* by hash, hoisted.
//   - Tangle section ({path} specifier) → private, tangle() return, graph sink.
//   - {Loom} specifier → code block projected literally (escape hatch only).
//   - Composition root → auto-synthesised: merge all layers, provide to self.
//   - compose / tangle are runtime primitives from #loom/core (a monorepo
//     module; see how-lsp.md). There is no separate Code value type; product
//     code is the AST's CodeWeft text.
// =============================================================================

import { compose, tangle } from "#loom/core"
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
  })
}) {}


export class Pow extends Effect.Service<Pow>()("Pow", {
  effect: Effect.gen(function* () {
    const _S_f1e7d2 = yield* S_f1e7d2   // {{Imports}} — hoisted internally
    return {
      name:     `Power`,
      preamble: `\`pow\` works in \`Double\`; the result is rounded back to \`Int\`.`,
      code: compose(_S_f1e7d2.code, `def power(base: Int, exp: Int): Int = pow(base, exp).toInt`)
    }
  })
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
  })
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
  })
}) {}


// # Tangling the build script {scripts/build.sh}
class S_a1b3c7 extends Effect.Service<S_a1b3c7>()("S_a1b3c7", {
  effect: Effect.gen(function* () {
    const b = yield* Build
    return tangle("scripts/build.sh", b.code)
  })
}) {}


// =============================================================================
// Auto-synthesised composition root — emitted by Loom, not by the user.
// The program yields the tangle sinks (S_d2c5b9, S_a1b3c7) to run their
// file emission. Because each Service's `.Default` carries unsatisfied
// requirements (its `yield*` dependencies), the root merges every layer
// and provides the merge to itself, so each requirement is met by another
// member of the same merge. Merge is commutative — listing order is free.
// =============================================================================

const layers = Layer.mergeAll(
  S_f1e7d2.Default,
  Add.Default,
  Mul.Default,
  Sq.Default,
  Pow.Default,
  Main.Default,
  Build.Default,
  S_d2c5b9.Default,
  S_a1b3c7.Default,
)

export const LoomMain = Effect.provide(
  Effect.gen(function* () {
    yield* S_d2c5b9
    yield* S_a1b3c7
  }),
  Layer.provide(layers, layers)
)
```
