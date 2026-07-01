# Migrating the monorepo into the book

Loom is written in Loom, but today it is written as **seven separate corpora** — one
`corpus/` per package (`loom-ast`, `loom-lang`, `loom-lang-services`,
`loom-service-typescript`, `loom-config`, `loom-cli`, `loom-vscode`). The goal is to
read the whole framework as **one book** — `corpus/book.loom` and its chapters — that
tangles to the same source across every package. This is the plan for getting there
without breaking the build.

## The book is the only specification

Loom is literate: a section's prose is its specification, beside the code it describes.
So the framework should keep no specification apart from the book. Today it still does —
`architecture.md`, the `how-*.md` design notes, the vision half of `CLAUDE.md`, and the
old `corpus/Loom.loom` draft all describe the code from a distance, and drift from it.
The migration folds each into the chapter it belongs to and deletes it:

- `architecture.md` — the two planes and the pipeline → **Part II**, spread into the
  parts it maps.
- `how-anchors.md` — anchors and warps → **Part I.2** and **Part IV**.
- `how-frame.md` — the frame pass → **Part V**.
- `how-run.md` — running the frame → **Part V.5**.
- `how-lsp.md` — the tooling and the capability matrix → **Part VII** and **Part VIII**.
- `CLAUDE.md` — its vision opens the book; its working directives stay as the
  contributor's guide, pointing into the book rather than restating it.
- `corpus/Loom.loom` — the early self-hosting draft, superseded; salvage what still
  holds into Parts I and III.

When a part is written, its spec is gone: the prose lives in the chapters, next to the
code, where it cannot drift. No document parallel to the source survives the migration.

## The book carries its tests

A test is program too, and Loom is written in Loom — so the tests belong in the book,
not in a hand-written `test/` tree beside it. A hand-written test file is the same
parallel artifact a spec is: it sits outside the narrative and drifts from the code it
checks. So a chapter carries its own tests, in a section that tangles to a `.test.ts` —
the code that proves the chapter beside the code that is the chapter. A test that spans
several chapters, like `CapabilityTable`, earns a chapter of its own; the fixtures and
helpers the tests share are looms too.

None of this is new tooling: a sink already tangles a section to any path, `vitest` runs
a tangled test like any other, and the guard that blocks hand-editing generated source
extends to cover generated tests. What it needs is a convention — where a chapter's
tests sit, how shared fixtures are named — which is itself the second work-in-progress
loom.

## The folders follow the book, not the packages

Today the corpus is filed by package — `packages/loom-ast/corpus/`,
`packages/loom-lang/corpus/`, one tree per module. The book inverts that: the folders
follow the narrative. `corpus/` mirrors the table of contents — a folder per part, a
loom per chapter, in reading order — so a person opening the source walks the book, not
the build.

```
corpus/
  book.loom                          the spine
  03-the-shape-of-a-loom/
    01-the-node-foundation.loom
    02-health-built-in.loom
    ...
```

The packaging does not vanish; it moves downstream. Each chapter tangles, through its
sink, to the file its package ships — `01-the-node-foundation.loom` writes
`packages/loom-ast/src/ast/LoomNode.ts` and its test. So `packages/*/src` becomes pure
tangle output, and a package is only what it always should have been: a `package.json`
and the generated code it publishes. The narrative is where the work is; the packages
are where it lands.

This asks one thing of tangling that the per-package layout never did — a chapter must
route its output to a directory outside its own, across the repo. The first migration
step proves that routing works before anything else moves.

## The work-in-progress part

The book ends with a part that is never finished: **Part X, Work in progress**. It holds
the framework's active work — each open problem or unbuilt feature as its own conceptual
loom.

A work-in-progress loom is not a spec. It is written to be **worked out in place**: it
opens as prose that states the problem and the shape of the answer, and you build it by
adding code to that same loom and refining the prose as the design settles — never by
taking it as a plan and rewriting it as code elsewhere. The loom travels from idea to
implementation as one artifact, so it cannot become a stale document parallel to what was
built. When it is done, it graduates: the chapter moves to its home part, and its code
tangles like any other. This is how new work is born once the migration is complete — as
a loom, never as a spec.

The first work-in-progress loom is **#23, rename freshness** — the editor's
stale-diagnostic-after-rename bug. Its loom states the cause (diagnose reads disk while
compile reads the buffer) and the shape of the fix (a passive open-document registry),
ready to be amended with the code that resolves it and verified in the editor.

## What is already true

- **The composition works.** `corpus/guide/` is a small book in the current syntax
  (`::[Chapter](file.loom)` cross-file members, a `[dist]` place sink) that tangles to
  real files. It is the shape a chapter takes, proven end to end.
- **The editor reads one table.** `LoomSymbol` drives the mappings, colour, and
  navigation for every token, cross-file (see `how-lsp.md` → the symbol capability
  matrix). Authoring the book in the editor is supported.
- **`corpus/book.loom`** already holds the table of contents — eight parts, I–VIII.

## What waits for later

1. **The work-in-progress part, and #23 with it.** Part X is written and worked out only
   once the book exists — the migration is the work until then. So the rename-freshness
   bug stays present through the migration; authoring lives with it, and it is the first
   thing worked out after, as the first exercise of the concept-to-code flow.
2. **`loom weave`.** It renders the book as a website; the migration only needs
   `loom tangle`, which works today. Weave comes after the source is book-shaped.

## The rule that keeps the build green

The book must tangle to **exactly the paths the package corpora tangle to today**. Each
chapter's sink writes the same `packages/<pkg>/src/...` file its old loom did. So at
every step: fold one package's looms into the book's chapters, tangle, and confirm the
generated `.ts` is unchanged and the tests still pass. Only then delete the old
per-package corpus. Never big-bang.

## The order — leaf first, up the dependency graph

The book reads front-to-back for a person, but we *migrate* bottom-up, so a chapter's
dependencies are already in the book when we write it.

1. **Part III, The shape of a loom → `loom-ast`.** The leaf. Nine looms
   (`loom-node`, health, tokens, wefts, the AST, the corpus, the symbol table, the
   virtual code). No Loom dependency, so it moves first and cleanest.
2. **Part IV, Reading the text → `loom-lang` parsing.** Line ranges, the weft
   classifier and tokeniser, the AST builder, the corpus builder.
3. **Part V, The frame → `loom-lang` frame.** `FrameAstBuilder`, sections as services,
   the composition language (`dsl`), the dependency graph, the runner, the product.
4. **Part VI, Tangling → `loom-lang` + `loom-config`.** The compiler, the tangler,
   configuration, faults, the build cache (`LoomMemo`).
5. **Part VII, In the editor → `loom-lang` editor + `loom-lang-services`.** The virtual
   tree, the language plugin, the server, Loom's own diagnostics.
6. **Part VIII, Languages as packages → `loom-lang-services` + `loom-service-typescript`.**
   The service contract, the store and loader, a product service.
7. **The command line → `loom-cli`; the extension → `loom-vscode`.** Their own chapters
   or an appendix.
8. **Parts I–II, Using Loom & how a loom becomes code.** Prose-first, least code — fold
   `corpus/guide/` in as Part I and lift the overview from `architecture.md` for
   Part II. Written last, read first.

## Per-step checklist

- [ ] Write the part's chapters into the book — each with the sink its old loom used and
      a section for its tests — folding the part's spec(s) into the chapters' prose.
- [ ] `loom tangle` the book; `git diff` the generated source and tests — it should be empty.
- [ ] `tsc` clean across the touched packages; `vitest run` green.
- [ ] Delete the migrated package's `corpus/`, its hand-written `test/`, and the specs
      the part absorbed.
- [ ] Commit the part as one step.

When every part is in and the per-package corpora are gone, `corpus/book.loom` is the
single corpus that tangles the whole framework — and `loom weave` can render it.
