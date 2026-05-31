# Loom LSP & Runtime — Tooling Layer

This is the root of the Loom specification. The AST pipeline (source →
`LoomDocument`) is `how-ast.md`; the Frame synthesis is `how-frame.md`. This 
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
pipeline**: a sequence of small, total passes between *explicitly-defined*
intermediate languages — here `LoomDocument` and `FrameModule`, each a
Schema-defined AST — rather than one monolithic transform. Each arrow has a
precise name from the program-transformation literature; naming them fixes both
the shape we build and the discipline that keeps it efficient and pure.

```
text ──parse──▶ LoomDocument ──transduce──▶ FrameModule ──project──┬─▶ synthesise → genCode + mappings  (Volar virtual code)
                                                                   └─▶ tangle → product files        (filesystem)
```

- **parse** (`how-ast.md`) — source text → `LoomDocument`, the input AST.
- **transduce** (`how-frame.md`) — `LoomDocument` → `FrameModule`, the output
  AST (`FrameAst.ts`). A *macro tree transducer*: a tree→tree map that hoists
  bindings, resolves anchors, and synthesises scaffolding — strictly more than a
  structure-preserving homomorphism. No code is emitted here; emitting is
  projection.
- **project** — `FrameModule` → a concrete surface. A *family* of
  *catamorphisms* (folds) over the one Frame, each differing only in its
  algebra:
  - **synthesise** → the Frame's *synthetic code* (generated TypeScript) + source
    mappings — the editor projection, which Volar wraps as virtual code. One
    depth-first, left-to-right walk threads a cursor, emitting each node's text
    and recording each mapped leaf's generated range against its `.loom`
    `source`. Offsets are an *L-attributed* computation — inherited start,
    synthesised length — settled in that single pass, never stored.
  - **tangle** → product files on disk — the filesystem projection, on the de-re
    plane: resolve each `{path}` sink's composed code and write it.
  Projection is the family; **synthesise and tangle are members**, not stages —
  further surfaces (semantic tokens, …) are just more algebras over the Frame.

Two properties of the shape:

- **The trees are kept, not fused.** A compiler could fuse transduce-then-fold
  into one pass (a *hylomorphism*). Loom materialises both `LoomDocument` and
  `FrameModule` precisely *because* the Frame is projected many ways — one
  inspectable, mappable source of truth feeding synthesise, tangle, and every editor
  surface; a fused pipeline would keep none of them.
- **It stays pure FP with Effect.** A catamorphism is total structural
  recursion; each projection, written as an `Effect.gen` / `Effect.reduce` fold
  over a node's children (threading the cursor), is an *effectful catamorphism*.
  The Effect idiom is what the morphism already is, not a layer on top of it.

### Pedigree

This is a well-trodden class of problem; the names below are the path to follow
when extending the pipeline.

- **Overall shape** — nanopass compilers (Sarkar, Waddell & Dybvig, *A Nanopass
  Framework for Compiler Education*); multi-IR compilers generally (e.g. GHC's
  `HsSyn → Core → STG → Cmm`).
- **transduce — tree → tree** — tree transducers, and term rewriting / program
  transformation: XSLT, Stratego/XT, TXL, Rascal.
- **project — tree → surface** — unparsing / pretty-printing (Wadler, *A
  prettier printer*; Oppen), as catamorphisms / recursion schemes (Meijer,
  Fokkinga & Paterson, *Bananas, Lenses, Envelopes and Barbed Wire*); each
  surface is a different algebra over the one Frame.
- **offsets** — attribute grammars (Knuth); the *L-attributed* subclass is
  exactly the one evaluable in a single left-to-right pass.
- **literals as nodes** — lossless / concrete syntax trees (Roslyn red-green
  trees, rust-analyzer's rowan, SwiftSyntax): the same full-fidelity choice
  Loom makes for its output tree.
- **source ⇄ generated mappings** — source maps and bidirectional
  transformations (lenses); institutionalised for editors by Volar's virtual
  code + mappings, which the `synthesise` output feeds.

The layer specs own their arrows: `how-ast.md` the parse, `how-frame.md` the
transduce and synthesise. This document covers the rest of the projection family —
the tangle that writes product files, the runtime that executes the Frame, and
the Volar virtual-code layer that surfaces it.

---

## Composition Primitives

There is no separate `Code` value type and no `@literate/core` package. The
type vocabulary is the Schema-defined AST (`how-ast.md`): every node is a
`loomNode`, and a section's product code is the source text carried by its
`CodeWeft` and `ArrowWeft` nodes — read by position, not wrapped in a dedicated
value.

The Frame's composition primitives are design-level and not yet built:

- **`compose`** — orders the code of the sections it references, in argument
  order, into one composed result.
- **`tangle`** — binds a composed result to a file path; running it at the end
  of the world emits the file.

Their exact signatures follow from the AST representation and will be fixed when
the Frame synthesiser is built (the `synthesise` / `tangle` arrows over `FrameAst.ts`;
see The Transformation Pipeline); this document does not pin them down in
advance. The output is always literal code, concatenated in tangle order — the
machinery (Effect, Services, Layers) never appears unless the author wrote
Effect in a section.

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
    const frame = yield* FrameProjector.project(doc)  ← transduce (how-frame) → FrameModule
    yield* Tangle.run(frame)                          ← tangle the {path} sinks → files
  }).pipe(
    Effect.provide(Loom.Default),
    Effect.provide(FrameProjector.Default),
    Effect.provide(Tangle.Default),
    Effect.provide(NodeFileSystem.layer),
  )
)
```

- **Tangle CLI** (`pnpm tsx tangle.ts <file>.loom`) — parses the document,
  transduces it to the `FrameModule`, and tangles each `{path}` sink. The end of
  the world is the emitted files. (Equivalently, the eventual self-hosting path
  synthesises the `FrameModule` to a runnable Frame whose auto-synthesised
  `LoomMain` composition root tangles the sinks when executed.)
- **Volar LSP server** — an Effect Platform application. Parsing, Frame
  synthesis, virtual-code assembly, and diagnostics are all Effect services
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

**De dicto — the frame.** The composition machinery: the synthesised
`Effect.Service` classes, their `compose()` / `tangle()` calls, Warp wiring (the
lazy `const m = yield* Mul` bindings — no eager `dependencies` array, see
`how-frame.md` on order independence), and the author's cross-file `import`
lines. This is TypeScript that describes *how* code is composed. tsc checks it
for composition correctness.

**De re — the product.** The actual code the author wrote in a section's code
block — `def add(x, y) = x + y`, a JSON manifest, a SQL query. This is the
thing *being* composed, carried as the `code` field of each section's Service.
It may be any language the document or a section specifier declares.

The conflation to avoid: when product code happens to be TypeScript, it looks
identical to frame code. It is not. One describes composition; the other is
composed. A `.loom` position inside a heading, a Warp declaration, or a tangle
body maps to the frame; a position inside a content section's code block maps
to the product. They never mix.

---

## Volar Virtual Code Tree

Loom is a Volar extended language: code sections are first-class embedded code.
Volar already owns the concepts of embedded languages, virtual codes, and
language-specific dispatch — Loom's job is to declare the tree correctly, not
to reimplement what Volar provides.

```
root (languageId: "loom")
├── frame        (languageId: "typescript")   ← de dicto: the synthesised
│                                                Service program (how-frame)
├── tangled-0    (languageId: per target)     ← de re: resolved product for a
│                                                {path} tangle, in compose order
├── tangled-1    (languageId: per target)     ← one per tangle section
├── section-0    (languageId: per section)    ← de re: one embedded region per
│                                                content section's code block
└── …
```

- **Frame** — the single TypeScript virtual code for the synthesised Frame: the
  `Effect.Service` class per section, the Warp wiring, the tangle calls, and the
  `LoomMain` root. tsc checks it for composition correctness. Heading tags get
  hover, go-to-definition, and type info here (a tag resolves to its exported
  Service; a tagless heading to its hash-named class).
- **Tangled** — one per tangle section. The member sections' `code` composed in
  tangle order, producing a virtual document in the tangle's target language.
  The language service type-checks the assembled product and the diagnostics map
  back to the `.loom` source lines each section came from.
- **Embedded section regions** — each content section's code block is an
  embedded virtual code with its own `languageId` (the document's `{{lang: …}}`
  default, or a per-section label specifier such as `{Bash}`). Volar dispatches
  syntax highlighting and any per-region language service natively.

The default `languageId` comes from the document's `lang` Warp; a section's
label specifier overrides it for that section. A `{Loom}` section is projected
literally into the frame rather than carried as composed product (see
`how-frame.md`).

---

## Tangles Drive Type Resolution

Type checking and semantic analysis of *product* code work through the tangled
virtual documents:

```
Parse .loom  →  synthesise Frame  →  for each tangle section:
    compose its member sections' code in tangle order
    → a virtual document in the target language (correct compilation order)
    → feed to the language service (types, diagnostics, semantic tokens)
    → map results back to .loom source via bidirectional source mappings
```

This is by design. A tangle defines the compositional order; without that
order, there is no valid program to check across sections. A `.loom` file with
no tangle sections is a library or documentation — its sections are consumed by
other documents that *do* tangle. **Without a tangle, product code gets only
syntax highlighting** (Tree-sitter), no cross-section types or diagnostics.

If a section is used before its definition in document order but after it in
tangle order, there is no error — tangle order is what the language service
sees.

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
  ├─ heading bracket, Warp declaration, or tangle body
  │     → frame virtual code → language service → frame annotations
  └─ content section code block
        ├─ section is in a tangle → tangled virtual doc → product annotations
        └─ section is untangled   → Tree-sitter → syntax tokens only
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
   functions, types) for sections included in a tangle, produced from the
   tangled virtual document and mapped back to `.loom` positions.
2. **Tree-sitter syntax tokens** — keywords, strings, numbers, operators, and
   punctuation, produced per code section with the appropriate grammar. Works
   for every code section, including untangled ones.

```
Tangled sections:   semantic tokens (types, errors) via the tangled virtual doc
Untangled sections: Tree-sitter syntax tokens only
No tangles at all:  Tree-sitter syntax tokens only for every section
```

If the Tree-sitter runtime has no grammar for a language, those sections get no
syntax tokens — a missing-grammar problem, not a Loom architecture problem.
