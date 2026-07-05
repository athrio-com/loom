# Loom — System Specification

## What Loom Is

Loom is a literate programming framework written in Effect-TS. A `.loom` file
contains prose and code sections in narrative (document) order; the composition
layer reorders and assembles them into real source files on disk. Loom is
language-agnostic — a chapter declares its language in its `Language:`
frontmatter, and individual sections may switch language with a specifier
(`{Bash}`, `{json}`). Loom is written in Effect-TS, but as a tool it composes
any language.

Loom is not a templating engine but a composition system, and code is its
product. Within a chapter a section draws in another by a `::[…]` anchor; the
product pass resolves those anchors into one composed whole, and a `{Tangle}`
section binds it to the file path that `tangle` writes. Loom is itself written
in Effect, but that machinery never appears in the output unless the author
wrote Effect in a section — the composition leaves no trace in what it produces.

Loom is a Volar extended language: code sections are first-class embedded code
with their own language services, diagnostics, and highlighting. This is
foundational and must not be degraded.

## The specification is the book

Loom is literate, so it keeps no specification apart from the book. `corpus/book.loom`
and its chapters are the source of truth: each section's prose sits beside the code it
describes, so the two cannot drift. Before changing a layer, read its chapter — the
shape of a loom (the AST), reading the text (the parser), the product, tangling, the
editor, languages as packages — and treat that prose as authoritative. This file is not
the specification; it holds the vision above and the working directives below, and does
not restate the chapters.

The architecture is interconnected, so read the whole part for a layer, not one section,
before starting. When the prose and the code disagree, the prose is the target: revise
the code toward it rather than patch the old shape alongside the new.

## How to Work on Loom

### Author in Loom — never hand-write source

Loom is written in Loom. Every package — `@athrio/loom-ast` and `@athrio/loom-lang`
(the AST and the composition language), the config package, each
`@athrio/loom-service-*`, the CLI, and in time the language-server itself — is
authored as a `.loom` corpus and tangled to source. Never hand-write `.ts` (or any target-language) files, and never edit the
tangled output: it is a generated artifact. To change emitted code, find the
section that produced it, edit its prose/`=>` chunk, and re-tangle. Catching
yourself editing a `.ts` means you opened the wrong file. New work begins as a
corpus from the first line.

A literate framework that is not itself literate cannot be trusted to compose
anyone else's code — this is consistency, not ceremony. Commit the tangled output
so a checkout builds without re-tangling. And because the CLI is itself tangled
from a corpus, the tangler of record is the *published* `loom` CLI — the stable,
released product — not the in-progress source. A published binary is known-good;
running the source tangler over the corpus that produces it is the circular,
unstable case (change `LoomTangler`, then tangle `Tangler.loom` with that same
unverified change, and the build stands on itself). So the cycle is: tangle with
the published CLI, verify, publish — and the new release is the trusted tool that
builds the next. The same applies to any package: tangle it with the published
CLI, not by self-tangling from source.

### Write loom prose for the reader

A loom's prose is not commentary on the code — it *is* the literate layer, and its
reader is a person. That was Knuth's whole premise: "Instead of imagining that our
main task is to instruct a computer what to do, let us concentrate rather on
explaining to human beings what we want a computer to do," treating a program as
"a work of literature" (Knuth, *Literate Programming*, The Computer Journal 27(2),
1984). Write each section's prose to explain what it is and why it exists, in the
order best for human understanding — not to narrate the mechanics of assembly.

The standard is the **`prose` skill** (`.claude/skills/prose/SKILL.md`) — rules
(put the actor in the subject and the action in the verb; old before new; unstack
the nouns; ground every abstraction; omit needless words; define what you name;
prefer natural language), a checklist, and worked examples. A hook surfaces it the
moment you open a `.loom`, so you write within it and check against it before
presenting; `/prose` runs the same pass on demand. The prose is part of the
product: tangle discards it, but the next person to open the loom depends on it.

### Practice pure FP with Effect

Loom is pure functional programming with Effect, end to end. Model every
concern as a idiomatic Effect program aspect with Services and Layers when needed; compose via `Effect.gen` and `yield*`; let Layers wire dependencies.

- Start every process from an Effect runtime edge — `BunRuntime.runMain()` or
  `Effect.runFork()`, or a startup `ManagedRuntime` for a host-embedded server
  like `LoomServer` — and let Effect drive. Do not start with imperative Node
  code and sprinkle Effect inside, and do not call `Effect.runSync` /
  `Effect.runPromise` in the middle of an imperative flow.
- Use `Context.Service`, never `Context.Tag`, for Loom components. A component is
  `class X extends Context.Service<X>()("X", { make })` — one `make:` Effect
  (`Effect.succeed({…})` when pure, `Effect.gen` when it needs dependencies) —
  paired with an explicit `static readonly layer = Layer.effect(this, this.make)`,
  adding `.pipe(Layer.provide(Dep.layer))` per dependency. It gives a named tag
  and typed DI via `yield*`; no plain object or `Context.Tag` gives that with a
  Layer. `Context.Service` is Effect v4's successor to v3's `Effect.Service` —
  the `.Default` layer and the `dependencies:` field are gone, so you write the
  layer yourself. If it feels hard, learn how it works; do not replace it with a
  plain object, a bare class, or a `Context.Tag` because it seems simpler. "This
  is too complex, let me use something simpler" is the signal to study
  `Context.Service`, not to abandon it.
- No ad-hoc string pipelines pretending to be composition, and no imperative
  orchestration running alongside Effect. Learn style from exisiting code base.

### Build top-down from the entry point

Every process begins at a runtime edge — `BunRuntime.runMain()` for the CLI, a
startup `ManagedRuntime` for the language server. Build the program entry point →
Services → Layers → composition. Do not start from utility functions and hope
they compose later.

### Compose by anchor, not by inlining

A loom weaves three layers into one file: the **Loom syntax** that composes the
document — the headings, the `::[…]` anchors, the `{Tangle}` sinks — the **prose** a
person reads, and the **code** each section is written in, in that section's own
language. The layers stay distinct. A section draws in another by naming it with a
`::[…]` anchor, never by pasting its code inline; the product pass resolves the anchor
and composes the two. When a section's code happens to be TypeScript it can look like
Loom's own composition, but it is product, not composition — treat it as opaque text in
its section's language, and compose it only by reference.

### Do not strip working functionality

Never remove working behavior without explicit instruction — embedded language
resolution, syntax highlighting, the product projection, source mappings, or
language-service dispatch. Read the existing implementation before modifying it.
If a change breaks something that worked before, the change is wrong: revert and
understand why before proceeding.
