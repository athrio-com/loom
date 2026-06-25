# Loom — architecture

Loom turns one `.loom` file into two things from a single source: the real files
its sections compose into on disk, and a live language an editor type-checks and
navigates. Tangling makes Loom a build step; the live language makes it a language —
and because Loom composes any language, the editor serves each section in the language
it was written in, not only TypeScript. `@athrio/loom-lang` holds both — the Volar
extended language the editor loads and the engine the command-line tool tangles with. This document is the
cross-cutting overview: the planes the system works in, the pipeline that drives
it, and the rules that span layers. Vision and working directives are in
`CLAUDE.md`; each module's own detail is a literate program in
`packages/loom-lang/corpus/`; the frame and tooling layers keep their full specs in
`packages/loom-lang/src/ast/how-frame.md` and `packages/loom-lang/how-lsp.md`.

## Two planes

A `.loom` file is read along two planes at once, and every `.loom` position belongs
to exactly one of them.

The _de dicto_ plane is the **frame**: the TypeScript program Loom synthesises to
compose the file's sections — the generated `Effect.Service` classes, their
`compose` and `tangle` calls, the warp wiring, the author's cross-file imports. It
describes _how_ code is composed, and a type-checker reads it for composition
correctness.

The _de re_ plane is the **product**: the author's own code, each section in the
language it was written in — a Scala definition, a JSON manifest, a SQL query. It is
the thing _being_ composed, carried as each section's `code`.

The conflation to avoid: when product code happens to be TypeScript it looks
identical to frame code, but one describes composition and the other is composed. A
position inside a heading, a warp, a tangle body, or a `{Loom}` section maps to the
frame; a position inside a product section's code block maps to the product. The
source position alone decides which virtual code answers, and the two never mix.

## The transformation pipeline

Loom is a chain of small, total tree transformations — the architecture of a
compiler, and of literate tangling. The chain is one shape repeated end to end: a
**Model** (a Schema-defined AST) and the **Builder** that produces it from the
previous Model. No pass reaches past its inputs, so the chain reads uniformly.
`LoomCorpusAstBuilder` runs it for a module:

```
text
  → LoomSourceRanges    line ranges          (with MixedEOL recovery)
  → WeftClassifier      mode-classified wefts
  → WeftTokeniser       tokenised wefts
  → LoomAstBuilder      LoomDocument          (the parse result)
  → FrameAstBuilder     FrameModule           (de dicto; the de re is the frame run — see how-run.md)
```

From the `FrameModule` the pipeline fans out two ways. `fromFrame` projects the frame
straight to the TypeScript an editor type-checks. The de re takes one step more: the
**runner** (`LoomRunner`) executes the frame to a `ComposedCode` per section, then
`fromProduct` projects each section's product code with its transclusions inlined, and
`tangle` writes each `{path}` sink's composed result to disk. The projections are a family, not stages — further editor
surfaces are just more folds over the same models. The Models are kept rather than
fused into one pass precisely because the frame is projected so many ways: one
inspectable, mappable source of truth feeds them all.

Above the per-module chain sit its consumers. `LoomVirtualCodeBuilder` runs the
projections that build the virtual-code tree an editor reads. `LoomCompiler` loads a
file and its imports into the `LoomMemo` cache and answers the editor's queries;
`loomVirtualCode` is its synchronous single-file entry. `LoomTangler` walks a file's
`{path}` sinks and writes their composed results. `DocumentSource` is the one I/O
seam they read through. `how-lsp.md` carries the full treatment — the projection
folds, the offset model, and the pedigree of the design.

## The AST: three layers, one shape

The parse result is an AST in three layers over a shared foundation:

```
Containers  (LoomAst)     LoomDocument, LoomSection, LoomHeading — multi-line units
Wefts       (Weft)        one classified line each
Tokens      (LoomTokens)  the spans inside a line
Foundation  (LoomNode)    Position, Health, the loomNode combinator
```

Every node — container, weft, or token — is built by `loomNode`, so all share one
shape: a `type` discriminator, a `position`, the `source` slice it covers, its
`health`, and an optional `unexpected` array. There is no translation step between
the layers; each layer is itself a discriminable AST node, and a walker recurses by
`type`. `unexpected` is the universal slot for fragments the schema rejects — an
orphan bracket, a duplicate tag — kept in place rather than dropped.

The document is flat: a `LoomDocument` is a preamble and a `LoomSection[]` with no
nesting and no parent containers. Every heading creates a section whatever its level;
heading levels are prose organisation for the reader and carry no structural meaning.

## Health: two-tier and self-describing

Every node carries a `health`: `ok`, `error`, `warning`, or `incomplete`. There is no
separate diagnostic collector — a consumer derives the flat diagnostic list by walking
the tree for the non-`ok` nodes, each diagnostic already positioned at the leaf where
the problem lives.

Every stage produces a schema-valid AST. A malformation never breaks the schema;
`health` and `unexpected` carry the truth. Two channels feed them at parse: the
classifier emits a weft with `incomplete` placeholders for the subtokens it cannot yet
fill, and the tokeniser settles them — so after the tokeniser no weft is `incomplete`.
Where source is present but malformed, the tokeniser still builds a valid node, with
error health and the bad bytes in `unexpected`.

Health is two-tier, one tier per AST. **Grammatical health** lives on the Loom AST at
parse — orphan brackets, malformed labels, duplicate tags, unclosed delimiters.
**Semantic health** lives on the frame AST at the `FrameAstBuilder` pass — a tag on a
`{Loom}` section, a cross-language composition edge, an unresolved anchor —
diagnostics that need _meaning_, which the frame pass has and parse does not.
Both surface at source: grammatical health is already on nodes that carry their
`position`, and semantic health rides the mapping back to its originating `.loom` span.
The editor merges the two tiers and withholds neither.

One failure escapes the model. Mixed line terminators make every line range
meaningless, so no node can carry the problem; `LoomSourceRanges` raises `MixedEOL`,
and the parse recovers with an empty document whose root health holds the single
diagnostic.

## The grammar

A section body opens in preamble mode. The first `=>` enters code and the first `~`
enters prose, and from there the two alternate — a `~` ends a code chunk, a later `=>`
re-enters code. Arrow is the only way into code, tilde the only way into prose. The
document preamble is preamble mode before any heading, and takes no transition. Every
section obeys the same grammar whatever its specifier; the specifier changes what the
code is typed against, not the shape of the body.

## Specifiers and warps

A heading may carry a specifier in braces. A label specifier (`{Scala}`, `{Loom}`)
names the section's language; a path specifier (`{src/main.ts}`), told apart by its
path separators, marks the section as a tangle sink. `{Loom}` is an escape hatch whose
meaning is a frame concern; the AST records only the token.

A warp declares a binding and an anchor references it. A declaration,
`{{ name [: type] = value }}`, is recognised in a preamble line and binds a local name
to a value; an anchor, `::[name]` or `::[Heading Name]`, is recognised in a code line
and composes one. The two use distinct delimiters — `{{…}}` for a declaration, `::[…]`
for a reference — because an anchor sits inside product code, where `{{` would collide
with templating languages that own that syntax. What a declaration's value names — a
section service, or a plain literal — is a frame concern; at the AST a warp is a
declaration and an anchor a reference. A value is required: a value-less warp is a
diagnostic, with the one exception of the `{{lang: …}}` directive that names the
document's language.

## The frame: sections as services

Each section projects to one `Effect.Service` class exposing three fields: `name`, the
heading title; `code`, the composed product code; and `prose`, the woven literate
layer. Code and prose are peers — the two halves of the document made queryable side
by side — each a `core.compose(…)` or `core.weave(…)` call so the shape stays uniform.
The one exception is a `{Loom}` section, whose code splices into the frame unwrapped as
raw TypeScript; it is the escape hatch for what the projection model does not cover.

**Tags determine visibility.** A section with an explicit `[Tag]` is exported and forms
part of the document's public API, referenceable from other files. A tagless section is
private: its class name is the heading title normalised to an identifier, and it is
reachable only within the same document, by a name anchor.

**The dependency graph is a parse-time artifact.** Service-warp declarations are its
edges — each `{{m = Mul}}` is a named edge to another section — so the graph is traversable
straight from the AST, with no analysis pass. The frame projects each edge to a lazy
`const m = yield* Mul` inside the service's `Effect.gen` body; that `yield*` _is_ the
dependency, lifted into the layer type by Effect, so the frame emits no eager
`dependencies` array. Because the only cross-reference is lazy, the frame emits
sections in document order — no topological sort — and cycles surface as a diagnostic
rather than blocking output.

A section whose specifier is a file path is a **tangle sink**: it composes its members
and wraps the result in a `core.tangle(path, …)` call instead of returning the
`{ name, code, prose }` object. It is a sink in the warp graph — it consumes the graph
and nothing consumes it. Loom owns the **composition root**: the frame exports
`__services` (each service with its layer and the classes it depends on) and `__run`
(which yields every section), and the runner wires each dependency cone in order and
runs it — no service self-provides. The root is generated for every file with
services; the author never writes imports, assembles layers, or touches the entry
point. `how-frame.md` carries the full treatment — the projection rules, order
independence, and cross-module imports.

## The editor surface

Loom is a Volar extended language: code sections are first-class embedded code with
their own language services. A `.loom` file projects to a tree of virtual codes — one
`frame` (the generated TypeScript, type-checked by tsc), and one per content section:
its resolved composition, in that section's language. A `{path}` tangle sink is a
content section too, in the language its path extension names — a `.json` sink is
JSON even in a TypeScript document. Volar's language-agnostic core owns embedded languages, virtual codes, and the
position mapping between a `.loom` and its projections; Loom declares the tree and
supplies the mappings. Volar's bundled TypeScript is one service this core hosts, not
its foundation — which is what lets the product plane reach past TypeScript to any
language.

Type-checking runs on the **composition roots** — the sections no other section
transcludes by name — each checked as one isolated module. A root's resolved document
is its code with its transclusions inlined: a name anchor folds a same-document
section into the root's shared scope, so split sections compose and resolve together;
a Warp copies a tagged section in by value, kept apart from the original. A section
reached by a name anchor is a fragment, checked inside the root that names it and
never alone — so the names it borrows from sibling sections resolve, and a diagnostic
that exists only because sections are spliced is reported once, against the offending
span. Composition order, not document order, is what the service sees, so a section
may reference another defined later in the source. A section composes one language; a
name anchor that crosses languages is an authoring error the frame pass reports.
**Syntax highlighting is the floor**: always available per code section, and the only
product signal when no composition resolves — a missing grammar, or a cross-file
dependency.

Above that floor, each plane is served by the engine that fits what it is. The
**frame** is permanently TypeScript — every `.loom` has one — so it keeps Volar's
built-in TypeScript program, pinned to a baked Loom baseline. The consumer's own
`tsconfig.json` never reaches the frame, so it checks the same way in every package.
The **product** is poly-lingual — a section is TypeScript, Python, or Scala — so each
activated language is served by its own package, a `@athrio/loom-service-<id>`. The
TypeScript package re-attaches Volar's TypeScript service to the product's own program,
which the consumer's `tsconfig.json` governs; every other language forwards to its
external server, such as Pyright for Python. These packages together are the
**multiplexer**, and each one layers the shared Loom features — go-to-definition from an
anchor to its section, completion of section names — over whatever its language's
backend provides. TypeScript is the first such package, not a privileged built-in. Loom
composes any language, so it must treat any language as first-class in the editor —
otherwise the promise holds for only one.

`how-lsp.md` carries the full treatment — the virtual-code tree, the plane routing of
source mappings, the language-package model, and syntax highlighting.

## Runtime entry points

Every Loom process is an Effect program: it begins at `NodeRuntime.runMain()` (or
`Effect.runFork()`), provides its Layers, and runs to the end of the world, where the
output is pure text. Effect drives the process — not imperative code that calls Effect
occasionally, and never an `Effect.runSync` / `runPromise` in the middle of an
imperative flow.

- **The LSP server** (`src/LoomServer.ts`, launched by the thin `src/index.ts`) is an
  Effect Platform application. Parsing, the frame pass, the runner, virtual-code
  assembly, and diagnostics are all services composed via Layers, provided through
  `LoomCompiler.Default`; the server starts as an Effect program and yields
  `Effect.never` to stay alive.
- **The tangle CLI** drives `LoomTangler`, which builds the corpus, runs the frame for
  the de re, and writes each `{path}` sink's composed result. The end of the world is
  the emitted files.
- **A Vite plugin**, where applicable, is Effect-native — its transform and build hooks
  are Effect programs.

## Composition primitives

The frame imports `#loom/core` and calls its primitives to build the de re. They
construct `ProductAst` values — a `ComposedCode` per section — not strings:

- **`fragment`** wraps one span of product code with the `.loom` position it maps back
  to.
- **`referName`** and **`referTag`** are the two transclusion edges: each reads another
  section's `ComposedCode` and records its identity, never a copy of its parts. The
  frame writes `referName` for a name anchor into the same document — its target shares
  the consuming section's scope — and `referTag` for a Warp binding to a tag — its
  target is taken by value, a copy. The projection reads the kind: it folds a `NameRef`
  into shared scope and copies a `TagRef`.
- **`compose`** assembles a section's fragments and references, in argument order, into
  one `ComposedCode`, stamped with the section's identity and language.
- **`weave`** is `compose`'s peer for prose, assembling a `WovenProse`.
- **`tangle`** binds a composed result to a file path as a pure descriptor — it writes
  nothing; the tangler does the writing at the end of the world.

Running the frame calls these to produce the de re (`how-run.md`). The output is always
literal code in tangle order, and the machinery — Effect, Services, Layers — never
appears unless the author wrote Effect in a section.

## Invariants

- `LoomWeft` is the stream element between every parse stage; there is no intermediate
  line type.
- Every AST node is built by `loomNode`; there are no parallel node schemas.
- `Schema.is(LoomDocument)` holds at every stage, and no input line is dropped between
  them.
- The frame pass, the projections, and the tangler sit above the parse AST; the AST
  records source structure, never how it composes.

## Where the detail lives

Each module is a literate program in `packages/loom-lang/corpus/`:

| concern | loom | layer spec |
|---|---|---|
| foundation, health | `loom-node` | — |
| tokens | `loom-tokens` | — |
| wefts | `loom-weft` | — |
| containers | `loom-ast` | — |
| line scanning | `loom-line-ranges` | — |
| classify, tokenise, build | `loom-weft-classifier`, `loom-weft-tokeniser`, `loom-ast-builder` | — |
| frame pass | `frame-ast`, `frame-ast-builder` | `packages/loom-lang/src/ast/how-frame.md` |
| de re model, runner | `loom-product-ast`, `frame-runner` | `packages/loom-lang/how-run.md` |
| corpus, cache, compiler | `loom-corpus-ast`, `loom-corpus-ast-builder`, `loom-memo`, `compiler` | `packages/loom-lang/how-lsp.md` |
| virtual code, tangle | `loom-virtual-code`, `loom-virtual-code-builder`, `loom-tangler` | `packages/loom-lang/how-lsp.md` |
| language server, plugin | `server`, `loom-language-plugin` | `packages/loom-lang/how-lsp.md` |
