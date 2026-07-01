# Migrating the monorepo into the book

Loom is written in Loom, but today it is written as **seven separate corpora** — one
`corpus/` per package (`loom-ast`, `loom-lang`, `loom-lang-services`,
`loom-service-typescript`, `loom-config`, `loom-cli`, `loom-vscode`). The goal is to
read the whole framework as **one book** — `corpus/book.loom` and its chapters — that
tangles to the same source across every package. This is the plan for getting there
without breaking the build.

## What is already true

- **The composition works.** `corpus/guide/` is a small book in the current syntax
  (`::[Chapter](file.loom)` cross-file members, a `[dist]` place sink) that tangles to
  real files. It is the shape a chapter takes, proven end to end.
- **The editor reads one table.** `LoomSymbol` drives the mappings, colour, and
  navigation for every token, cross-file (see `how-lsp.md` → the symbol capability
  matrix). Authoring the book in the editor is supported.
- **`corpus/book.loom`** already holds the table of contents — eight parts, I–VIII.

## What to clear first

1. **Fix the rename-freshness bug (#23).** A book is rename-heavy; a stale diagnostic
   after every rename would make the migration miserable. Fix it before the big push.
   (No unit test can cover it — it is the editor's disk-vs-buffer gap — so it needs one
   in-editor verification pass.)
2. **`loom weave` is not needed yet.** It renders the book as a website; the migration
   only needs `loom tangle`, which works today. Weave comes after the source is
   book-shaped.

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

- [ ] Write the part's chapters into the book, each with the sink its old loom used.
- [ ] `loom tangle` the book; `git diff` the generated `.ts` — it should be empty.
- [ ] `tsc` clean across the touched packages; `vitest run` green.
- [ ] Delete the migrated package's `corpus/`.
- [ ] Commit the part as one step.

When every part is in and the per-package corpora are gone, `corpus/book.loom` is the
single corpus that tangles the whole framework — and `loom weave` can render it.
