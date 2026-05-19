# Loom Parsing Pipeline — Design Conclusions

Settled during the Volar integration study. Documents the full path from
`.loom` source text to VirtualCode tree with mappings.


## Input contract

Volar always provides a full `IScriptSnapshot` — the complete `.loom` file
text on every change. Never a partial patch. The snapshot's `getChangeRange`
method may carry incremental diff info from the editor, but we ignore it: the
pipeline reparses from scratch each time.

```
snapshot.getText(0, snapshot.getLength())  →  full source string
```


## Stage 1 — Line offset table

Instead of splitting the source into separate line strings (which strips
terminators and allocates per line), we scan the full text once to build an
offset table: an array of byte positions where each line begins.

```
const lineStarts = [0]
const eol = /\r?\n|\r/g
let m
while ((m = eol.exec(text)) !== null) {
  lineStarts.push(m.index + m[0].length)
}
```

Result: `lineStarts = [0, 15, 32, 58, ...]`. Line N's content is
`text.slice(lineStarts[n], lineStarts[n+1])`. The original string stays
intact — no copies, no stripping. Every offset is directly usable as
`sourceOffsets` in Volar mappings.


## Stage 2 — Tokenisation (line → Weft recognition)

Each line is classified by its leading pattern. Recognition is line-oriented:

- `## ` at column 1 → heading (check for `[Tag]` and `{Specifier}` within)
- `=>` at column 1 (with optional indent) → arrow
- `~` at column 1 → tilde fence open/close
- `---` exactly → separator
- anything else → plain line (prose or code depending on context)

Tokens are not the AST. They are line-level signals that mark structural
patterns. A `HeadingStart` token says "this line starts with `## `"; it does
not say "this is the beginning of a CodeSection."


## Stage 3 — Weft accumulation (multi-line blocks)

Wefts are multi-line blocks, not 1:1 with source lines. The tokeniser
feeds a `Stream.mapAccum` accumulator that groups consecutive lines into
structural blocks:

- `HeadingWeft` — a heading line (always single-line)
- `CodeWeft` — an arrow line followed by code body lines, until next heading/separator/tilde
- `TildeWeft` — open fence, body lines, close fence (paired, like markdown ``` fences)
- `ProseWeft` — consecutive non-structural lines
- `SeparatorWeft` — a `---` line (always single-line)

The accumulator's state tracks "what kind of block am I currently inside?"
and flushes completed blocks downstream. Each Weft carries offset ranges
into the original text, not copies.


## Stage 4 — AST (LoomDocument)

The parser consumes the Weft stream and assembles the hierarchical
structure: `LoomDocument → LoomChapter[] → LoomSection[]`.

AST nodes store offset pairs (`start.offset`, `end.offset`) referencing the
original source text. Text values (tag labels, code content) are derived on
demand via `text.slice(start, end)` — the `value` field is a convenience,
not the source of truth.

We build a Loom AST only. No TypeScript AST, no JSON AST, no AST for any
embedded language. Those are handled by their respective Volar services.


## Stage 5 — Projection (AST → VirtualCode tree)

The projector walks the Loom AST and builds the VirtualCode tree that Volar
consumes. It produces:

### Root VirtualCode

```
{ id: "root", languageId: "loom", snapshot, mappings: [], embeddedCodes: [...] }
```

The root's text IS the source. `mappings: []` because no Volar service
handles `languageId: "loom"` — the root is a container, not a service
target.

### Frame (always TypeScript)

A synthetic `Effect.Service` class generated from the Loom AST. Contains:

- `import` preamble (synthetic, unmapped)
- `class` header with chapter name (synthetic, unmapped)
- `readonly` members for each tagged section (mapped: source tag label offset → generated identifier offset)
- `compose(...)` calls with section body content (mapped: source code offsets → generated template literal offsets)
- Service class boilerplate (synthetic, unmapped)

### Tangled-N (language per Tangle declaration)

Concatenated section bodies as declared by each Tangle's `compose(...)`.
Each section's code lines are copied verbatim with 1:1 mappings. Synthetic
separators between sections are unmapped.

### Embedded-N (language per untangled section)

One VirtualCode per untangled code section. Nearly identity copies of
section bodies with the declared language as `languageId`.


## Mapping mechanics

A `CodeMapping` is a parallel array of span pairs sharing one
`CodeInformation` capability mask:

```ts
{
  sourceOffsets:    number[]   // byte positions in .loom
  generatedOffsets: number[]   // byte positions in this virtual code's text
  lengths:          number[]   // source span lengths
  generatedLengths: number[]   // generated span lengths (always explicit)
  data: CodeInformation        // feature flags for these regions
}
```

### How mappings are authored

Mappings are a byproduct of generation, not a separate analysis step. At
each point during frame/tangled text construction, two values are known
simultaneously:

1. **Source offset** — from the Loom AST node being emitted (`node.position.start.offset`)
2. **Generated offset** — current length of the buffer being built (`buffer.length`)

The builder records both at the moment of writing. No post-hoc analysis of
the generated text is needed.

### Builder operations

Three operations cover all cases:

- **copy** — append source text verbatim, record 1:1 mapping (source offset, generated offset, shared length)
- **synth** — append synthetic text, no mapping (boilerplate, separators, glue)
- **expand** — append generated text derived from source, record mapping with different lengths (e.g. `[Greet]` → `readonly Greet: Effect<Code>`)

### Capability flags (CodeInformation)

Each mapping declares which LSP features it enables:

- `verification` — diagnostics + code actions propagate to source
- `semantic` — hover, semantic tokens, inlay hints
- `navigation` — go-to-def, references, rename
- `completion` — autocomplete
- `structure` — outline / symbol tree
- `format` — formatting

Default: all flags on for author-written text. Set flags off for synthetic
regions that shouldn't surface errors or features to the user.

### What is mapped vs unmapped

Rule: if removing an author-written character would change or remove this
generated character, map it. If this generated character exists regardless
of what the author wrote (class headers, import boilerplate, separators),
don't map it.

Unmapped generated regions are invisible: diagnostics there are silently
dropped, hover requests return nothing.


## Snapshot creation for children

Each child VirtualCode needs its own `IScriptSnapshot` wrapping its
generated text:

```ts
const makeSnapshot = (text: string): IScriptSnapshot => ({
  getText: (start, end) => text.slice(start, end),
  getLength: () => text.length,
  getChangeRange: () => undefined,
})
```

`getChangeRange` returns `undefined` because we rebuild from scratch — no
incremental diff available. Volar handles this by doing a full reparse of
the child, which is correct.


## Diagnostics — two independent pipelines

### TS diagnostics (via Volar services + mappings)

The TypeScript service runs against the frame and tangled children. It
produces diagnostics at generated offsets. Volar translates them back to
`.loom` source offsets via the mappings. Examples:

- Duplicate `[Greet]` → two `readonly Greet:` in frame → TS reports `Duplicate identifier` → mapped back to second bracket
- Type error in code body → TS reports in tangled doc → mapped back to code line in `.loom`

### Loom diagnostics (via custom Loom service + AST)

A custom Volar service for `languageId: "loom"` reads the stashed AST and
produces diagnostics directly at `.loom` source offsets:

- Unclosed brackets, missing tags, malformed headings
- Structural validation (chapter without required specifier, etc.)

The two services never communicate. Volar merges their results on the same
file automatically.


## Architecture invariants

1. **Pure function.** `IScriptSnapshot → VirtualCode` is the entire contract. No state between calls.
2. **Rebuild, don't mutate.** Each call returns a fresh VirtualCode. Volar's caches key on snapshot identity, not VirtualCode reference.
3. **One Loom AST only.** No AST for generated languages. TS/JSON/etc. services handle their own parsing internally.
4. **Flat children.** All embedded VirtualCodes are siblings under root, not nested. Volar checks each child's mappings independently against source offsets.
5. **Mappings are a generation byproduct.** Source offsets come from AST nodes. Generated offsets come from buffer length at write time. No post-hoc analysis.
6. **`generatedLengths` always explicit.** Even when equal to `lengths`, for uniform code and self-describing mappings.
