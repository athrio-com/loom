# Loom LSP & Runtime — Tooling Layer

This is the tooling layer's spec. The cross-cutting overview — the two planes, the
pipeline, the runtime entry points, the editor surface — is `architecture.md` at the
repo root; the AST pipeline (source → `LoomDocument`) lives in the `corpus/` looms;
the Frame pass is `how-frame.md`. This document carries the tooling detail: the
projection passes that fold the Frame to text, the Volar/LSP integration that surfaces
it in the editor, the language packages that serve the product plane, and the source
mappings that route a position to the right plane.

Like the other specs, this describes the target architecture. The current code
may not yet conform; where it does (embedded language resolution, syntax
highlighting, source mappings, frame projection), that behaviour must be
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
  structure, one `ComposedCode` per section — its product code with each name anchor
  expressed as a resolved edge to the same-document section it names. The runner runs
  the whole reachable corpus; each section's edges are inlined later, at projection.
  (`how-run.md` covers the run.)
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
  `Effect.Service` class per section, the `yield*` each anchor hoists, the tangle calls,
  and the composition root (the `__services` map and the `__run` effect). tsc checks it
  for composition correctness. The frame names each section's class after its heading
  title normalised to an identifier, and a name anchor reaches it through a hoisted
  `const _N = yield* …` alias whose declaration maps to that heading. So the heading
  offers go-to-definition and rename — but not hover, which would only surface the
  synthetic `_N` alias.
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
**composition root**. Every section is a root until another section in the same module
folds it in through a `::[…]` name anchor. Folding demotes the target: it becomes a
fragment of the root that pulls it in, not a unit of its own. So the broadest section in
a module wins — the one nothing folds in is the root, and the sections it pulls in,
directly or through a chain, are its fragments.

A name anchor folds the named same-document section into the root's scope, and the
fragment maps to that section's own source. There is no by-value copy and no
cross-file reference: a name anchor resolves only within its own `.loom`, so every
fragment is a sibling section the root shares scope with, never a library taken from
another module.

A root's resolved document is its code with its fragments inlined, and that document is
what the language service checks. A fragment is never checked alone, so the names it
borrows from sibling sections resolve rather than read as undefined. The check's
results map back to the `.loom` sections that contributed them.

Which roots reach a language service is the package's choice. A `loom.json` lists the
languages a package activates, and a root is served only when its package activates that
root's language. A package that activates nothing keeps the frame alone, and its product
sections fall back to syntax highlighting. The frame is never gated: every `.loom` has
one, and it is always checked.

The two planes are checked by different engines, and the split follows what each plane
is. The **frame** is permanently TypeScript, so it keeps Volar's built-in TypeScript
program. That program is pinned to a baked Loom baseline — fixed compiler options and
the `@athrio/loom-lang/dsl` import root the frame composes through — so the consumer's
own `tsconfig.json` never reaches the frame, and it checks the same way in every
package. The frame is the file's primary service script, the one Volar's TypeScript
type-checks in place.

The **product** is poly-lingual, so each activated language is served by its own
package, a `@athrio/loom-service-<id>`. The package checks that language's roots against
the language's own backend: the TypeScript package re-attaches Volar's TypeScript
service to a program the consumer's `tsconfig.json` governs, so the product carries the
consumer's lints in full; every other language forwards to its external server. A root
is checked as its own module, so two roots that share a top-level name never collide.
The *Language Packages* section below covers this model — its three tiers, the per-range
feature gating, and the synchronous boundary that puts every external round-trip in an
async feature call.

A `loom.json` also carries a per-language `settings` bag — a language id mapped to that
service's own configuration — which the host hands each service alongside its plugins.
It is how a language tunes itself per package without the host knowing the keys.

A **composition diagnostic** — one that exists only because sections are spliced:
a duplicated binding, a name a mid-section anchor pulls into scope, a type that
clashes only when composed — is emergent. No section produces it alone, only the
consuming document does, so it is reported once. It maps to the actual offending span,
in whichever contributing section's `.loom` wrote it — the language service's own
order, run backward through the mappings. A name anchor folds its target into shared
scope, so the target keeps its own source as a diagnostic endpoint. There is no
by-value copy that would re-pin a diagnostic to the anchor, and no cross-file
transclusion, because a name anchor resolves only within its own `.loom`.

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

A `.loom` file reaches across files through its imports, not through its anchors. A name anchor resolves only within its own document, but the product code in a section may `import` from another module, and the frame imports sibling services the same way. To check those imports, the editor reads, parses, and composes every `.loom` the open file imports, and checks the open file's sections against that whole corpus. So the editor cannot check the open file by itself.

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

Two consumers read that health and apply their own policy. The editor surfaces it: an import of a file that cannot be read reports its error at the import the author wrote. The tangler refuses it: it gathers every error-health node across the corpus and fails with one `TangleError`, rather than write a file with a silently dropped reference.

### Invalidation Belongs to Volar

Caching the corpus is simple until a file changes. When `B.loom` changes, every file that imports it holds a stale composition and must be re-projected — and Loom delegates that to Volar. After projecting a file, the plugin calls `getAssociatedScript` for every module the file *transitively* imports, registering on Volar's association graph that the file depends on them. The registration runs after the build, on the warm corpus, so the projection it incidentally triggers is a cache hit — not the re-entrant build that reading *through* it would cause.

When `B.loom`'s snapshot then changes, Volar marks every registered dependent stale and re-projects it. Re-projecting *runs the composition*, so the output is fresh by construction. The registration is transitive because Volar propagates dirtiness one hop at a time on a snapshot change: a change deep in a chain reaches the files at the top only when each has declared the whole chain it reaches.

Loom's one remaining duty is cache coherence. `LoomMemo` is Loom's cache, not Volar's, so a `B.loom` change must evict `B.loom`'s build — `updateVirtualCode` does this when the file's own text changed — or a dependent's re-projection would recompose against a stale `B.loom`. A module's build holds only its own frame, since an imported module is resolved at projection rather than baked into the build, so evicting the single changed file is enough.

### Loom Builds No Graph

The import relationships form a directed graph, but Loom never materialises one, and never computes the reverse direction. Forward edges are read off each module during the walk, and declared to Volar as associations. The reverse direction — which dependents a change invalidates — is Volar's, derived from those forward associations: Loom asks Volar to re-project, it does not decide what re-projects. An import cycle is caught by the visited set the walk threads as it follows each module's imports. Effect's `Graph` module would add a second structure, keyed by its own node indices, for needs already met, so Loom declines it.

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
  ├─ heading, warp, name anchor, tangle body, or {Loom} code (FrameCode)
  │     → frame virtual code (tsc) → frame annotations
  └─ a product section's code block (EmbeddedCode)
        → the section's resolved composition → product annotations
           (unresolved, e.g. an anchor to a file that cannot be read → Tree-sitter syntax tokens only)
```

Frame annotations (a heading's resolved Service class, a name anchor's resolved
target section, a composition type error) and product annotations (a type error in the
author's code, hover on a local variable) never mix; the source position alone decides
which virtual code answers.

---

## Language Packages

The product plane is poly-lingual, and each language it activates is served by its own
package — a `@athrio/loom-service-<id>`, installed as a dev dependency and named in the
package's `loom.json`. These packages together are the **multiplexer**: the layer that
routes each product section to the service for its language. TypeScript is one such
package, not a built-in exception.

This rests on what Volar actually provides. Volar's enduring value is its
language-agnostic core: `@volar/language-core` maps a `.loom` position to the embedded
code that answers it, and `@volar/language-service` hosts feature providers and merges
their results. Its bundled TypeScript service, `volar-service-typescript`, is one
provider this core hosts, not the foundation. A language package is therefore a
`LanguageService` the core hosts, and `resolveActive` turns the ids a `loom.json`
activates into the services that run — `LoomLanguage` always, then each activated id,
with an unknown id reserved for the `loom-service-<id>` package that will answer it.

### Three tiers in a package

A package composes its features in three tiers, sorted by who computes each one.

The first tier is **Loom-structural**, and it is shared across every language.
Go-to-definition from a `::[…]` anchor to its section, completion of section titles,
hover on a value warp, the diagnostic a cross-language anchor raises — these read the
corpus AST and the mappings Loom already builds, so they are identical whether the
section is Python or Scala. They are written once and ride in every package.

The second tier is **language-semantic**, and it differs per language. Real
type-checking, real identifier completion, and real hover come from a backend. The
TypeScript package re-attaches `volar-service-typescript` to an in-process
`ts.LanguageService` — the standalone assembly `@volar/kit` already builds for the
checker tests. Every other language forwards the request to its external server: Pyright
for Python, gopls for Go, Metals for Scala.

The third tier is the **escape hatch** — a plugin for something genuinely specific to one
language. A package rarely needs it.

### How the core serves features

The core is a position mapper wrapped around these plugins, so a package never writes
mapping logic of its own. For any request, the core finds the embedded code that covers
the `.loom` position, translates the position into that code's space, calls each
plugin's `provide*`, and translates the returned ranges back to the `.loom`.

Which features are live on a span is a per-range declaration. Each mapping carries a
`CodeInformation` flag set, and the core routes a feature only where its flag is set:
`verification` gates diagnostics and code actions, `completion` gates completion,
`semantic` gates hover and semantic tokens, `navigation` gates definition, references,
and rename, `structure` gates document symbols and folding, and `format` gates
formatting. A heading maps with `navigation` set and `verification` clear, so it offers
go-to-definition and rename yet raises no raw type error. This one mechanism is most of
how the core helps; a package supplies only the analysis behind it.

### The synchronous boundary

Projection is synchronous and feature provision is not, and that difference is what makes
forwarding clean. The projection hook runs under `Runtime.runSync` and cannot await, so
it must build the virtual-code tree in one tick (see *Resolving the Corpus in the
Editor*). A `provide*` call runs off the JSON-RPC loop and may return a promise. So a
round-trip to an external server lives inside a plugin's `provide*`, never in the
projection hook — and the core still maps every position for it through the embedded
code's mappings. Forwarding is a backend behind an async feature call, not a second
dispatch path.

The genuine cost is per-language and irreducible: an external server answers well only
against a faithful project — Pyright a resolvable import environment, Metals a build — so
the package must synthesize that project and keep the server's view of the document in
sync. Encapsulating each server's project model in its own package, rather than in one
layer that pretends they are uniform, is the strongest reason the package is the
boundary.

### Where the frame sits, and how this is built

The frame does not pass through a language package. It stays in Volar's built-in
TypeScript program against the baked Loom baseline (see *Composition Drives Type
Resolution*) — the one plane that earns Volar's single per-file TypeScript program,
because it is the one plane that is always TypeScript.

Today the frame and the product TypeScript share that one program: the frame as the
primary service script, the product roots handed in through `getExtraServiceScripts`.
That shared program is the interim. Moving the product TypeScript into its own
`loom-service-typescript` program is the step that separates the planes, and the same
step makes the frame hermetic — once the product no longer rides the frame's program,
that program answers to the baked baseline alone. The `@athrio/loom-tsconfig` baseline,
which today merges under the consumer's `tsconfig.json` so the shared program keeps the
product's lints, becomes the frame's fixed configuration at that point.

The packages are built one at a time, and the shared forwarder is extracted rather than
designed up front. `loom-service-typescript` comes first: it separates the planes, it
makes the frame hermetic, and its backend is the in-process re-attach already proven in
the tests. `loom-service-python`, forwarding to Pyright, comes next as the first external
server — the first real test of project reproduction and document sync. A shared
forwarding library is worth extracting once a second external server confirms its shape,
not before.

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
