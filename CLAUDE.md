# Loom — System Specification

## INSTRUCTION FOR AGENTS

This specification describes the target architecture. The current codebase may not conform to it. When asked to implement changes based on this spec, **do a full structural revision**, not cosmetic edits. Specifically:

1. **Read this entire spec first.** Do not start coding after reading one section. The architecture is interconnected — the two-plane model, the Service structure, the core types, the virtual code tree, and the runtime entry points all depend on each other.

2. **Do not patch the old architecture.** If the current code uses ad-hoc string manipulation, imperative orchestration, or `Context.Tag` instead of `Effect.Service`, do not add the new model alongside the old one. Replace the old model. The spec is the source of truth.

3. **Start from entry points.** Every process begins from `NodeRuntime.runMain()`. Build the Effect program top-down: entry point → Services → Layers → composition. Do not start from utility functions and hope they compose later.

4. **Verify the two planes.** After any change, check: does the frame contain only de dicto code (Service definition, compose(), needs())? Does product code (section content) stay in tangled virtual docs or embedded codes? If product code appears in the frame as raw TS, the planes are conflated — fix it.

5. **Verify types.** Sections must be `Effect<Code>` or `Template<P>`. Tangles must be `Effect<Tangle>`. compose() must accept `string | Effect<Code>`. If anything is typed as raw `string` where `Code` is expected, fix it.

6. **Do not strip working functionality.** Read existing code before modifying. If syntax highlighting, embedded language resolution, or source mappings were working, they must still work after your changes. If they break, revert and understand why before proceeding.

7. **Do not simplify away Effect.Service.** The frame must use `Effect.Service`, not a "simpler TS-acceptable structure." If `Effect.Service` class extension is difficult, learn how it works — do not replace it with a plain object, a `Context.Tag`, or an ad-hoc class. The spec requires `Effect.Service` because it provides `.Default` Layer, typed DI via `yield*`, and the `dependencies` field. No substitute provides all three. If the agent finds itself saying "this is too complex, let me use something simpler," that is the signal to study Effect.Service, not to abandon it.

## What Loom Is

Loom is a literate programming system. A `.loom` file contains prose and code sections in narrative (document) order. The composition layer reorders and assembles them into real source files on disk. Loom supports any language — the title H-function declares which (e.g. `[Typescript]`, `[Python]`, `[Rust]`). Loom itself is written in Effect-TS, but it is language-agnostic as a tool.

Loom is not a templating engine. It is a monadic composition system where Effect is the internal machinery and Code is the product.

## CRITICAL: Loom Is a Volar Extended Language

Loom is a Volar extended language where embedded code sections are first-class citizens. This is foundational and must not be degraded.

**How it works:**

- The title H-function's language marker (e.g. `# HelloHono [Typescript]`) defines the **default language** across the entire document.
- Prose and code are distinguished by **indentation and special reserved markers**. Code blocks are indented. Prose is not.
- Code sections are **embedded language regions** — Volar natively understands this. Each code block is an embedded virtual code with its own `languageId`, resolved by Volar's embedded language infrastructure.
- Individual code blocks can switch language with markers (e.g. `[json]`, `[sql]`). The default language from the title applies to unmarked blocks.
- Volar provides the full pipeline: TS language service for the frame, embedded language services for each code section, token mapping, diagnostics mapping — all native to Volar's architecture.

**Do not reimplement what Volar provides natively.** Volar already has the concept of embedded languages, virtual codes, and language-specific service dispatch. Loom's job is to declare the virtual code tree correctly. Volar handles the rest.

## CRITICAL: Do Not Strip Working Functionality

When refactoring or extending Loom, **never remove existing working behavior** without explicit instruction. If code was working before a change and stops working after, the change is wrong — revert it. This applies especially to:

- Embedded language resolution (Volar's native embedded code support)
- Syntax highlighting for code sections
- Frame projection and source mappings
- Language service dispatch for code sections

Before modifying any LSP/Volar integration code, **read the existing implementation first** and understand what it does. If you don't understand why something exists, ask — don't delete it.

## CRITICAL: Loom Runtime Must Be Effect-Native

The frame virtual code example is not a spec fiction — it is what the Loom runtime actually executes. The runtime IS an Effect program that runs `Effect.Service` definitions from beginning to end: resolve dependencies via Layers, `yield*` sections as Kleisli arrows, run `compose()` to produce Code, run Tangle members to emit files.

This must be pure Effectful FP. No compromises. No ad-hoc imperative orchestration alongside Effect. No string manipulation pretending to be monadic composition. If the runtime does not execute the model shown in the frame, the model is a mock and a lie.

The runtime pipeline:

```
Parse .loom → build Effect.Service definition → provide Layers → run Effect program
  → sections resolve as Effect<Code>
  → compose() concatenates Code in order
  → Tangle members emit files
  → end of the world: pure text on disk
```

Every step is Effect. Every composition is a Kleisli arrow. Every dependency is a Layer. The output is pure text. The mechanism is invisible.

### How to achieve this

Everything starts from an Effect Runtime entry point. Every server, CLI tool, and plugin must begin as an Effect program using `NodeRuntime.runMain()` or equivalent. Effect drives the process — not imperative code that calls Effect occasionally.

**Entry points:**

- **Tangle CLI** (`pnpm tsx tangle.ts`) — an Effect program. `NodeRuntime.runMain(Effect.gen(function* () { ... }))`. Parses .loom, builds Service, provides Layers, runs Tangles, writes files. All Effect.
- **Volar LSP server** — an Effect Platform application. The server starts as an Effect program. Parsing, frame projection, virtual code assembly, diagnostics — all Effect services composed via Layers.
- **Vite plugin** (if applicable) — Effect-native. The plugin's transform/build hooks are Effect programs.

**Architecture:**

```
NodeRuntime.runMain(                         ← end of the world
  Effect.gen(function* () {
    const doc = yield* LoomParser.parse(source)    ← Service
    const service = yield* LoomCompiler.build(doc)  ← Service
    yield* service.PackageJson                      ← Tangle member
    yield* service.IndexTs                          ← Tangle member
  }).pipe(
    Effect.provide(LoomParserLive),            ← Layer
    Effect.provide(LoomCompilerLive),          ← Layer
    Effect.provide(FileSystemLive),            ← Layer
  )
)
```

**Do not:**
- Start with imperative Node code and sprinkle Effect inside
- Use `Effect.runSync` or `Effect.runPromise` in the middle of imperative flows
- Build ad-hoc string pipelines outside Effect and feed results back in
- Treat Effect as a utility library rather than the program model

**Do:**
- Start from `NodeRuntime.runMain()` or `Effect.runFork()`
- Model every concern as a Service with a Layer
- Compose via `Effect.gen` and `yield*`
- Let Layer handle all dependency wiring
- Use `Effect.Service` for every Loom component (parser, compiler, file system, LSP)

## Vision: Loom as a Language Extension

Loom can be formalized as a language extension on top of TS+Effect — similar to how TSX extends TS with JSX syntax. The Volar plugin resolves Loom-specific constructs (`{{transclusion}}`, heading brackets, reserved H-functions) and delegates pure TS to the language service. This would eliminate the two-world problem: you write Loom, which IS TS with a few extra constructs. Full activation everywhere, no frame gymnastics. This is a vision for the future, not the current implementation.

## Core Composition Model

Loom uses Effect internally as Kleisli arrows producing Code. Each section is a computation `Effect<Code>` — a monadic arrow that, when run, yields a pure code string. Sections with parameters are functions `Params → Effect<Code>`. The `compose()` function orders sections. The `Tangle()` function binds composed Code to a file path. At the end of the world, the Effect program resolves to pure text — the output file content.

```
Section            =  Effect<Code>              a Kleisli arrow producing data
Section(params)    =  Params → Effect<Code>     a parameterized arrow
compose(A, B, C)   =  Effect<Code>              ordered concatenation of data
Tangle             =  Effect<Tangle>            effectful computation that emits a file
Output file        =  string                    pure text, end of the world
```

Code is a typed entity (Effect `Data.TaggedClass`), not a raw string. It carries the author's literal code and supports typed operations. It is data — the product.

Tangle is an effectful computation, not data. When run at the end of the world, it composes sections and emits a file. Sections produce Code (data). Tangles produce effects that emit Code to files (computation).

```
Code    = data        (literal text, the product)
Tangle  = computation (effectful emission, produces files when run)
```

The mechanism (Effect, Kleisli composition, Layers, Services) never appears in the product (output files) unless the author wrote Effect code in their sections. Loom's runtime is invisible. The output is always literal code as the author wrote it, concatenated in the order the Tangle specified.

### Core Types and Functions

```ts
// Code — data. The literal text of a section.
// Typed entity, not a raw string. Supports typed operations.
// Resolves to pure text when emitted.
class Code extends Data.TaggedClass("Code")<{
  readonly content: string
}> {}

// Template — parameterized computation. A function that takes typed params
// and produces Code after interpolation. Distinct from compose().
// Each parameterized section becomes a Template Service member.
class Template<P extends Record<string, any>> extends Data.TaggedClass("Template")<{
  readonly params: P
  readonly apply: (params: P) => Effect.Effect<Code>
}> {}

// Tangle — effectful computation. When run, composes sections and emits a file.
// Carries the emission path and the composed Code.
// At the end of the world, produces the output file.
class Tangle extends Data.TaggedClass("Tangle")<{
  readonly tag: string                        // Service member name
  readonly path: string                       // emission target
  readonly code: Code                         // composed result
}> {}

// compose: the universal composition function.
// Accepts any mix of literal strings and Effect<Code> references.
// Strings are wrapped in Code. References are yield*'d.
// All arguments are concatenated in order, producing Effect<Code>.
//
// compose("literal")                     → Effect.succeed(new Code({ content: "literal" }))
// compose(this.Imports)                  → yield* this.Imports
// compose(this.Imports, "\nconst x = 1") → yield* this.Imports, concat with literal
// compose(App, Greet, Health, Boot)      → yield* each, concat in order
//
// The mapper always emits compose(). Never Effect.succeed, never Effect.gen directly.
type ComposeFunction = (
  ...parts: ReadonlyArray<string | Effect.Effect<Code>>
) => Effect.Effect<Code>

// needs: extracts .Default Layers from Service references
type NeedsFunction = (
  ...services: ReadonlyArray<Effect.Service.Any>
) => ReadonlyArray<Layer.Layer.Any>
```

`compose()` and `needs()` are real TS functions from `@literate/core`. Not sugar. Not mapped. Full LSP activation.

### Parameter syntax vs transclusion syntax

Two distinct `{{}}` forms exist. They must not be confused:

```
{{name: string}}          → parameter declaration (typed, hoisted)
{{Tag}}                   → transclusion by tag name
{{Header name}}           → transclusion by heading title
```

Disambiguation: if the content contains `:` with a valid type after it, it's a parameter. Otherwise it's a transclusion reference. **Heading titles with colons are not supported** to avoid ambiguity.

Parameters have no default values. Just `{{name: type}}`. The parameter name is hoisted as a key in the Template's typed params record.

### Parameterized sections map to Template

A section with `{{param: type}}` declarations becomes a `Template` Service member — a function that takes typed params and produces Code:

```
# Greeting [Greet]

  console.log("Hello {{name: string}}, you are {{age: number}}")
```

Maps to:

```ts
readonly Greet: Template<{ name: string; age: number }> = Template.make(
  ({ name, age }) => compose(`console.log("Hello ${name}, you are ${age}")`)
)
```

Consumers call Templates with params to get Code:

```
# Tangle [IndexTs, src/index.ts]

  compose(
    this.Greet.apply({ name: "World", age: 42 }),
    this.Boot
  )
```

Templates are Functions. Sections without parameters are Code. Both are Service members. The type distinction enforces correct usage — you cannot pass a Template where Code is expected without calling it with params first.

## The Two Planes — de dicto and de re

The Loom system operates on two distinct planes. These must never be mixed.

### De dicto — the frame

This is Loom's compositional mechanism. It contains `Effect.Service` definitions, `compose()` calls, `Tangle()` calls, `needs()` calls, `yield*` sequences, `import` statements for Loom dependencies. This is TS code that describes HOW code is composed. It lives in the Loom machinery. The TS language service checks it for correctness of the composition program.

### De re — the product code

This is the actual code the author writes in sections. `const app = new Hono()`, a JSON package manifest, a SQL query. This code IS the thing being composed. It may be TypeScript, JSON, SQL, or any language declared by a code block marker. It is content flowing through the Kleisli arrows, carried as typed Code values.

### The conflation to avoid

When product code happens to be TypeScript, it looks the same as frame code. Never splice product TS directly into the frame as raw TS. Product TS and frame TS are not the same thing. One describes composition. The other is being composed.

### CRITICAL: Not all indented code is product code

Both content sections and reserved sections contain indented code in the `.loom` file. They look the same syntactically. But they map to completely different planes. **The Host H-function type determines which plane:**

```
# Title [Tag]                      → content section → EMBEDDED code (de re)
# Tangle [Tag, path]               → FRAME code (de dicto)
# This Loom [Dependencies]         → FRAME code (de dicto)
# Free [Loom]                      → FRAME code (de dicto)
```

Content section code is product code — the thing being composed. It flows through Kleisli arrows as Code values.

Tangle/Dependencies/Free section code is frame code — composition machinery. It contains `compose()`, `yield*`, `Tangle()`, `needs()` calls. This code IS the frame. It maps directly to the `Effect.gen` body or `dependencies` field of the Service definition.

**Tangle is the exception.** Most indented code is embedded product code. Tangle bodies are not. They are the composition program. An agent that treats all indented code the same will conflate the planes.

### How the planes map to virtual codes

```
Frame (de dicto)                    Product code (de re)
─────────────────                   ────────────────────
Effect.Service definition           const app = new Hono()    ← TS section
compose(App, Greet, Boot)           { "name": "my-app" }     ← JSON section
needs(ConfigLoom)                   SELECT * FROM users       ← SQL section
yield* ConfigLoom                   app.get("/hello", ...)    ← TS section
readonly IndexTs: Effect<Tangle>

languageId: "typescript"            languageId: per-block
maps to Service definition          carried as typed Code values
TS language service checks this     content of Kleisli arrows
```

Product TS sections are embedded code, not frame code. Even though they are TypeScript, they are content being composed, not the composition itself. They appear in the frame as Code-typed references — `App`, `Greet`, `Boot` — not as spliced raw TS.

**Test:** if you see `const app = new Hono()` inside the frame alongside `compose(App, Greet)`, the planes are conflated. `App` should be a Code reference in the frame. `const app = new Hono()` should be in its section, carried as Code.

## Sections

Sections are the raw material. They contain prose and code in narrative order. They have no knowledge of where they will be emitted.

Every section — tagged or untagged — produces its code literally. A tag is a name for reference purposes. Tags do not create isolation boundaries. Tags do not wrap code in functions. Tags do not change what code is. Tagged and untagged sections referenced in the same Tangle share scope in the output.

Sections never carry emission opinions. No tangle path in heading brackets. No section decides where it ends up. The heading bracket on content sections serves exactly one purpose: naming a tagged chunk.

### Inline Interpolation (Transclusion)

Inside a code block, `{{reference}}` transcluces another section's code inline. The reference resolves by heading title or tag name — the resolver tries both:

```
{{Import as needed}}       → resolves by heading title
{{Imports}}                → resolves by tag name
```

Transclusion is effectful — resolved at the end of the world via `compose()`. A section that uses `{{SomeOther}}` maps to `compose(this.SomeOther, ...)` where the reference is `yield*`'d inside compose, resolving the dependency through the Kleisli arrow.

## Heading Bracket Grammar

```
# ServiceName [Language]       → title H-function (Service name + language)
# Title                        → untagged section
# Title [Tag]                  → tagged section (named chunk)
# Tangle [Tag, path]           → reserved H-function: emission target (tag + path)
# This Loom [Dependencies]     → reserved tag: Layer declaration
# Free [Loom]                  → reserved H-function: power-user override
```

Tangle brackets are mandatory `[Tag, path]` — the tag becomes a Service member name (valid TS identifier), the path is the emission target.

### Non-TS syntax categories

TS is the default and native language inside section bodies. Non-TS syntax appears only in deliberate Loom-specific forms:

- **Directives** — structural markers on headings and code blocks (heading bracket tags, language switches on code blocks).
- **Inline references** — interpolation markers `{{Section Title}}` or `{{Tag}}` inside code blocks that reference other sections by heading name or tag name. The resolver tries both.
- **Reserved H-functions** — headings where the heading text itself is the reserved name: `Tangle`, `Free`. The bracket contains arguments (`[Tag, path]` for Tangle, `[Loom]` for Free). The title H-function bracket `[Language]` declares the stack language. These cannot be arbitrary names.
- **Reserved tags** — heading brackets with fixed names for declaration: `[Dependencies]`. These cannot be arbitrary.
- **Tags** — heading brackets with arbitrary H-names chosen by the author, for naming content sections. These are just names for reference.

These are recognized and resolved by the parser before the frame reaches the LSP. Everything else inside a section body is valid TS with full LSP activation.

## Title H-Function

The first heading of a Loom file declares the Service name and the language:

```
# HelloHono [Typescript]
```

The heading text is the generated Effect Service name (must be a valid TS identifier). The bracket is the language declaration. This replaces any separate Stack directive.

## Loom Services

Each Loom file generates one Effect Service. Loom Services must use `Effect.Service`, not `Context.Tag`.

`Context.Tag` creates a hollow DI tag with no implementation. Loom Services are real services with implementation, a `.Default` Layer, and DI access.

```ts
class HelloHono extends Effect.Service<HelloHono>()("HelloHono", {
  effect: Effect.gen(function* () {
    // composition implementation
  }),
  dependencies: needs(ConfigLoom, AuthLoom)
}) {}
```

`Effect.Service` is available in Effect v3.x (current stable). It natively accepts a `dependencies` array for Layer provision. This is what the `needs()` function maps to.

The Service is exported by default. Standard TS import tracing works:

```ts
import { HelloHono } from "./hello.loom"
const { PackageJson, SectionA } = yield* HelloHono
```

Sections are H-functions inside the Service — properties of it, not standalone exports. Consumers access them through standard Effect DI. There is no separate Export section. The Service is the only export.

## Reserved Sections

### Tangle — `# Tangle [Tag, path]`, reserved H-function

Each Tangle section produces exactly one output file. A Loom file may have zero to many Tangle sections. Tangle sections are the only emission authority. Nothing is emitted unless a Tangle section says so.

The bracket is mandatory `[Tag, path]` — the tag is a valid TS identifier that becomes a readonly Service member of type `Effect<Tangle>`. The path is the emission target.

The body is valid TS. It is **frame code (de dicto)**, not embedded product code. It maps directly to the member's `Effect.gen` body — the effectful computation that composes sections and emits the file. The computation IS the member.

```
# Tangle [IndexTs, temp/hono/src/index.ts]

And finally, we can tangle the app file.

  compose(App, Greet, Health, Boot)
```

When a Tangle needs sections from another Loom:

```
# Tangle [PackageJson, temp/hono/package.json]

Now we can tangle the package.json file.

  const { PackageJson } = yield* ConfigLoom
  compose(PackageJson)
```

`compose()` is a real TS function. It takes section references (Code values) and orders their literal code in argument order. Full LSP activation.

### Dependencies — `# This Loom [Dependencies]`, reserved tag

Declares what this Loom file's Service depends on. Maps to the `dependencies` field in the generated `Effect.Service` definition. Body is **frame code (de dicto)**.

```
# This Loom [Dependencies]

We should always import the needed dependencies.

  import { ConfigLoom } from "./Configs"
  needs(ConfigLoom)
```

`needs()` is a real TS function. It takes Service references and returns their `.Default` Layers as an array. The consumer never writes `.Default`.

The imports are real TS — LSP traces module resolution, go-to-definition works.

### Free — `# Free [Loom]`, reserved H-function

`[Loom]` as the bracket marker — because Free IS the Loom. The heading says what it does, the bracket says what it is. `[Loom]` may only appear once per file and overrides everything. Errors if any Tangle or Dependencies sections are present.

When Free is present, Loom still parses all content sections and makes their code available. But the author writes the full composition program — the Effect Service, Layer provision, tangle logic. The author IS the Loom.

Free receives the same DSL primitives (`compose()`, `needs()`) that the other reserved sections use, plus direct access to the Tangle type for constructing effectful emissions. The author composes them with full Effect power — conditionals, loops, dynamic paths.

Free is not wrapped in Gen. The author writes the full Effect Service themselves.

Free must produce a Service of the same shape that sugar mode generates. Same contract, different authorship. Shape mismatch is a compile error. This keeps Free composable — consumers of a Loom file don't know or care whether it was authored with sugar or Free.

## No Default Emission

There is no default emission. No implicit single-file output. Zero Tangle sections means zero output files. A Loom file without Tangle sections is either a library (consumed via its Service) or inert documentation.

## Tangle Entry References

Tangle entries reference sections in several ways:

```
SectionA                → by tag name
Greeting handler        → by heading name (tagged or untagged)
Section[1]              → by document-order index (1-based)
Section[2-10]           → by index range
SectionB("info")        → by tag with interpolation arguments
```

These are passed as arguments to the `compose()` function inside Tangle bodies.

## Progressive Disclosure

```
Sugar sections          →  LP authors write declarative composition
  (# Tangle, # Dependencies)

DSL functions           →  Free authors get the same primitives directly
  (compose(), needs(), Tangle type)  with full Effect composition power

Effect runtime          →  Internal Kleisli machinery
                            producing Code (data) and Tangle (computation)

Code output             →  Pure text. End of the world.
                            Tangle computations emit files.
```

Each layer compiles down to the one below. The bottom layer is always pure code text.

## LSP Virtual Document Assembly

Loom is a Volar extended language. Volar natively handles the virtual code tree, embedded language dispatch, and source mapping. Loom's job is to declare the tree correctly. Do not reimplement Volar's native behavior.

### The pipeline: Tangles drive type resolution

Type checking and semantic analysis work through tangled virtual documents. The pipeline:

```
Parse .loom
  │
  ▼
Find Tangle sections
  │
  ▼
For each Tangle:
  Compose sections in tangle-specified order
  Produce virtual TS document (literal code, correct compilation order)
  │
  ▼
Feed tangled virtual documents to TS language service
  → type checking, error diagnostics, semantic tokens
  │
  ▼
Map diagnostics and tokens back to .loom source positions
  via bidirectional source mappings
```

Without Tangles, there is no virtual TS document for the language service to check. No type resolution, no error diagnostics, no semantic tokens from tsc. **Without Tangles, you get only syntax highlighting** from Tree-sitter grammars — keywords, strings, numbers, operators. No types, no errors.

This is by design. Tangles define the compositional order. Without that order, there is no valid TS program to check. A Loom file with no Tangles is a library or documentation — its sections are consumed by other Looms that DO have Tangles.

### Virtual code tree structure

The tree has three kinds of children. They must never be conflated.

```
root (languageId: "loom")
├── frame        (languageId: "typescript")   ← de dicto: the composition program
├── tangled-0    (languageId: "typescript")   ← de re: resolved product for Tangle [IndexTs, src/index.ts]
├── tangled-1    (languageId: "json")         ← de re: resolved product for Tangle [PackageJson, package.json]
└── untangled-0  (languageId: "typescript")   ← untangled section, sy-hi only
```

**Frame** — the single TS virtual code for the composition program. Contains Service member declarations (`readonly App: Effect<Code>`, `readonly IndexTs: Effect<Tangle>`), Tangle member bodies (`compose(App, Greet)`), Dependencies code (`import { ConfigLoom } ...`, `needs(ConfigLoom)`). tsc checks this for composition correctness. Tags get hover, go-to-definition, type info. Tangled virtual codes must never contain frame code.

**Tangled** — one per Tangle section. Contains resolved product code only (de re). Source mappings trace back to the `.loom` lines where each section's code lives. tsc provides semantic tokens and diagnostics on the product code.

**Untangled** — sections NOT in any Tangle. Get Tree-sitter syntax highlighting only. No type checking, no semantic tokens from tsc.

```
Frame:               tsc checks composition program → tag hover, compose/needs type errors
Tangled sections:    tangled virtual doc → tsc → semantic tokens + diagnostics → mapped back to .loom
Untangled sections:  Tree-sitter → syntax tokens only
```

The title H-function's language marker determines the default `languageId` for unmarked code blocks. Code blocks with explicit language markers (`[json]`, `[sql]`) override to their respective language.

### Source mappings

Each virtual code has bidirectional source mappings back to the `.loom` file. When the TS language service reports a diagnostic or provides hover/go-to-definition, Volar maps the position back to the exact location in the `.loom` source. This is Volar's core competency.

### LSP annotation mapping back to .loom

There are two categories of LSP annotations in a `.loom` file. Each maps through a different virtual code.

**Frame annotations (de dicto)** — mapped through the frame virtual code:

```
# HonoHello ←(1) [Typescript] ←(2)     Service name, stack declaration
# Greeting handler [Greet] ←(3)        Tag name: hover shows Effect<Code> type
  {{Import as needed}} ←(4)            Transclusion: go-to-definition → Imports section
# Tangle [PackageJson, ...] ←(5)       Tangle bracket: tag + path metadata
  const { PackageJson } = yield* ConfigLoom ←(6)   Tangle body: frame code
  compose(App, Greet, Health, Boot) ←(7)            Tangle body: frame code
# This Loom [Dependencies] ←(8)        Reserved tag
  import { ConfigLoom } from "./Configs" ←(9)       Dependencies body: frame code
  needs(ConfigLoom) ←(9)                             Dependencies body: frame code
```

These positions map into the frame's `Effect.Service` class definition. Hover on `HonoHello` (1) shows the Service type. Hover on `[Greet]` (3) shows `readonly Greet: Effect<Code>`. Go-to-definition on `App` in compose (7) jumps to the App section. Type errors in `needs()` (9) or `compose()` (7) show at these positions.

**Embedded code annotations (de re)** — mapped through tangled virtual docs:

```
  app.get("/hello/:name?", (c) => { ←(a)    Product code: type-checked via tangle
    const name = c.req.param("name") ?? "World"
    ...
  })

  const app = new Hono() ←(b)               Product code: type-checked via tangle
```

These positions map into the tangled virtual document where sections are concatenated in tangle order. Hover on `app` (b) shows its type from the tangled context. If `app` is used before definition in document order but after in tangle order, no error — the tangle order is what tsc sees. Type errors like "Cannot find name 'app'" map back to the exact line in the `.loom` section.

**How Volar routes annotations:**

```
.loom source position
  │
  ├─ falls within heading bracket or Tangle/Dependencies code block
  │    → frame virtual code → TS language service → frame annotations
  │
  └─ falls within content section code block
       ├─ section is in a Tangle → tangled virtual doc → TS language service → embedded annotations
       └─ section is untangled → Tree-sitter → syntax tokens only (no type info)
```

Every annotation in the `.loom` file traces through exactly one virtual code. Frame and embedded annotations never mix. The position in the `.loom` source determines which virtual code Volar consults.

### Multiplexer

The LSP multiplexer (`src/multiplexer.ts`) dispatches requests to external language servers for languages that Volar doesn't handle (Go, Rust, Python, etc.). It handles hover, completion, and go-to-definition for these languages. The multiplexer does not intercept `textDocument/semanticTokens` — those flow through Volar's plugin pipeline.

Volar handles its known languages natively. The multiplexer extends this to external language servers that Volar doesn't know about. They are complementary, not competing.

### Syntax Highlighting

Two token sources, dispatched by Volar depending on what's available:

1. **TS language service** (via tangled virtual documents) — type-aware semantic tokens: variables, functions, types, interfaces. Only available for sections included in Tangles. Tokens are in tangled document positions, mapped back to .loom source by Volar.

2. **Tree-sitter syntax token plugin** — parses code sections with the appropriate grammar. Produces tokens for keywords, strings, numbers, operators, punctuation. Works for all code sections, including untangled ones. Each language needs its own grammar loaded.

```
Tangled sections:    tsc semantic tokens (types, errors) via tangled virtual doc
Untangled sections:  Tree-sitter syntax tokens only
No Tangles at all:   Tree-sitter syntax tokens only for everything
```

If the Tree-sitter runtime doesn't have a grammar for a language, those code sections get zero syntax tokens — this is a missing grammar problem, not a Loom architecture problem.

## Compile-Time Constraints

- Free present with any Tangle or Dependencies → error.
- Tangle entry references nonexistent section → error.
- Tagged section with params referenced without args → error.
- Section has code but nothing references it → warning.
- Multiple Dependencies sections → error.
- Multiple Free sections → error.
- Tangle bracket missing tag or path → error.

## Runtime Dispatch

Loom runtime checks Free first. If Free is present, it short-circuits — generates section code accessors only, passes the Free block as the module body. No further composition logic.

If Free is absent, Loom collects all Tangle sections, resolves their entries to literal Code, assembles virtual documents in entry order, validates constraints, and passes the virtual document set to the LSP.

Free short-circuits. One check, one branch. The runtime does not attempt to merge Free with Tangles — that is a compile error.

## Example Loom File

```
# HonoHello [Typescript]

# Hono Hello World

This Loom demonstrates composite file generation. A minimal
Hono web server is split across narrative sections, then
reassembled by Tangle into runnable files under `temp/hono/`.

Tags are just names — they give Tangle a way to reference
sections. Tagged and untagged sections produce identical
literal code. They share scope when concatenated in the
same virtual file.

# Greeting handler [Greet]

A route that greets the caller by name. Falls back to
"World" when no name parameter is supplied.

  app.get("/hello/:name?", (c) => {
    const name = c.req.param("name") ?? "World"
    return c.text("Hello " + name + "!")
  })

# Health check [Health]

A simple health endpoint for probes and smoke tests.

  app.get("/health", (c) => {
    return c.json({ status: "ok" })
  })

# Server boot [Boot]

  export default {
    port: 3000,
    fetch: app.fetch,
  }

# Import as needed [Imports]

  import { Hono } from "hono"

# App instance [App]

  {{Import as needed}}

  const app = new Hono()

# Tangle [PackageJson, temp/hono/package.json]

Now we can tangle the package.json file.

  const { PackageJson } = yield* ConfigLoom
  compose(PackageJson)

# Tangle [IndexTs, temp/hono/src/index.ts]

And finally, we can tangle the app file.

  compose(App, Greet, Health, Boot)

# This Loom [Dependencies]

We should always import the needed dependencies.

  import { ConfigLoom } from "./Configs"
  needs(ConfigLoom)

# How to run this Hello Hono?

pnpm tsx tangle.ts corpus/Loom.loom --base .
cd temp/hono && pnpm install
pnpm start
```

# Frame Virtual Code Assembly (The Heart of Loom)

The frame virtual code is a synthetic TypeScript document generated by `projectLsp`. It gives the TS language service the composition program to check. Without it, tags have no hover, `compose()` calls have no type checking, and `needs()` calls are invisible to tsc.

### What the frame contains

For the HonoHello example, the frame virtual code would be:

```typescript
import { Code, Tangle, compose, needs } from "@literate/core"
import { Effect } from "effect"

// ── Dependencies (from # This Loom [Dependencies]) ─────────────────────

import { ConfigLoom } from "./Configs"

// ── Service definition (from # HonoHello [Typescript]) ─────────────────

class HonoHello extends Effect.Service<HonoHello>()("HonoHello", {
  effect: Effect.gen(function* () {
    // Run all Tangle members — each emits its file
    yield* this.PackageJson
    yield* this.IndexTs
  }),

  dependencies: needs(ConfigLoom)
}) {
  // ── Stack — default language from title H-function ─────────────────
  readonly stack = "Typescript"  // from # HonoHello [Typescript]
  // ── Tagged sections — all use compose() ────────────────────────────
  // compose() handles both literal strings and Effect<Code> references.
  // The mapper always emits compose(). Simple and uniform.

  readonly Imports: Effect.Effect<Code> = compose(
    `import { Hono } from "hono"`
  )

  readonly App: Effect.Effect<Code> = compose(
    this.Imports,                         // {{Import as needed}} → resolved via yield*
    `\n\nconst app = new Hono()`
  )

  readonly Greet: Effect.Effect<Code> = compose(
    `app.get("/hello/:name?", (c) => {`,
    `  const name = c.req.param("name") ?? "World"`,
    `  return c.text("Hello " + name + "!")`,
    `})`
  )

  readonly Health: Effect.Effect<Code> = compose(
    `app.get("/health", (c) => {`,
    `  return c.json({ status: "ok" })`,
    `})`
  )

  readonly Boot: Effect.Effect<Code> = compose(
    `export default {`,
    `  port: 3000,`,
    `  fetch: app.fetch,`,
    `}`
  )

  // ── Untagged sections ──────────────────────────────────────────────

  readonly HonoHelloWorld: Effect.Effect<Code> = compose(``)
  readonly HowToRun: Effect.Effect<Code> = compose(``)

  // ── Tangles — effectful computations that emit files ───────────────
  // Author writes compose() body. Machinery wraps result into Tangle
  // by injecting tag + path from the heading bracket [Tag, path].

  readonly PackageJson: Effect.Effect<Tangle> = Effect.gen(function* () {
    // mapped from # Tangle [PackageJson, temp/hono/package.json]
    const { PackageJson } = yield* ConfigLoom
    const code = yield* compose(PackageJson)
    return new Tangle({ tag: "PackageJson", path: "temp/hono/package.json", code })
  })

  readonly IndexTs: Effect.Effect<Tangle> = Effect.gen(function* () {
    // mapped from # Tangle [IndexTs, temp/hono/src/index.ts]
    const code = yield* compose(this.App, this.Greet, this.Health, this.Boot)
    return new Tangle({ tag: "IndexTs", path: "temp/hono/src/index.ts", code })
  })
}

export { HonoHello }
```

### Rules

1. **Sections as Service members** — each tagged section is a `readonly` property. Sections without parameters are `Effect<Code>` mapped via `compose()`. Sections with `{{param: type}}` declarations are `Template<P>` — functions that take typed params and produce Code. Source-mapped back to the tag span in the heading bracket.
2. **Tangles as Service members** — each Tangle is a `readonly` property of type `Effect<Tangle>`. Named by the mandatory tag in `[Tag, path]`. The member body IS the mapped Tangle section code — the effectful computation that composes and emits.
3. **Service wrapper** — the Service name comes from the title H-function. The whole frame is one `Effect.Service` class. The `readonly stack` field carries the default language from the title bracket.
4. **Tangle body code** is mapped as the member's `Effect.gen` body. The author's `compose()` call is verbatim. The machinery injects `yield*` on compose, and wraps the result in `new Tangle({ tag, path, code })` using metadata from the heading bracket. Tag and path are the only generated code — everything else is author-written.
5. **Service effect runs Tangles** — the Service's `effect` gen yields each Tangle member. Each `yield*` runs the Tangle computation, which emits its file.
6. **Dependencies body code** — imports at module level, `needs()` maps to the `dependencies` field.
7. **Free body** replaces everything — when Free is present, the frame IS the Free block's code.
8. **Tangled virtual codes never contain frame code.** They are strictly de re — resolved product code with their own source mappings.
9. **Untagged sections** without code do not appear in the frame — they are pure prose.
10. **compose() is the universal composition function.** It accepts literal strings and `Effect<Code>` references in any mix. Strings become Code. References are `yield*`'d. All arguments concatenate in order. The mapper always emits `compose()` — never `Effect.succeed`, never `Effect.gen` directly for sections.