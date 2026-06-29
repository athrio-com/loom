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
- **`FrameAuthoredToken`** — a span lifted from the `.loom` (a name, a
  bound variable, a preamble) that resolves into the frame. It carries its
  `position`, hence **one mapping**. Its `kind` — `name`, `heading`,
  `anchor`, or `prose` — selects which features the language service forwards
  there: a `name` is a const identifier the frame generates, mapping back to
  the source expression it came from; `heading` and `anchor` carry navigation;
  `prose` is title / preamble text.

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
the only content needing char-precise mapping is a **name** — a value Warp's
expression, never escaped, so it is 1:1 with the source it stands for, const `c` ⟷
the `c` the author wrote — and product code *as the language service reads it*: the
raw resolved composition (`EmbeddedCode.position`, unescaped), not the frame's
escaped copy. The one binding that is *not* 1:1 is the **name-anchor binding**: a
`::[Heading Name]` anchor hoists `const _N = yield* N`, whose alias `_N` maps to the
section's heading **title** the author wrote (the definition, mapping kind
`heading`), while each `_N.code` reference maps to the anchor (the referencer, kind
`anchor`) — a coarse whole-span link of different text, all a navigation jump from
an anchor to the section it names needs. Because the two spans hold different text,
both kinds carry navigation but withhold hover: a hover would report the synthetic
`_N` alias, never the section. The `anchor` kind keeps verification, so an unresolved
name still reports its error; `heading` is locate-only. A section's class name itself
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
literate layer. The `code` field is always a `dsl.compose(…)` value and the
`prose` field always a `dsl.weave(…)` value, built from the section's fragments
and the references it transcludes. A section with dependencies yields them in an
`Effect.gen` body and then composes; a section with none composes statically. A
section with no transclusions composes its own single fragment, and a code-empty
or prose-empty section composes just its identity and language —
`dsl.compose(id, "lang")`, `dsl.weave(id)` — so the shape stays uniform. Code
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
values, constructed once. A section with a dependency — a name anchor that
yields the section it names — uses `effect: Effect.gen(...)`, its fields resolved
through Effect's dependency injection. The shape is identical from the
outside; only the construction mechanism differs.

**Every section is exported.** The Frame emits `export class Add extends
Effect.Service...` for each one — there is no visibility scope, no private
section, one kind of section throughout. A section's class name is its heading
title normalised to an identifier (`What the compiler draws on` →
`WhatTheCompilerDrawsOn`); the name itself is synth glue, never mapped. A name
anchor reaches the section through the hoisted `const _N = yield* N` alias, whose
declaration maps to the heading (the definition), so go-to-def on an anchor jumps
there, find-references on the heading lists the anchors, and rename on either end
carries across — but neither end shows a hover, which would only report the `_N`
alias. Normalising makes no name unique; two titles that normalise alike collide,
which the diagnostics mark as a duplicate. A name anchor reaches a section only
within the same document.

The class name and the `Effect.Service<…>()("…")` string tag are different things.
The string tag is the service's runtime identity, not its name. The `FrameAstBuilder` pass
fills it with the section's module-qualified key, `<path>#<name>`, so two files that
each define a section named `Bit` resolve to distinct services rather than colliding
on the bare name. It is synth glue, mapped to nothing. The snippets in this spec
show it bare, eliding the path for readability.

## Heading Levels and Document Structure

The document is a flat `LoomSection[]` — every heading creates a section, levels
are prose organisation only, and lines before the first heading form the Document
Preamble (`architecture.md` → The AST). The Frame projects every section the same
way whatever its heading level.

## Name Anchors and Warps

A **name anchor**, written in a code block as `::[Imports]` or
`::[Multiplier Function]`, references another section in the same file **by its
heading title**. The `FrameAstBuilder` pass resolves the title to that section's
service, hoists a `yield*` for it under a `_`-prefixed alias that won't shadow the
service's class, and inlines the resolved `.code` field at the anchor site. That
`yield*` *is* the dependency: Effect lifts the requirement into the Service's layer
type automatically, so the Frame emits **no** separate `dependencies` array (see
Order Independence below for why that matters). No preamble declaration is needed;
the alias is not user-visible. A name anchor is the one way one section reaches
another — there is no tag, and no separate dependency declaration.

A **Warp**, written in the preamble as `{{ … }}`, does not reference a section. Two
kinds remain. A **value Warp** — `{{c = "literal"}}` — binds a name to a literal,
and `::[c]` in a code block composes that value where the anchor stood; it is a
named constant, not a dependency, so it hoists no `yield*`. The **language Warp** —
`{{lang: TypeScript}}` — sets the document's primary language, the default a
specifier-less section inherits. Neither Warp is an edge in the composition graph.

## Composition Is Homogeneous

A composition edge — a name anchor — inlines one section's code into another. That
is only meaningful when both sections share a **language**: TypeScript composes
TypeScript, JSON composes JSON. The language is the one the section resolves to —
its specifier, a sink's path extension, or the document default — so two
specifier-less sections still agree. A cross-language edge has no valid product,
since no single language holds both fragments as one program, so the builder marks
it a diagnostic on the offending anchor rather than splicing silently. The frame
pass compares the two languages as it binds each name anchor.

Only a code anchor composes. A name anchor in prose takes a different plane: it
places a chapter under a higher-order sink, or merely links to the section it
names. The frame walks only the code wefts, so it never folds a prose anchor into
a section's code, and a prose link that resolves to nothing is no error.

The specifier is the whole key; there is no separate plane axis. `{Loom}` is its
own specifier — TypeScript de facto, but never interchangeable with
`{TypeScript}`, and product TypeScript is never treated as frame code. A `{Loom}`
section is not in the composition graph at all (see The `{Loom}` Specifier): it
can be no anchor target, so it never enters the homogeneity check — the rule
governs product↔product edges alone.

## Prose as a First-Class Channel

The section's preamble prose — everything written between the heading and
the `=>` Arrow — becomes the `prose` field on the Service's `succeed` or
`return` object. The field is a `dsl.weave(…)` call, the prose counterpart
of `code`'s `dsl.compose(…)`: it weaves the section's own prose together
with any prose transcluded from another section through a `::[…]` anchor's
`.prose`. Documentation composes exactly as code does, so a tool can read a
section's `.prose` as a first-class artifact beside its `.code`.

The preamble is woven in verbatim — the PreambleWefts byte-for-byte, EOLs and
blank lines included, one span. A Warp is *not* excised: a `{{c = "x"}}` value
Warp or a `{{lang: TypeScript}}` language Warp sitting in the preamble is part of
what the author wrote and appears in the woven text. (A value Warp's role as a
binding is carried separately by the `dsl.referValue` the `FrameAstBuilder` pass
emits at the anchor; excising its span here would only fragment the prose and break
its 1:1 mapping.)

The preamble reaches the frame once, woven into the `prose` channel; it is not
duplicated as a doc comment above the class, because the prose already lives in the
`.loom` source a reader opens. Post-tilde prose is authoring context; it lives in
the `.loom` source and is not projected into the Frame.

## The Dependency Graph for Free

The complete dependency graph of any Loom document is a first-class
parse-time artifact. Name anchors are the edges: each `::[Multiplier Function]`
in a section's code block is an explicit dependency edge to the section that
title names. No analysis pass, no inference — the edges are the anchors,
and they are traversable directly from the AST.

Effect Layers are opaque at runtime: you can run a layer, not inspect
its dependency structure without executing. The graph the CLI walks is
the AST's anchor edges, not the compiled Frame. The Frame's `yield*` calls
faithfully reflect those edges at the TypeScript level — so Effect's DI
actually executes the graph — but the authoritative, traversable source
is always the AST.

Each node in the anchor graph carries semantic content: the section's
`prose` (why it exists and what it does) and the code it produces.
A CLI tool walks from any entry section through its anchor edges, collecting
structured context and code at every step — for documentation generation,
impact analysis, LLM prompt construction, or selective execution.

Effect's `Graph` module is a natural candidate for representing this
derived graph. It provides topological sort, depth-first and breadth-first
traversal, cycle detection, transitive reachability, and `toGraphViz` /
`toMermaid` output — all built-in. The AST itself remains Schema-defined
and serializable; `Graph` is a separate structure derived from the AST's
anchor edges after parsing, used only for traversal and analysis.

## Order Independence and Cycles

The `FrameAstBuilder` pass emits sections in **document order** — the order
they appear in the source is the order they appear in the Frame. There
is no topological sort and no dependency-driven reordering.

This works because no class declaration references another class
*eagerly*. A projected Service has the shape:

```typescript
export class Sq extends Effect.Service<Sq>()("Sq", {
  effect: Effect.gen(function* () {
    const _Mul = yield* Mul
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

Cycles. A genuine cycle (A's anchor names B, B's names A) is a
real error — Effect cannot build a layer set with a circular
requirement. Detecting it stays decoupled from emission: the Frame emits
in document order regardless, and the cycle surfaces as a type error on
the frame. TypeScript cannot resolve the circular `Effect.Service` types,
so the `yield*` site fails to check, and the diagnostic maps back to the
offending anchor. At run time the runner cannot build the cyclic cone
either, so that module yields no de re while its neighbours are untouched
(`how-run.md`). Loom's principle holds — always produce the best possible
projection and speak through the language server, never withhold output.

The lazy-`yield*` mechanism is plain JavaScript and Effect semantics; the
runner wires the root from it, dependency-first (see Providing Dependencies).

## Tangle Sections

File emission is declared in the source document, not in code. A section whose
**sink** names a file — `[src/main/scala, Arithmetic.scala]` rather than a bare
language label — is a tangle section. The two-part sink, a directory and a file
split by the comma, signals to the `FrameAstBuilder` pass that this section's
purpose is emission, not composition.

The code block of a tangle section contains only name anchors:

```
## Tangling the library [src/main/scala, Arithmetic.scala]

Emits the complete arithmetic library.

=>

::[Imports]
::[Main]
```

Tangle sections use the same name-anchor mechanics as every other section. Each
anchor (`::[Imports]`, `::[Main]`) names a section by its title, hoisting a lazy
`yield*` and inlining the resolved `.code` field in order. The `FrameAstBuilder`
pass emits no `dependencies` array, exactly as for an ordinary section, and wraps
the composed result in a `dsl.tangle(path, ...)` call instead of returning
`{ name, code, prose }`. No special anchor form, no shortcut — consistent anchor
syntax throughout.

A tangle section is a sink in the anchor graph: other sections never name it.
It consumes the graph; nothing consumes it. The `FrameAstBuilder` pass tells a
tangle section by its sink's comma — a two-part `[dir, file]` emits a file, a
one-part `[dir]` is a higher-order sink that places chapters — and reads the
file's path by joining the two parts.

## The `{Loom}` Specifier

A `{Loom}` specifier marks a section as a power-user escape hatch. It is still a
Section — heading, preamble, code, prose — but its code does not become an
`Effect.Service`. The `FrameAstBuilder` pass turns it into a single `FrameCode { text, position }` node: the
code spliced **verbatim and unwrapped** into the frame module, as raw
TypeScript/Effect, in document order. This is for what the projection model does
not cover — custom runtime setup, low-level Effect wiring, direct access to the
frame's TypeScript surface.

Activating `{Loom}` opts out of the framework. A `FrameCode` node is **not in
the composition graph**: no anchor can target it, and Effect DI does not apply.
To reuse a `{Loom}` definition you write ordinary TypeScript — `export const …`
here, `import` it there — at which point you are doing hand-written TypeScript,
not Loom composition. From `{Loom}` on, you are on your own.

The one structural service a `{Loom}` section still provides is carrying raw
imports: an `import` line in a `{Loom}` section brings whatever it names into the
frame's scope, the ordinary way TypeScript shares code across modules. Its `import`
lines are hoisted to the head of the frame; the rest of its body is the `FrameCode`
splice.

## Composition Stays Within the File

A name anchor resolves only within its own document — Loom composes the sections of
one `.loom` into the files that loom emits. It does not transclude a section from
another `.loom`: there is no cross-file section index and no implicit cross-file
reference.

Reuse across modules is the target language's own job. A loom that needs code from
another package imports it the conventional way — `import { Mul } from
"@athrio/arithmetic"` in a `{Loom}` section or a product section — and that import
travels into the tangled output as the product code it is. Loom resolves no path
and indexes no foreign section; the language and its toolchain do.

Composition across files, when a project wants it, is the book's to arrange. A
higher-order sink points at a chapter in another loom and **places** that chapter's
own tangle sinks under a directory prefix — each chapter tangles its own files,
relocated, never inlined into one another (`architecture.md` → The Sink Tree). So
the two cross-file mechanisms are placement, not transclusion: the book routes
where files land, and the language imports what code depends on what.

## Providing Dependencies

Loom owns the composition root, but the root does not run itself. Each Service's
`.Default` layer carries unsatisfied requirements — the dependencies its `yield*`
calls declare — so something must satisfy them before the services run. The frame
does not wire them. It *exports* what a wiring needs, and the runner does the rest.

The `FrameAstBuilder` pass emits two members at the foot of every file that
declares a service. `__services` names each service, paired with its `.Default`
layer, the service class itself, and the classes it depends on. `__run` is an
`Effect.gen` that yields every section and returns the module's composed code, its
woven prose, and its tangle files.

```typescript
export const __services = {
  Add: { layer: Add.Default, self: Add, deps: [] },
  Sq:  { layer: Sq.Default,  self: Sq,  deps: [Imports] },
  // … one entry per service
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
since an anchor cycle is a diagnostic rather than a built layer, so the fold always
closes. The author writes sections and names them with anchors; the runner derives
the order and the wiring from the graph the frame already carries, and never asks the
author for an import, a layer assembly, or an entry point.

The root is generated for every file **with Services**, not only those that
tangle: a file with `[dir, file]` sinks runs them, and a library file still exports its
`__services` and `__run` so an importer can run it. A service-less file — empty, or
only `{Loom}` blocks — has **no** root; an empty `.loom` is a valid file. Where a
root exists it makes a document's sections one interconnected, checkable whole —
the basis for cross-section resolution of product code in the editor (`how-lsp.md`
→ Composition Drives Type Resolution).

## Health Is Two-Tier

Diagnostics live on AST nodes, and there are two tiers — one per AST:

- **Grammatical health — on the Loom AST, at parse.** Orphan brackets, malformed
  labels, unclosed delimiters; `architecture.md`'s health model. `{Loom}` needs no
  special case here — a `{Loom}` heading is grammatically fine.
- **Semantic health — on the Frame AST, at the `FrameAstBuilder` pass.** A
  cross-specifier composition edge, an anchor cycle, an unresolved or heterogeneous
  anchor. These need *meaning* — exactly what the `FrameAstBuilder` pass has and
  parse does not. `frameNode` carries an optional `health` (defaulting to ok), the
  same `Health` shape the Loom AST uses.

Both surface at source. Grammatical health is already on Loom nodes, which carry
their `position`. Semantic health rides the mapping: a Frame node's health resolves
to its originating `.loom` span exactly as its text does — a `ServiceClass`'s
diagnostic lands on its heading, a reference's on its anchor. The editor merges the
two tiers, and neither is withheld (always project, always speak through the
language server).

## What This Enables

The combination — uniform Services, the anchor graph in the AST, prose as
data, automatic DI — makes the Frame a semantic index of the document,
not just a type-checking surface. The IDE uses the Frame for navigation
and diagnostics. The CLI uses the AST's anchor graph for context-aware
tooling. Effect uses the Frame for execution. All three consumers read
from the same source document, with no duplication.
