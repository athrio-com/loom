# Loom LSP & Runtime — Tooling Layer

This is the root of the Loom specification. The AST pipeline (source →
`LoomDocument`) is `how-ast.md`; the Frame pass is `how-frame.md`. This 
document covers what sits on top of both: the core type vocabulary the Frame
is built from, the runtime entry points that execute it, and the Volar/LSP
integration that surfaces it in the editor.

Like the other specs, this describes the target architecture. The current code
may not yet conform; where it does (embedded language resolution, syntax
highlighting, source mappings, the multiplexer), that behaviour must be
preserved, not regressed.

---

## The Transformation Pipeline

Loom is a chain of tree transformations — the architecture of a compiler, and
of literate-programming tangling (Knuth's WEB). Specifically it is a **nanopass
pipeline**: a sequence of small, total **passes** between *explicitly-defined*
intermediate models, each a Schema-defined AST — rather than one monolithic
transform. Every arrow is a pass, and every pass is a **Builder** producing a
**Model**; the chain is that one shape — `Model + Builder` — repeated end to
end, so it reads uniformly and no pass reaches past its inputs. The pass roles
still carry their precise names from the program-transformation literature; the
names fix both the shape we build and the discipline that keeps it pure.

```
text ─parse─▶ LoomDocument ─FrameAstBuilder─▶ FrameModule ─┬─ fromFrame ─▶ LoomVirtualCode             (de dicto frame)
                                                           └─ ProductAstBuilder ─▶ ComposedCode ─┬─ fromProduct ─▶ LoomVirtualCode  (de re product)
                                                                                                 └─ tangle ─▶ product files          (filesystem)
```

Each model, and the pass (its Builder) that produces it:

- **`LoomDocument`** — `parse` (`Loom`, `how-ast.md`): source text → the input
  AST.
- **`FrameModule`** — `FrameAstBuilder` (`how-frame.md`): `LoomDocument` → the
  Frame, the composition program (`FrameAst.ts`). A *macro tree transducer*: a
  tree→tree pass that hoists bindings, resolves anchors, and generates
  scaffolding — strictly more than a structure-preserving homomorphism. No
  surface text is emitted here; emitting is projection.
- **`ComposedCode`** — `ProductAstBuilder` (`ProductAst.ts`): `FrameModule` →
  the de re structure, one per section — its product code with transclusions
  expressed as resolved edges. Built per module and pure of every other module;
  the cross-file graph is followed later, at projection.
- **`LoomVirtualCode`** — `LoomVirtualCodeBuilder` (`LoomVirtualCode.ts`), the
  projection: a *family* of passes that fold a model to text + source mappings,
  each a *catamorphism*, differing only in its algebra:
  - **`fromFrame`** : `FrameModule` → the de dicto frame virtual code (generated
    TypeScript), the editor projection Volar type-checks. One depth-first,
    left-to-right walk threads a cursor, emitting each node's text in its
    declared `RenderOrder` and recording each mapped leaf's generated range
    against its `.loom` `source`. Offsets are an *L-attributed* computation —
    inherited start, synthesised length — settled in that single pass, never
    stored.
  - **`fromProduct`** : `ComposedCode` → a de re product virtual code, the
    author's code with its transclusions inlined across the corpus.
  - **`tangle`** → product files on disk — the filesystem projection, on the de
    re plane: assemble each `{path}` sink's composed code and write it.
  The projection is the family; **`fromFrame`, `fromProduct`, and `tangle` are
  members**, not stages — further surfaces (semantic tokens, …) are just more
  algebras over the same models.

`LoomVirtualCode` is plain data: it is adapted to Volar's runtime `VirtualCode`
by `toVolar` at the editor edge (the one place that touches Volar's snapshot /
`CodeMapping` shapes). The multi-file run is wrapped by `LoomCorpusAst` /
`LoomCorpusAstBuilder` — the same `Model + Builder` pair over a set of modules.

Two properties of the shape:

- **The trees are kept, not fused.** A compiler could fuse a build-then-fold
  into one pass (a *hylomorphism*). Loom materialises each model precisely
  *because* the Frame is projected many ways — one inspectable, mappable source
  of truth feeding `fromFrame`, `fromProduct`, `tangle`, and every editor
  surface; a fused pipeline would keep none of them.
- **It stays pure FP with Effect.** A catamorphism is total structural
  recursion; each projection pass, written as a fold over a node's children
  (threading the cursor), is an *effectful catamorphism*. The Effect idiom is
  what the morphism already is, not a layer on top of it.

### Pedigree

This is a well-trodden class of problem; the names below are the path to follow
when extending the pipeline.

- **Overall shape** — nanopass compilers (Sarkar, Waddell & Dybvig, *A Nanopass
  Framework for Compiler Education*); multi-IR compilers generally (e.g. GHC's
  `HsSyn → Core → STG → Cmm`).
- **the frame pass — tree → tree** — tree transducers, and term rewriting /
  program transformation: XSLT, Stratego/XT, TXL, Rascal.
- **the projection passes — tree → surface** — unparsing / pretty-printing
  (Wadler, *A prettier printer*; Oppen), as catamorphisms / recursion schemes
  (Meijer, Fokkinga & Paterson, *Bananas, Lenses, Envelopes and Barbed Wire*);
  each surface is a different algebra over the same models.
- **offsets** — attribute grammars (Knuth); the *L-attributed* subclass is
  exactly the one evaluable in a single left-to-right pass.
- **literals as nodes** — lossless / concrete syntax trees (Roslyn red-green
  trees, rust-analyzer's rowan, SwiftSyntax): the same full-fidelity choice
  Loom makes for its output tree.
- **source ⇄ generated mappings** — source maps and bidirectional
  transformations (lenses); institutionalised for editors by Volar's virtual
  code + mappings, which `fromFrame` / `fromProduct` feed.

The layer specs own their passes: `how-ast.md` the parse, `how-frame.md` the
`FrameAstBuilder` pass and `fromFrame`. This document covers the rest of the
projection — `ProductAstBuilder` and `fromProduct`, the tangle that writes
product files, the runtime that executes the Frame, and the Volar virtual-code
layer that surfaces it.

---

## Composition Primitives

There is no separate `Code` value type: a section's product code is the source
text carried by its `CodeWeft` and `ArrowWeft` nodes (`how-ast.md`), read by
position, not wrapped in a dedicated value. The runtime primitives the Frame
*calls*, however, are real and live in `#loom/core` — a monorepo module the
Frame imports from:

- **`compose`** — orders the code of the sections it references, in argument
  order, into one composed result.
- **`tangle`** — binds a composed result to a file path; running it at the end
  of the world emits the file.

Their exact signatures follow from the AST representation and are fixed in
`#loom/core`, alongside the projection passes (`fromFrame` / `fromProduct` /
`tangle`; see The Transformation Pipeline). The output is
always literal code, concatenated in tangle order — the machinery (Effect,
Services, Layers) never appears unless the author wrote Effect in a section.

There is no `Template` type and no `needs()` function: every section —
parameterised or not — projects to one `Effect.Service` exposing
`{ name, preamble, code }` (see `how-frame.md`), and cross-file dependencies are
declared by Warp annotations and wired automatically through Effect's DI, which
derives the full graph from the Warp edges alone.

---

## Runtime Entry Points

Every Loom process is an Effect program. Effect drives the process — not
imperative code that calls Effect occasionally. Each entry point begins from
`NodeRuntime.runMain()` (or `Effect.runFork()`), provides Layers, and runs to
the end of the world, where the output is pure text on disk.

```
NodeRuntime.runMain(                                  ← end of the world
  Effect.gen(function* () {
    const doc   = yield* Loom.ast(source)             ← parse   (how-ast)
    const frame = yield* FrameAstBuilder.build(doc)   ← FrameAstBuilder (how-frame) → FrameModule
    yield* Tangler.run(frame)                         ← tangle the {path} sinks → files
  }).pipe(
    Effect.provide(Loom.Default),
    Effect.provide(FrameAstBuilder.Default),
    Effect.provide(Tangler.Default),
    Effect.provide(NodeFileSystem.layer),
  )
)
```

- **Tangle CLI** (`pnpm tsx tangle.ts <file>.loom`) — parses the document, runs
  the `FrameAstBuilder` pass to the `FrameModule`, and tangles each `{path}`
  sink. The end of the world is the emitted files. (Equivalently, the eventual
  self-hosting path renders the `FrameModule` to a runnable Frame whose
  auto-generated `LoomMain` composition root tangles the sinks when executed.)
- **Volar LSP server** — an Effect Platform application. Parsing, the Frame
  pass, virtual-code assembly, and diagnostics are all Effect services
  composed via Layers; the server starts as an Effect program.
- **Vite plugin** (if applicable) — Effect-native; its transform/build hooks are
  Effect programs.

The rule: start from the runtime entry point and model every concern as a
Service with a Layer. Do not start with imperative Node code and sprinkle
Effect inside, and do not call `Effect.runSync` / `runPromise` in the middle of
an imperative flow.

---

## The Two Planes — de dicto and de re

Every `.loom` position belongs to exactly one of two planes, and that
determines which virtual code the language server consults.

**De dicto — the frame.** The composition machinery: the generated
`Effect.Service` classes, their `core.compose()` / `core.tangle()` calls, Warp wiring (the
lazy `const m = yield* Mul` bindings — no eager `dependencies` array, see
`how-frame.md` on order independence), the author's cross-file `import` lines,
and the verbatim body of any `{Loom}` section (a `FrameCode` splice). This is
TypeScript that describes *how* code is composed. tsc checks it
for composition correctness.

**De re — the product.** The actual code the author wrote in a section's code
block — `def add(x, y) = x + y`, a JSON manifest, a SQL query. This is the
thing *being* composed, carried as the `code` field of each section's Service.
It may be any language the document or a section specifier declares.

The conflation to avoid: when product code happens to be TypeScript, it looks
identical to frame code. It is not. One describes composition; the other is
composed. A `.loom` position inside a heading, a Warp declaration, a tangle
body, or a `{Loom}` section's code maps to the frame; a position inside a
*product* section's code block maps to the product. They never mix.

---

## Volar Virtual Code Tree

Loom is a Volar extended language: code sections are first-class embedded code.
Volar already owns the concepts of embedded languages, virtual codes, and
language-specific dispatch — Loom's job is to declare the tree correctly, not
to reimplement what Volar provides.

```
root (languageId: "loom")
├── frame        (languageId: "typescript")   ← de dicto: the Frame's Service
│                                                program, via fromFrame (how-frame)
├── tangled-0    (languageId: Loom)           ← de re: resolved product for a
│                                                {path} tangle, in compose order
├── tangled-1    (languageId: Loom)           ← one per tangle section
├── section-0    (languageId: per section)    ← de re: a section's resolved
│                                                composition (code + transclusions)
└── …
```

- **Frame** — the single TypeScript virtual code for the Frame (`fromFrame`): the
  `Effect.Service` class per section, the Warp wiring, the tangle calls, and the
  `LoomMain` root. tsc checks it for composition correctness. Heading tags get
  hover, go-to-definition, and type info here (a tag resolves to its exported
  Service; a tagless heading to its hash-named class).
- **Tangled** — one per tangle section. The member sections' `code` composed in
  tangle order, producing the assembled file as a virtual document. A tangle is
  **language-agnostic**: it composes any source — possibly several languages —
  into one file, so it claims no product language of its own; it is marked `Loom`
  and is not type-checked as a single language. Type-checking is per contributing
  section (below); the tangle's mappings only carry each line back to the `.loom`
  section it came from.
- **Embedded section compositions** — each content section projects to its
  *resolved composition*: its code with its transcluded sections inlined in
  composition order, in its own `languageId` (the document's `{{lang: …}}`
  default, or a per-section label specifier such as `{Bash}`). The language
  service resolves cross-section references against it; syntax highlighting is
  the floor when no composition resolves.

The default `languageId` comes from the document's `lang` Warp; a section's
label specifier overrides it for that section. A `{Loom}` section is projected
literally into the frame rather than carried as composed product (see
`how-frame.md`).

---

## Composition Drives Type Resolution

Type checking and semantic analysis of *product* code work through the
*composition* — the de re projection of the Frame, anchored by the file's
`Root` (generated where the file has Services; see `how-frame.md`). A section's resolved product document is its code
with its transcluded sections inlined in composition order; that document is
what the language service checks, and its results map back to the `.loom`
sections that contributed them.

A **composition diagnostic** — one that exists only because sections are spliced:
a duplicated binding, a name a mid-section anchor pulls into scope, a type that
clashes only when composed — is emergent. No section produces it alone, only the
consuming document does, so it is reported once. By default it maps to the actual
offending span, in whichever contributing section's `.loom` wrote it — the
language service's own order, run backward through the mappings. The exception is
**cross-file** transclusion: when the offending span was inlined from another
file's library section, the diagnostic re-pins to the `{{…}}` **anchor** in the
consuming section — the composition is the consumer's to own, and the library
author never sees it — not to the library's own source.

Composition order — not document order — is what the language service sees, so a
section may reference another defined later in the source without error. The
order is the transclusion graph: a section's code follows the code of the
sections it transcludes through `{{…}}` anchors.

**Transclusion absorbs the block's trailing newline.** An anchor stands for the
transcluded block's *lines*; the line break that ends the anchor's own line
supplies the block's last terminator, so an inlined block sheds its trailing
newline and the consuming section's literal layout becomes the output's: `{{a}}`
then `{{b}}` stacked places the blocks on consecutive lines, one blank line
between the anchors yields exactly one blank line between the blocks, and the
final anchor's break is the file's single trailing newline — no doubled gaps, no
trailing blank (noweb's chunk-reference semantics). It is generated-side only: the
shed newline's `.loom` origin stops being mapped — a newline is never a hover or
diagnostic target — and every source span is left exact.

A **tangle** is the composition whose unit is a file-output target: a `{path}`
section assembles its members into one document — language-agnostic (marked
`Loom`), so not type-checked as a single language, but mapped back to its sources
*and*, at the end of the world, written to disk. But resolution is not gated on a
tangle. Because the whole file projects to one
Frame, every section is interconnected and diagnosable on its own composition,
and a library `.loom` with no tangle is still fully resolved within itself.

**Syntax highlighting (Tree-sitter) is the floor** — always available, and the
only product signal when a composition cannot be resolved: a missing grammar,
or a transcluded Service that lives in another file (cross-file resolution
arrives with multi-file builds).

---

## Source Mappings

Every virtual code carries bidirectional source mappings back to the `.loom`
file. When the language service reports a diagnostic or answers a
hover / go-to-definition, Volar maps the position back to the exact `.loom`
location. This is Volar's core competency; Loom supplies the mappings when it
assembles each virtual code.

Routing is by plane:

```
.loom source position
  ├─ heading, Warp/anchor, tangle body, or {Loom} code (FrameCode)
  │     → frame virtual code (tsc) → frame annotations
  └─ a product section's code block (EmbeddedCode)
        → the section's resolved composition → product annotations
           (unresolved, e.g. cross-file dep → Tree-sitter syntax tokens only)
```

Frame annotations (a tag's resolved Service, a Warp's resolved target, a
composition type error) and product annotations (a type error in the author's
code, hover on a local variable) never mix; the source position alone decides
which virtual code answers.

---

## Multiplexer

The LSP multiplexer (`src/multiplexer.ts`) dispatches requests to external
language servers for languages Volar does not handle natively (Go, Rust,
Python, …). It covers hover, completion, and go-to-definition for those
languages. It does **not** intercept `textDocument/semanticTokens` — those flow
through Volar's plugin pipeline.

Volar handles its known languages natively; the multiplexer extends that to
external servers. They are complementary, not competing.

---

## Syntax Highlighting

Two token sources, dispatched by Volar depending on what is available:

1. **Language-service semantic tokens** — type-aware tokens (variables,
   functions, types) for any section whose composition resolves, produced from
   its resolved composition and mapped back to `.loom` positions.
2. **Tree-sitter syntax tokens** — keywords, strings, numbers, operators, and
   punctuation, produced per code section with the appropriate grammar. Works
   for every code section, including untangled ones.

```
Resolved composition:     semantic tokens (types, errors) via the composition
Unresolved / no grammar:  Tree-sitter syntax tokens only
```

If the Tree-sitter runtime has no grammar for a language, those sections get no
syntax tokens — a missing-grammar problem, not a Loom architecture problem.
