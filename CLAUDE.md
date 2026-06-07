# Loom — System Specification

## What Loom Is

Loom is a literate programming framework written in Effect-TS. A `.loom` file
contains prose and code sections in narrative (document) order; the composition
layer reorders and assembles them into real source files on disk. Loom is
language-agnostic — the document declares its primary language with a
`{{lang: …}}` Warp, and individual sections may switch language with a
specifier (`{Bash}`, `{json}`). Loom is written in Effect-TS, but as a tool it
composes any language.

Loom is not a templating engine. It is a composition system built on Effect,
and code is its product. Each section projects to an `Effect.Service`
exposing `{ name, preamble, code }`; `compose()` orders the composed `code` and
`tangle()` binds it to a file path. At the end of the world the Effect program
resolves to pure text — the output files. The machinery (Effect, Services,
Layers) never appears in the output unless the author wrote Effect in a
section; the runtime is invisible.

Loom is a Volar extended language: code sections are first-class embedded code
with their own language services, diagnostics, and highlighting. This is
foundational and must not be degraded.

## The Specifications

This file is vision and working directives. The authoritative, detailed specs
live in relevant layered documents — read the one before changing the correpsonding
layer, and treat it as the source of truth (this file deliberately does not
duplicate their detail):

- **`packages/language-server/src/ast/how-ast.md`** — *parsing*. Source text →
  `LoomDocument` AST: Wefts, Tokens, Warps, label/path specifiers, the health
  model, and the forward-only mode grammar (Preamble → Code → Prose). The AST
  pipeline in `src/ast` conforms to it.
- **`packages/language-server/src/ast/how-frame.md`** — *the frame pass*. AST
  → `Effect.Service` classes: each section is a Service exposing
  `{ name, preamble, code }`; tags determine visibility (tagged = exported,
  tagless = private/hashed); the Warp graph drives dependencies and emission
  order; tangle sections (`{path}` specifier) emit files; the composition root
  is auto-generated.
- **`packages/language-server/how-lsp.md`** — *tooling*. The
  composition primitives (`compose`, `tangle` — design-level, not yet built), the runtime entry points (Tangle CLI, LSP server, Vite plugin), and
  the Volar/LSP virtual-code layer (virtual code tree, source mappings, the
  multiplexer, syntax highlighting).

When a spec and the code disagree, the spec is the target: do a full structural
revision toward it rather than patching the old shape alongside the new. The
architecture is interconnected — read the whole relevant spec before starting,
not one section.

## How to Work on Loom

### Practice pure FP with Effect

Loom is pure functional programming with Effect, end to end. Model every
concern as a idiomatic Effect program aspect with Services and Layers when needed; compose via `Effect.gen` and `yield*`; let Layers wire dependencies.

- Start every process from an Effect runtime entry point —
  `NodeRuntime.runMain()` or `Effect.runFork()` — and let Effect drive. Do not
  start with imperative Node code and sprinkle Effect inside, and do not call
  `Effect.runSync` / `Effect.runPromise` in the middle of an imperative flow.
- Use `Effect.Service`, never `Context.Tag`, for Loom components.
  `Effect.Service` provides the `.Default` Layer, typed DI via `yield*`, and the
  `dependencies` field — no substitute provides all three. If `Effect.Service`
  feels hard, learn how it works; do not replace it with a plain object, a bare
  class, or a `Context.Tag` because it seems simpler. "This is too complex, let
  me use something simpler" is the signal to study `Effect.Service`, not to
  abandon it.
- No ad-hoc string pipelines pretending to be composition, and no imperative
  orchestration running alongside Effect. Learn style from exisiting code base.

### Build top-down from the entry point

Every process begins at `NodeRuntime.runMain()`. Build the program entry point →
Services → Layers → composition. Do not start from utility functions and hope
they compose later.

### Keep the two planes separate

The frame is *de dicto* — the composition program (the generated Services,
`compose()` / `tangle()` calls, Warp wiring). The product is *de re* — the code
the author wrote in a section's body, carried as that section's `code` field.
When product code happens to be TypeScript it looks like frame code; it is not.
Never splice product code into the frame as raw TS — in the frame a section
appears as a reference to another section's composed code, not inline source.
`compose()` orders section code and `tangle()` emits files. (Full treatment in
`how-lsp.md` → The Two Planes.)

### Do not strip working functionality

Never remove working behavior without explicit instruction — embedded language
resolution, syntax highlighting, frame projection, source mappings, or
language-service dispatch. Read the existing implementation before modifying it.
If a change breaks something that worked before, the change is wrong: revert and
understand why before proceeding.
