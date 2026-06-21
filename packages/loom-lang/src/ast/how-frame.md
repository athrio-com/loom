# Loom Frame — Reframing

This spec owns two passes of Loom's pipeline: the **`FrameAstBuilder`** pass
(`LoomDocument` → `FrameModule`, a macro tree transducer) and **`fromFrame`**
(`FrameModule` → the de dicto frame virtual code + source mappings — one
projection of the Frame, a catamorphism with L-attributed offsets). `how-lsp.md`
→ The Transformation Pipeline frames the whole chain.

## The Output AST

The Frame is materialised as `FrameModule` — the output AST (`FrameAst.ts`), the
target of the `FrameAstBuilder` pass and the source `fromFrame` reads. Every byte of the
generated frame is a **token**, of one of two kinds by origin:

- **`FrameSynthToken`** — Loom's predefined glue: keywords, punctuation, the
  separators between list items. It has no `.loom` origin, so it carries **no
  mapping**. (These are the schema's own literals; the constructor fills them, so
  the `FrameAstBuilder` pass supplies only the holes.)
- **`FrameAuthoredToken`** — a span lifted from the `.loom` (a name, a tag, a
  bound variable, a preamble) that resolves into the frame. It carries its
  `position`, hence **one mapping**. Its `kind` — `tag`, `name`, `heading`,
  `anchor`, or `prose` — selects which features the language service forwards
  there: a `name` is a const/class identifier the frame generates, mapping back to
  the source label or name it came from; `tag`, `heading`, and `anchor` carry
  navigation; `prose` is title / preamble text.

**Mapping belongs to authored tokens, never to synth.** A mapping links a
generated span to its `.loom` origin; synth glue has no origin, so it can be no
endpoint — it sits in the unmapped gaps between authored tokens. The
synth/authored and unmapped/mapped splits are one line seen twice: a token has a
`position` iff it is authored.

**Escaping is a `.text`-only transform; `position` stays raw.** A leaf's `text` is
escaped for the literal it sits in — `` ` ``, `${`, `\` inside a template literal
(`EmbeddedCode`, the `name` / `prose` fields), `"` and `\` inside a double-quoted
path string — while its `position` keeps the unescaped `.loom` span. So a leaf still yields one coarse
mapping over the whole span, never a per-character split. That suffices because
the only content needing char-precise mapping is **names** (a const/class
identifier, never escaped — so a name that stands for itself is 1:1 with the
**label** or name it came from: class `Add` ⟷ tag label `Add`, const `m` ⟷ Warp
local `m`) and product code *as the language service reads it* — the raw resolved
composition (`EmbeddedCode.position`, unescaped), not the frame's escaped copy. The
one name that is *not* 1:1 is the **name-anchor binding**: a `{{Heading Name}}`
anchor hoists `const _N = yield* N`, whose alias `_N` maps to the section's heading
**title** the author wrote (the definition, mapping kind `heading`), while each
`_N.code` reference maps to the anchor (the referencer, kind `anchor`) — a coarse
whole-span link of different text, all a navigation jump from an anchor to the
section it names needs. Because the two spans hold different text, both kinds carry
navigation but withhold hover: a hover would report the synthetic `_N` alias, never
the section. The `anchor` kind keeps verification, so an unresolved name still
reports its error; `heading` is locate-only. A tagless section's class name itself
is synth glue, never mapped; the alias carries the navigation.

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

`fromFrame` is the in-order projection of this tree — it emits each node's tokens
in the explicit render order the node pins (not their struct position) and
introduces no text of its own; no separator, no glue, is applied "somewhere
else". The form is minimal and canonical: the Frame is virtual code
(mapped, not read), carrying only the spacing TypeScript requires. A
pretty-printer is never run over it — derived offsets would shift and the
mappings break — so the canonical form *is* the schema.

## Sections as Services

Every Section in a Loom document projects to an `Effect.Service` class — with
one exception, the `{Loom}` escape hatch (below), whose code splices into the
frame unwrapped. The Service exposes three fields: `name` — the heading title as
a plain string — `code` — the composed product code — and `prose` — the woven
literate layer. The `code` field is always a `core.compose(…)` value and the
`prose` field always a `core.weave(…)` value, built from the section's fragments
and the references it transcludes. A section with dependencies yields them in an
`Effect.gen` body and then composes; a section with none composes statically. A
section with no transclusions composes its own single fragment, and a code-empty
or prose-empty section composes just its identity and language —
`core.compose(id, "lang")`, `core.weave(id)` — so the shape stays uniform. Code
and prose are peers here, the two halves of the literate document made queryable
side by side. This is the complete, uniform surface of every section in the Frame.

A section's fragments are its code runs with surrounding blank lines shed: the
empty lines after the `=>` Arrow and before the next heading are not part of the
code, and an Arrow with no code at all contributes nothing. Interior blank lines —
the author's spacing between statements — are kept, and every kept fragment carries
its exact `.loom` span, so the trim costs no mapping fidelity. (The matching de re
rule, where a transcluded block sheds its trailing newline so the sink's layout is
the output's, is in `how-lsp.md`.)

Sections with no dependency use `succeed:` — their fields are static
values, constructed once. Sections with any dependency — a Warp declaration
*or* a name anchor — use `effect: Effect.gen(...)`, their fields resolved
through Effect's dependency injection. The shape is identical from the
outside; only the construction mechanism differs.

**Tags determine visibility.** A section with an explicit `[Tag]` is
exported — `export class Add extends Effect.Service...` — and forms part
of the document's public API, referenceable from other files via Warp
declarations. A tagless section is private — no `export`, not importable
across files. Its class name is the heading title normalised to an identifier
(`What the compiler draws on` → `WhatTheCompilerDrawsOn`); the name itself is synth
glue, never mapped. A name anchor reaches the section through the hoisted
`const _N = yield* N` alias, whose declaration maps to the heading (the definition),
so go-to-def on an anchor jumps there, find-references on the heading lists the
anchors, and rename on either end carries across — but neither end shows a hover, which
would only report the `_N` alias. Naming makes no name unique; two titles that normalise alike collide, which
the diagnostics mark as a duplicate. Tagless sections are reachable only within the
same document via name anchors in code blocks.

The class name and the `Effect.Service<…>()("…")` string tag are different things.
The tag is the service's runtime identity, not its name. The `FrameAstBuilder` pass
fills it with the section's module-qualified key, `<path>#<name>`, so two files that
each define a section named `Bit` resolve to distinct services rather than colliding
on the bare name. It is synth glue, mapped to nothing. The snippets in this spec
show it bare, eliding the path for readability.

## Heading Levels and Document Structure

The document is a flat `LoomSection[]` — every heading creates a section, levels
are prose organisation only, and lines before the first heading form the Document
Preamble (`architecture.md` → The AST). The Frame projects every section the same
way whatever its heading level.

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
`{{Imports}}` or `{{Multiplier Function}}` — reference a section within
the same file **by its heading title**, tagged or not. The title is
always available; only the `[Tag]` *label* is Warp-gated, so a bare tag
(`{{Mul}}` for a section tagged `[Mul]`) is a *name miss* — the label is
not the title. The `FrameAstBuilder` pass resolves the title to the section's
service, hoists a `yield*` for it internally — the same lazy dependency
mechanism as a Warp declaration — under a `_`-prefixed alias that won't
shadow the service's class, and inlines the `.code` field at the anchor
site. No preamble declaration is needed; the alias is not user-visible.

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

## Prose as a First-Class Channel

The section's preamble prose — everything written between the heading and
the `=>` Arrow — becomes the `prose` field on the Service's `succeed` or
`return` object. The field is a `core.weave(…)` call, the prose counterpart
of `code`'s `core.compose(…)`: it weaves the section's own prose together
with any prose transcluded from another section through a `{{…}}` anchor's
`.prose`. Documentation composes exactly as code does, so a tool can read a
section's `.prose` as a first-class artifact beside its `.code`.

The preamble is woven in verbatim — the PreambleWefts byte-for-byte, EOLs and
blank lines included, one span. Warp declarations are *not* excised: a
`{{m: Mul}}` sitting in the prose is part of what the author wrote and appears
in the woven text. (The Warp's role as a dependency is carried separately by
the `yield*` the `FrameAstBuilder` pass emits; excising its span here would
only fragment the prose and break its 1:1 mapping.)

The preamble reaches the frame once, woven into the `prose` channel; it is not
duplicated as a doc comment above the class, because the prose already lives in the
`.loom` source a reader opens. Post-tilde prose is authoring context; it lives in
the `.loom` source and is not projected into the Frame.

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
`prose` (why it exists and what it does) and the code it produces.
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

The `FrameAstBuilder` pass emits sections in **document order** — the order
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
requirement. Detecting it stays decoupled from emission: the Frame emits
in document order regardless, and the cycle surfaces as a type error on
the frame. TypeScript cannot resolve the circular `Effect.Service` types,
so the `yield*` site fails to check, and the diagnostic maps back to the
offending Warp. At run time the runner cannot build the cyclic cone
either, so that module yields no de re while its neighbours are untouched
(`how-run.md`). Loom's principle holds — always produce the best possible
projection and speak through the language server, never withhold output.

The lazy-`yield*` mechanism is plain JavaScript and Effect semantics; the
runner wires the root from it, dependency-first (see Providing Dependencies).

## Tangle Sections

File emission is declared in the source document, not in code. A section
whose specifier is a file path — `{src/main/scala/Arithmetic.scala}` rather
than a Tag label — is a tangle section. The specifier signals to the
`FrameAstBuilder` pass that this section's purpose is emission, not composition.

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
The `FrameAstBuilder` pass generates one lazy `yield*` per preamble declaration (no
`dependencies` array, exactly as for an ordinary section), and wraps the
composed result in a `core.tangle(path, ...)` call instead of returning
`{ name, code, prose }`. No special anchor form, no shortcut —
consistent Warp syntax throughout.

A tangle section is a sink in the Warp graph: other sections never declare
it as a dependency. It consumes the graph; nothing consumes it. Tangle
sections are always tagless — private by convention. The `FrameAstBuilder` pass
recognises a file path specifier by the presence of path separators,
distinguishing it from a Tag label without additional syntax.

## The `{Loom}` Specifier

A `{Loom}` specifier marks a section as a power-user escape hatch. It is still a
Section — heading, preamble, code, prose — but its code does not become an
`Effect.Service`. The `FrameAstBuilder` pass turns it into a single `FrameCode { text, position }` node: the
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
cross-file imports: an `import { Mul } from "./arithmetic.loom"` brings an
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

import { Mul } from "./arithmetic.loom"
```

The `FrameAstBuilder` pass emits that import verbatim. TypeScript then binds the
imported `Mul` to the `yield* Mul` the Warp generated — ordinary name
resolution. The Warp declares the *logical* dependency (the graph edge);
the import declares the *physical* location (the module). They are
complementary, on different planes, bound by symbol name.

It is a value import (`import { Mul }`), never `import type`: a Service
is used as a value — it is yielded, and provided through `.Default` at
the root — so a type-only import would erase the binding the running
Frame needs. Because the author writes the import, the author chooses
the form; Loom never decides value-vs-type or guesses a path. The path carries
the dependency's `.loom` extension — `import { Neg } from "./Sad.loom"` — which
the tooling resolves to that document's frame, exactly as Volar resolves
`"./Foo.vue"` (the same `extraFileExtensions` mechanism, no custom resolver). The
runner executes the frame and resolves that same import itself: its injected
`require` answers a sibling `.loom` path with the module it has already evaluated,
so a `.loom` import vanilla Node could not load costs nothing, and no `.loom`
loader is needed. An imported Service's `.Default` participates in the runner's
cross-file dependency cone exactly as a same-file one does.

The `FrameAstBuilder` pass hoists the `import` lines from `{Loom}` sections to the
head of the Frame, regardless of where their sections sit in the
document. The file path lives in the import; the Warp graph records
only the logical tag edge.

## Providing Dependencies

Loom owns the composition root, but the root does not run itself. Each Service's
`.Default` layer carries unsatisfied requirements — the dependencies its `yield*`
calls declare — so something must satisfy them before the services run. The frame
does not wire them. It *exports* what a wiring needs, and the runner does the rest.

The `FrameAstBuilder` pass emits two members at the foot of every file that
declares a service. `__services` names each service, paired with its `.Default`
layer, the service class itself, and the classes it depends on. `__run` is an
`Effect.gen` that yields every section — exported and tagless alike — and returns
the module's composed code, its woven prose, and its tangle files.

```typescript
export const __services = {
  Add: { layer: Add.Default, self: Add, deps: [] },
  Sq:  { layer: Sq.Default,  self: Sq,  deps: [Imports] },
  // … one entry per service, the private sections included
}

export const __run = Effect.gen(function* () {
  return {
    sections: new Map([["Add", (yield* Add).code], /* … */]),
    prose:    new Map([["Add", (yield* Add).prose], /* … */]),
    files:    [yield* TanglingTheLibrary, /* … */],
  }
})
```

The runner reads those two members and wires the graph (`how-run.md`). It indexes
every service across the corpus by its module-qualified tag, walks each module's
dependency cone, sorts it so a dependency builds before what needs it, and folds
the layers with `Layer.provideMerge`. Providing the merged set to itself does not
close the loop — building the provided copy still demands the very services it
should supply — so the fold goes dependency-first instead. The graph is acyclic,
since a Warp cycle is a diagnostic rather than a built layer, so the fold always
closes. The author writes sections and declares Warps; the runner derives the
order and the wiring from the graph the frame already carries, and never asks the
author for an import, a layer assembly, or an entry point.

The root is generated for every file **with Services**, not only those that
tangle: a file with `{path}` sinks runs them, and a library file still exports its
`__services` and `__run` so an importer can run it. A service-less file — empty, or
only `{Loom}` blocks — has **no** root; an empty `.loom` is a valid file. Where a
root exists it makes a document's sections one interconnected, checkable whole —
the basis for cross-section resolution of product code in the editor (`how-lsp.md`
→ Composition Drives Type Resolution).

## Health Is Two-Tier

Diagnostics live on AST nodes, and there are two tiers — one per AST:

- **Grammatical health — on the Loom AST, at parse.** Orphan brackets, malformed
  labels, duplicate tags, unclosed delimiters; `architecture.md`'s health model.
  `{Loom}` needs no special case here — a `[Tag] {Loom}` heading is
  grammatically fine.
- **Semantic health — on the Frame AST, at the `FrameAstBuilder` pass.** A tag
  on a `{Loom}` section (no effect), a cross-specifier composition edge, a Warp
  cycle, an unresolved or heterogeneous anchor. These need *meaning* — exactly
  what the `FrameAstBuilder` pass has and parse does not. `frameNode` carries an
  optional `health`
  (defaulting to ok), the same `Health` shape the Loom AST uses.

Both surface at source. Grammatical health is already on Loom nodes, which carry
their `position`. Semantic health rides the mapping: a Frame node's health resolves
to its originating `.loom` span exactly as its text does — a `ServiceClass`'s
diagnostic lands on its heading, a `Binding`'s on its Warp. The editor merges the
two tiers, and neither is withheld (always project, always speak through the
language server).

## What This Enables

The combination — uniform Services, Warp graph in the AST, prose as
data, automatic DI — makes the Frame a semantic index of the document,
not just a type-checking surface. The IDE uses the Frame for navigation
and diagnostics. The CLI uses the AST's Warp graph for context-aware
tooling. Effect uses the Frame for execution. All three consumers read
from the same source document, with no duplication.
