# Loom LSP & Runtime — Tooling Layer

This is the tooling layer's spec. The cross-cutting overview — the two planes, the
pipeline, the runtime entry points, the editor surface — is `architecture.md` at the
repo root; the AST pipeline (source → `LoomDocument`) lives in the `corpus/` looms;
the Frame pass is `how-frame.md`. This document carries the tooling detail: the
projection passes that fold the Frame to text, the Volar/LSP integration that surfaces
it in the editor, and the source mappings that route a position to the right plane.

Like the other specs, this describes the target architecture. The current code
may not yet conform; where it does (embedded language resolution, syntax
highlighting, source mappings, the multiplexer), that behaviour must be
preserved, not regressed.

---

## The Transformation Pipeline

`architecture.md` → The transformation pipeline frames the whole chain: a **nanopass
pipeline** of small, total **passes** between explicitly-defined Schema-defined
models, each pass a **Builder** producing a **Model**. This section carries the
detail the overview defers — the role each pass plays in the program-transformation
literature, the projection family, and the design's pedigree. The names below fix
both the shape we build and the discipline that keeps it pure.

```
text ─parse─▶ LoomDocument ─FrameAstBuilder─▶ FrameModule ─┬─ fromFrame ─▶ LoomVirtualCode             (de dicto frame)
                                                           └─ run (LoomRunner) ─▶ ComposedCode ─┬─ fromProduct ─▶ LoomVirtualCode  (de re product)
                                                                                                └─ tangle ─▶ product files          (filesystem)
```

Each model, and the pass (its Builder) that produces it:

- **`LoomDocument`** — the parse passes (`LoomSourceRanges` → `WeftClassifier` →
  `WeftTokeniser` → `LoomAstBuilder`, run as a flat chain in `LoomCorpusAstBuilder`):
  source text → the input AST.
- **`FrameModule`** — `FrameAstBuilder` (`how-frame.md`): `LoomDocument` → the
  Frame, the composition program (`FrameAst.ts`). A *macro tree transducer*: a
  tree→tree pass that hoists bindings, resolves anchors, and generates
  scaffolding — strictly more than a structure-preserving homomorphism. No
  surface text is emitted here; emitting is projection.
- **`ComposedCode`** — produced by **running**, not by a Builder: the runner
  (`LoomRunner`, `FrameRunner.ts`) executes the rendered `FrameModule` to the de re
  structure, one `ComposedCode` per section — its product code with transclusions
  expressed as resolved edges. The runner runs the whole reachable corpus; the
  cross-file graph is followed later, at projection. (`how-run.md` covers the run.)
- **`LoomVirtualCode`** — `LoomVirtualCodeBuilder` (`LoomVirtualCodeBuilder.ts`), the
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

The layers own their passes: the `corpus/` looms the parse, `how-frame.md` the
`FrameAstBuilder` pass and `fromFrame`. This document covers the rest of the
projection — `fromProduct`, the tangle that writes product files, and the Volar
virtual-code layer that surfaces the product. The runner that produces the de re is in
`how-run.md`.

---

## Volar Virtual Code Tree

Loom is a Volar extended language: code sections are first-class embedded code.
Volar already owns the concepts of embedded languages, virtual codes, and
language-specific dispatch — Loom's job is to declare the tree correctly, not
to reimplement what Volar provides.

```
root (languageId: "loom")
├── frame        (languageId: "loom")         ← de dicto: the Frame's Service
│                                                program, via fromFrame (how-frame)
├── section-0    (languageId: per section)    ← de re: a section's resolved
│                                                composition (code + transclusions)
├── section-1    (languageId: per section)    ← a {path} sink is a section too,
│                                                in the language its extension names
└── …
```

- **Frame** — the Frame's single virtual code (`fromFrame`), generated TypeScript: the
  `Effect.Service` class per section, the Warp wiring, the tangle calls, and the
  composition root (the `__services` map and the `__run` effect). tsc checks it for
  composition correctness. A heading tag maps to its generated Service class, so it
  offers go-to-definition and rename — but not hover, which would only surface that
  generated class. A tagless heading takes the class named after its normalized title.
- **Embedded section compositions** — each content section projects to its
  *resolved composition*: its code with its transcluded sections inlined in
  composition order, in its own `languageId`. The id is the document's `{{lang: …}}`
  default, a per-section label specifier such as `{Bash}`, or — for a `{path}` tangle
  sink — the language its path extension names, so a `.json` sink is JSON. Syntax
  highlighting is the floor for every section; type-checking is narrower (below).

A `{Loom}` section is projected literally into the frame rather than carried as
composed product (see `how-frame.md`).

---

## Composition Drives Type Resolution

Type checking and semantic analysis of *product* code work through the
*composition* — the de re projection of the Frame, anchored by the file's `Root`
(generated where the file has Services; see `how-frame.md`). The unit is the
**composition root**: a section no other section transcludes by name. A root's
resolved document is its code with its transclusions inlined — a name anchor folds a
same-document section into the root's shared scope, a Warp copies a tagged section in
by value — and that document is what the language service checks. A section reached by
a name anchor is a fragment of the root that names it; it is never checked alone, so
the names it borrows from sibling sections resolve rather than read as undefined. The
check's results map back to the `.loom` sections that contributed them.

Which roots reach a language service is the package's choice. A `loom.json` lists the
languages a package activates, and the editor hands a root to a TypeScript program —
through Volar's `getExtraServiceScripts` — only when the package activates that root's
language. Each root is handed over as its own module, so two roots that share a
top-level name never collide. A package that activates nothing keeps the frame alone,
and its product sections fall back to syntax highlighting. The frame is never gated:
every `.loom` has one, projected as the file's primary service script and always
checked.

`loom.json` also carries a per-language `settings` bag — language id to that
service's own configuration — which the host hands each service alongside its
plugins. It is how a language tunes itself per package without the host knowing the
keys. The TypeScript service uses it for the planes' one real divergence: the de re
product is a template, so by default it drops the unused-declaration lint (TS 6133
and its family) from product documents, telling product from frame by language id,
while the frame and the real tangled source stay strict. A package sets
`product.lintUnused` to `true` to put the lint back. This is the logical separation
the two planes need — the frame and the product share Volar's one TypeScript program
but answer to their own configuration.

A **composition diagnostic** — one that exists only because sections are spliced:
a duplicated binding, a name a mid-section anchor pulls into scope, a type that
clashes only when composed — is emergent. No section produces it alone, only the
consuming document does, so it is reported once. By default it maps to the actual
offending span, in whichever contributing section's `.loom` wrote it — the
language service's own order, run backward through the mappings. The exception is a
**by-value** transclusion: when the offending span was copied in through a Warp to a
tagged section, the diagnostic re-pins to the `::[…]` **anchor** in the consuming
section — the composition is the consumer's to own, and the tagged section's author
never sees it — not to that section's own source. A cross-file transclusion is always
by value, so this is the path a library's inlined code takes.

Composition order — not document order — is what the language service sees, so a
section may reference another defined later in the source without error. The
order is the transclusion graph: a section's code follows the code of the
sections it transcludes through `::[…]` anchors.

**Transclusion absorbs the block's trailing newline.** An anchor stands for the
transcluded block's *lines*; the line break that ends the anchor's own line
supplies the block's last terminator, so an inlined block sheds its trailing
newline and the consuming section's literal layout becomes the output's: `::[a]`
then `::[b]` stacked places the blocks on consecutive lines, one blank line
between the anchors yields exactly one blank line between the blocks, and the
final anchor's break is the file's single trailing newline — no doubled gaps, no
trailing blank (noweb's chunk-reference semantics). It is generated-side only: the
shed newline's `.loom` origin stops being mapped — a newline is never a hover or
diagnostic target — and every source span is left exact.

A **tangle sink** is a composition root whose unit is a file-output target: a
`{path}` section assembles its members into one document, in the language its path
extension names — type-checked as that language and, at the end of the world, written
to disk. A library `.loom` with no sink still has roots: any section nothing
transcludes by name is one, checked within itself. A section composes one language; a
name anchor that pulls in a section of another language is an authoring error,
reported on the anchor.

**Syntax highlighting (Tree-sitter) is the floor** — always available, and the
only product signal when a composition cannot be resolved, as when a section's
grammar is missing or an anchor names a file that cannot be read.

---

## Resolving the Corpus in the Editor

A section's resolved composition reaches across files. A `::[…]` anchor can name a section in another `.loom`, and resolving it inlines that section's code into the consuming document. So the editor cannot check the open file by itself. It reads, parses, and composes every `.loom` the open file imports, and checks the open file's sections against that whole corpus.

That corpus build runs on every keystroke, inside Volar's projection hook. The hook is synchronous: Volar hands over a snapshot and wants a virtual-code tree back in the same tick, because TypeScript's checker pulls the hook on the stack while it type-checks the frame. Every constraint below follows from that one fact.

### One Synchronous Pipeline

The editor runs the corpus build through `Runtime.runSync`, and `runSync` forbids async suspension — the hook has no point at which it can await a file read and resume later. So the build is synchronous from end to end. Each pass from parse through projection is pure computation over data already in hand, and the one piece of input and output, reading a file's bytes, goes through Node's synchronous `fs`. The precedent already sits in the tree: commit 49e91ab made `loom.json` resolution synchronous for this same reason.

The rule is "no suspension", not "no input and output". A synchronous file read is legal under `runSync`; an async one is not. Reading files synchronously is therefore the choice that lets the corpus build run under the hook at all.

The tangler runs the same build. Both the editor and the tangler read through one `Source` — the seam `LoomCorpusAstBuilder` reads each file's text through. Both builds are synchronous. Async now survives only in the server's shell — the JSON-RPC message loop between the editor and the server, the `onInitialize` handler, and the file-watch handlers. The build itself never suspends.

### Reading a File

The open file arrives as a Volar snapshot; its imports are read from disk. The editor's `Source` is *passive*: the open file from the snapshot, each import through a synchronous disk read, and nothing else. Passivity is the rule, not a convenience. Reading an import through a Volar API such as `getAssociatedScript` would *project* that import — re-entering the projector mid-build and deadlocking the synchronous run, since to build a file it would have to build that file. The build reads bytes; whatever touches Volar's own machine stays out of it.

Reading imports from disk means cross-file content reflects the *saved* file. An unsaved edit to an imported file appears when it is saved. A server-maintained snapshot map — read passively, the way the disk is — would close that gap without re-entering Volar; it is a later refinement, not a change to this shape.

### A Memoised Walk

`LoomCorpusAstBuilder` builds one module: it reads a file, parses it, and frames it. `LoomCompiler` follows that module's imports to build the rest of the corpus, runs the assembled frames for the de re, and keeps each built module in `LoomMemo` so a keystroke rebuilds only the file that changed. The walk takes one file at a time, depth first, and it is cycle-safe because a module is cached before its imports are followed.

The walk discovers the corpus as it parses. A module's import edges live on the module and are read out of its parsed text, so the walk must parse a file to learn which files it reaches next. Resolving the whole graph first and building it second would have to parse every file to find those edges — the same work — so the build stays one memoised walk with no separate graph to resolve.

### Total Over Failure

Every failure is a value in a node's health, never a thrown exception. A file that cannot be read becomes a placeholder module carrying an error diagnostic, the same recovery a malformed parse takes through `emptyDocumentFor`. The build never throws, so one unreadable import degrades to a diagnostic on that import rather than crashing the open file's projection.

Two consumers read that health and apply their own policy. The editor surfaces it: an anchor into a file that cannot be read reports its error at the `::[…]` site the author wrote. The tangler refuses it: it gathers every error-health node across the corpus and fails with one `TangleError`, rather than write a file with a silently dropped reference.

### Invalidation Belongs to Volar

Caching the corpus is simple until a file changes. When `B.loom` changes, every file that transcludes it holds a stale composition and must be re-projected — and Loom delegates that to Volar. After projecting a file, the plugin calls `getAssociatedScript` for every module the file *transitively* imports, registering on Volar's association graph that the file depends on them. The registration runs after the build, on the warm corpus, so the projection it incidentally triggers is a cache hit — not the re-entrant build that reading *through* it would cause.

When `B.loom`'s snapshot then changes, Volar marks every registered dependent stale and re-projects it. Re-projecting *runs the composition*, so the output is fresh by construction. The registration is transitive because Volar propagates dirtiness one hop at a time on a snapshot change: a change deep in a chain reaches the files at the top only when each has declared the whole chain it reaches.

Loom's one remaining duty is cache coherence. `LoomMemo` is Loom's cache, not Volar's, so a `B.loom` change must evict `B.loom`'s build — `updateVirtualCode` does this when the file's own text changed — or a dependent's re-projection would recompose against a stale `B.loom`. A module's build holds only its own frame, since a transclusion is inlined at projection rather than baked into the build, so evicting the single changed file is enough.

### Loom Builds No Graph

The import relationships form a directed graph, but Loom never materialises one, and never computes the reverse direction. Forward edges are read off each module during the walk, and declared to Volar as associations. The reverse direction — which dependents a change invalidates — is Volar's, derived from those forward associations: Loom asks Volar to re-project, it does not decide what re-projects. A transclusion cycle is caught by the visited set `fromProduct` threads as it inlines. Effect's `Graph` module would add a second structure, keyed by its own node indices, for needs already met, so Loom declines it.

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
           (unresolved, e.g. an anchor to a file that cannot be read → Tree-sitter syntax tokens only)
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
