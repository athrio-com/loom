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
`compose` and `tangle` calls, and the `yield*` an anchor hoists to reach the
section it names. It describes _how_ code is composed, and a type-checker reads it
for composition correctness.

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
`tangle` writes each `[dir, file]` sink's composed result to disk. The projections are a family, not stages — further editor
surfaces are just more folds over the same models. The Models are kept rather than
fused into one pass precisely because the frame is projected so many ways: one
inspectable, mappable source of truth feeds them all.

Above the per-module chain sit its consumers. `LoomVirtualCodeBuilder` runs the
projections that build the virtual-code tree an editor reads. `LoomCompiler` loads a
file and its imports into the `LoomMemo` cache and answers the editor's queries;
`loomVirtualCode` is its synchronous single-file entry. `LoomTangler` walks a file's
`[dir, file]` sinks and writes their composed results. `DocumentSource` is the one I/O
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
orphan bracket, an unclosed delimiter — kept in place rather than dropped.

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
parse — orphan brackets, malformed specifiers, unclosed delimiters. **Semantic
health** lives on the frame AST at the `FrameAstBuilder` pass — two section titles
that normalise to one identifier, a cross-language composition edge, an unresolved
anchor — diagnostics that need _meaning_, which the frame pass has and parse does not.
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

## Specifiers, sinks, warps, and anchors

A heading may carry two things, each optional: a language **specifier** in braces and a
**sink** in brackets. A label specifier (`{Scala}`, `{Prose}`, `{Loom}`) names the
section's language. A sink names where the section's code lands: `[dir, file]` is a
tangle sink that emits a file, and `[dir]` is a higher-order sink, a directory under
which a book places the chapters it points at. The comma tells a file from a directory,
so an extensionless file is `[., .gitignore]`. `{Loom}` is an escape hatch whose meaning
is a frame concern; the AST records only the tokens.

A warp declares a binding in the preamble. An anchor, `::[…]`, references a name. The two
use distinct delimiters — `{{…}}` for a warp, `::[…]` for an anchor — because an anchor
sits inside product code, where `{{` would collide with templating languages that own
that syntax. A warp, `{{ name [: type] = value }}`, binds a local name to a value.

An anchor takes its meaning from where it sits — the three planes. In a code line it
composes: `::[Multiplier Function]` names a section in the same document by its heading
title, and that section's composed code lands there; `::[c]` names a value a warp bound,
and the value lands there. In the prose of a `[dir]` higher-order sink it places a
chapter under that directory. In any other prose it merely navigates — a link to the
section it names, composing nothing and faulting on nothing. Prose is Markdown, so an
anchor is inert inside an inline code span or a fenced block.

Two warps survive, told apart by their delimiter. A **value warp** — `{{ c = value }}`
— binds a name to a literal that a `::[c]` anchor composes; its value is required, so a
value-less warp is a diagnostic. The **language warp** — `{{lang: TypeScript}}` — names
the document's primary language and carries an annotation, not a value, so it is exempt
from that requirement; it is optional now, and a section without one inherits the
workspace's configured language. A warp that once named another section is gone: a section reaches
another only through a name anchor, never a warp. What a name resolves to — a section, or
a bound value — is a frame concern; at the AST a warp is a declaration and an anchor a
reference.

## The frame: sections as services

Each section projects to one `Effect.Service` class exposing three fields: `name`, the
heading title; `code`, the composed product code; and `prose`, the woven literate
layer. Code and prose are peers — the two halves of the document made queryable side
by side — each a `dsl.compose(…)` or `dsl.weave(…)` call so the shape stays uniform.
The one exception is a `{Loom}` section, whose code splices into the frame unwrapped as
raw TypeScript; it is the escape hatch for what the projection model does not cover.

**Every section is exported.** There is one kind of section and no visibility scope.
The frame names each section's class after its heading title normalised to an
identifier — `Multiplier Function` becomes `MultiplierFunction` — and exports it. A name
anchor reaches a section only within the same document.

**The dependency graph is a parse-time artifact.** Name anchors are its edges — each
`::[Multiplier Function]` in a section's code block is an edge to the section that title
names — so the graph is traversable straight from the AST, with no analysis pass. The
frame projects each anchor to a lazy `const _N = yield* MultiplierFunction` inside the
service's `Effect.gen` body, and inlines that section's `code` where the anchor stood;
the `yield*` _is_ the dependency, lifted into the layer type by Effect, so the frame
emits no eager `dependencies` array. Because the only cross-reference is lazy, the frame
emits sections in document order — no topological sort — and an anchor cycle surfaces as
a diagnostic rather than blocking output.

A section whose sink names a file is a **tangle sink**: it composes the sections
its anchors name and wraps the result in a `dsl.tangle(path, …)` call instead of
returning the `{ name, code, prose }` object. It is a sink in the anchor graph — it
consumes the graph and nothing consumes it. Loom owns the **composition root**: the
frame exports `__services` (each service with its layer and the classes it depends on)
and `__run` (which yields every section), and the runner wires each dependency cone in
order and runs it — no service self-provides. The root is generated for every file with
services; the author never writes imports, assembles layers, or touches the entry
point. `how-frame.md` carries the full treatment — the projection rules, order
independence, and cross-module reuse.

## The editor surface

Loom is a Volar extended language: code sections are first-class embedded code with
their own language services. A `.loom` file projects to a tree of virtual codes — one
`frame` (the generated TypeScript, type-checked by tsc), one `prose` document (the file
stripped to its prose, read as Markdown), and one per content section: its resolved
composition, in that section's language. A `[dir, file]` tangle sink is a content
section too, in the language its file extension names — a `.json` sink is JSON even in
a TypeScript document. Volar's language-agnostic core owns embedded languages, virtual codes, and the
position mapping between a `.loom` and its projections; Loom declares the tree and
supplies the mappings. Volar's bundled TypeScript is one service this core hosts, not
its foundation — which is what lets the product plane reach past TypeScript to any
language.

Type-checking runs on the **composition roots** — the sections no other section
transcludes by name — each checked as one isolated module. A root's resolved document
is its code with its transclusions inlined: a name anchor folds the same-document
section it names into the root's shared scope, so split sections compose and resolve
together. A section reached by a name anchor is a fragment, checked inside the root
that names it and never alone — so the names it borrows from sibling sections resolve,
and a diagnostic that exists only because sections are spliced is reported once,
against the offending span. Composition order, not document order, is what the service
sees, so a section may reference another defined later in the source. A section
composes one language; a name anchor that crosses languages is an authoring error the
frame pass reports. **Syntax highlighting is the floor**: always available per code
section, and the only product signal when no composition resolves — a missing grammar,
or an anchor naming a file that cannot be read.

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

The **prose** is the literate layer, a plane of its own. `ProseLanguage`, built in
beside the frame, extends `volar-service-markdown` over the file's `prose` document, so
the prose reads and edits as Markdown; Loom's anchors keep their navigation from the
source mirror, their `::[…]` links live within it.

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
  the de re, and writes each `[dir, file]` sink's composed result. The end of the world is
  the emitted files.
- **A Vite plugin**, where applicable, is Effect-native — its transform and build hooks
  are Effect programs.

## Composition primitives

The frame imports `@athrio/loom-lang/dsl` and calls its primitives to build the de re.
They construct `ComposedCode` values — one per section — not strings:

- **`fragment`** wraps one span of product code with the `.loom` position it maps back
  to.
- **`referName`** is the one transclusion edge: it reads the named section's
  `ComposedCode` and records its identity as a `NameRef`, never a copy of its
  fragments. The frame writes a `referName` for each name anchor, and the projection
  folds the named section into the consuming section's shared scope.
- **`referValue`** composes a value warp's bound literal where a `::[c]` anchor stood.
  It carries the value, not another section, so it adds no edge to the graph.
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
