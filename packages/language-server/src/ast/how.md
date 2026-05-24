# Loom AST — Specification

The Loom parsing pipeline produces a `LoomDocument` AST from raw source
text. This document specifies the architecture, grammar, vocabulary, and
per-stage contracts.

---

## Architecture — three layers, one shape

```
Containers  (LoomAst.ts)   ─ LoomDocument → LoomChapter → LoomSection,
                            │ LoomHeading; multi-line structural units
                            ▼
Wefts       (Weft.ts)      ─ ChapterHeading, SectionHeading; ArrowWeft,
                            │ TildeWeft, PreambleWeft, ProseWeft, CodeWeft;
                            │ one line each, mode-classified
                            ▼
Tokens      (LoomTokens.ts) ─ HeadingStart variants, Tag, Specifier, Arrow,
                            │ Tilde, Text, Code, Prose; inner-line
                            │ position slices. Tag/Specifier composites have
                            │ named subnode tokens
                            ▼
Foundation  (LoomNode.ts)  ─ Point/Position, Severity/Diagnostic,
                            │ HealthStatus/Health, okHealth, loomNode()
```

Every node — container, Weft, or Token — flows through `loomNode(tag, fields)`
and so carries the same shape:

```
{ type: <literal>, position: Position, health: Health,
  unexpected?: ReadonlyArray<UnexpectedToken>, ...fields }
```

`unexpected[]` is the universal slot for positional fragments rejected by the
schema (orphan brackets, duplicate tags, label content that fails the
character-class filter). Each entry is `{ type, position, value }` — no
health field, because its presence in a parent's `unexpected[]` IS the
anomaly. The walker recognises a node by the presence of `type` and recurses
into any field whose value has one. No three-vocabulary translation step;
every layer is a discriminable AST node.

---

## Pipeline

Four stages:

```
lineRanges.stream(text)         string → Effect<Stream<LineRange>, MixedEOL>
classify.classifyWefts(text)    Stream<LineRange> → Stream<LoomWeft>
tokenise.tokeniseWefts(text)    Stream<LoomWeft>  → Stream<LoomWeft>
documentBuilder.build           Stream<LoomWeft>  → Effect<LoomDocument>
```

`Loom.ast(text)` is the entry point. It never fails — `MixedEOL` is caught
and returned as a minimal LoomDocument with NOK root health.

---

## Error model — Health

Every AST node carries a required `health` field. Tokens and Wefts are AST
citizens too — they have their own `health` and can attach diagnostics
directly at the leaf where the problem lives (e.g. a "missing `]`" diagnostic
attaches to the `TagClose` subnode at the position the bracket should have
occupied).

```typescript
interface Health {
  readonly status:      "ok" | "error" | "warning" | "incomplete"
  readonly diagnostics: ReadonlyArray<Diagnostic>
}

interface Diagnostic {
  readonly message:  string
  readonly position: Position
  readonly severity: "error" | "warning" | "info"
}
```

Status semantics across pipeline stages:

- `ok`        — structurally final, no problems detected.
- `incomplete` — an earlier stage emitted the node knowing required fields are
                 not yet filled; a later stage is expected to finish the work.
                 Consumers must not trust missing fields.
- `error`    — a stage detected a rule violation. Diagnostics describe it.
- `warning`  — a non-fatal issue.

The AST speaks for itself. No separate diagnostic collector, no Ref service.
`MixedEOL` produces a document with NOK root health and a single positioned
diagnostic. All other structural errors (malformed tags, missing brackets,
invalid mode transitions) live in the `health` field of the relevant node.
A flat diagnostic list is derived by walking the AST and collecting nodes
where `health.status !== "ok"`.

`okHealth` and `incompleteHealth` are the canonical constants for the `ok`
and `incomplete` cases, exported from `LoomNode.ts`.

---

## Schema-valid AST, truthful health

Every stage produces a schema-valid AST. Source malformations don't break
the schema — constraints stay strict; `health` and `unexpected[]` carry the
truth about what's pending, wrong, or rejected.

**Health-aware filters.** Where a schema rule is meaningful only on a
finalised node, the `Schema.filter` is health-aware: it accepts NOK-health
input regardless of content and enforces the rule only when health is `ok`.
Examples:
- `TagLabel` / `SpecifierLabel`: empty `value` admitted only when health is
  non-ok; real labels must match `^[a-zA-Z0-9_-]+$`. One cross-field rule,
  both directions.

**Two NOK channels.** When the Classifier Stage emits a node it does not
have content for, it fills required subnodes with **NOK placeholders** at
zero-width-EOL positions carrying `incompleteHealth`. The Tokeniser Stage
replaces them with real tokens parsed from source. When source content
exists but is malformed (label with a space, etc.), the Tokeniser builds a
schema-valid node anyway — synthetic empty `value`, error health, the bad
text preserved in `unexpected[]`. Bytes are never dropped.

**Post-Tokeniser invariant.** A weft that has passed the Tokeniser is never
`incomplete`. It is `ok`, `error`, or `warning`. ChapterHeading missing a
required field synthesises an error-health placeholder with a diagnostic;
PreambleWeft / ProseWeft flip from `incomplete` to `ok`. The Tokeniser is
the authority on completion.

Example: `# Chapter I` produces a `ChapterHeadingWeft` (schema-valid,
`incompleteHealth`) carrying NOK `Tag` and `Specifier` placeholders. The
Tokeniser fills them from source if present; otherwise synthesises
error-health placeholders with a "requires a tag/specifier" diagnostic.
`Schema.is(LoomDocument)` holds end-to-end at every stage; the health
walker collects positioned diagnostics from leaves where problems live.

---

## Grammar — forward-only mode progression

Inside a Section or Chapter body, modes progress in one direction:

```
[Heading]
   │
   ▼
Preamble mode  (default)  →  PreambleWefts
   │
   ├── Arrow  → Code mode  →  CodeWefts
   │     │
   │     └── Tilde  → Prose mode  →  ProseWefts (terminal)
   │
   └── Tilde  → Prose mode  →  ProseWefts (terminal)
```

- **Arrow** is the only way into Code mode.
- **Tilde** is the only way into Prose mode.
- Neither transition reverses.
- `PreambleWeft` is its own kind — distinct from `ProseWeft`, which only
  appears after a Tilde transition.
- `TildeWeft` inline content is prose only — never code.
- `ArrowWeft` inline content is code only — never prose.

All Sections admit the same transitions, regardless of Specifier. A Section
written in Loom (`{Loom}`) is grammatically identical to one written in
Scala or JSON — the Specifier changes what the Code is typed against, not
the shape of the body.

---

## Specifier `{Loom}` — de dicto sections

A Section is *de dicto* (frame code) iff its Specifier is `{Loom}`. Every
other Specifier — the Chapter default included — makes the Section *de re*
(product code).

```
# Arithmetic [Arithmetic]{Scala}     Chapter — default product language

## Adder [Add]                       de re Scala (inherited)
## Build script [Build]{Bash}        de re Bash (per-Section override)
## Deps {Loom}                       de dicto Loom (frame)
## Tangling app {Loom}               de dicto Loom (frame)
```

`{Loom}` Sections have access to the Loom DSL — the Chapter's own Service
(`Arithmetic.needs(…)`), `tangle(…)`, `compose(…)`. The `=>` / `~` rhythm
works as in any other Section; only the Code's type context changes.

There is no reserved heading shape. The Classifier emits ordinary
`SectionHeadingWeft`s; the Specifier is the single discriminator and lives
in the Specifier token. The de-dicto cut is a Synth-phase concern, not an
AST-pipeline concern.

A `{Loom}` Section can combine roles — declare dependencies (`Service.needs(…)`)
and emit files (`tangle(…)`) in the same body — and a single Loom file may
have multiple `{Loom}` Sections acting as Tangle roots. Composition rules
belong to the Synth Frame Projection design.

---

## Warps

Warps unify the two `{{…}}` forms (parameter and transclusion). A Warp is
declared in a Section's Preamble and referenced from its Code:

```
## Square [Sq]

Uses {{mul: Mul}} to multiply.

=>

{{mul}}

def square(x: Int): Int = mul(x, x)
```

- **Declaration** — `{{name: TagOrType [= default]}}`, recognised in
  Preamble Wefts. Token kind: `WarpTokenSchema`.
- **Reference** — `{{name}}`, recognised in Arrow and Code Wefts. Token
  kind: `WarpAnchorTokenSchema`.

Warps are **Section-local**. Each Section synthesises into a function whose
Warps are its parameters; callers supply values implicitly when they pull
the Section into a composition.

Annotation forms:

- **Tag reference** — `{{mul: Mul}}` binds local `mul` to the Code of the
  Section tagged `Mul`. Composition resolves at Synth time.
- **TS type with default** — `{{port: string = "8080"}}` declares a typed
  parameter with a concrete substitution; full TS checking falls out at the
  substitution site.
- **TS type, no default** — `{{port: string}}` declares a typed parameter
  with no substitution; Synth can check the declaration shape but not the
  value. Diagnostic is a warning, not an error.

Token recognition is mode-driven: Preamble for declarations, Arrow / Code
for references. The same `{{…}}` source shape resolves to a different
schema by host Weft, not by colon-sniffing.

---

## Weft vocabulary

Headings are two kinds — `ChapterHeadingWeft` and `SectionHeadingWeft`.
The de-dicto distinction between frame and product Sections rides on the
`Specifier` token (`{Loom}` vs everything else), not on the heading shape.

- `ChapterHeadingWeft` — `#` (level 1). Requires tag + specifier (filter).
  Classifier emits with NOK placeholders; Tokeniser fills from source or
  synthesises error-health placeholders.
- `SectionHeadingWeft` — `##`+ (level 2+). Tag and specifier both optional.
  Single kind for every `##…` line.

All heading Wefts carry `texts: ReadonlyArray<TextToken>` — an array of
contiguous text segments, not a single token, because heading text can be
non-contiguous (e.g. `# [Loom] is written in {Loom}` has text after the tag
and before the specifier).

Body Wefts:

- `PreambleWeft` — line in Preamble mode (default after heading). Tokeniser
  flips health to `ok`; inner-token expansion belongs to the Synth phase.
- `ProseWeft` — line in Prose mode (after a Tilde transition). Same shape
  and treatment as `PreambleWeft`.
- `CodeWeft` — line in Code mode (after an Arrow transition). Opaque to
  Loom; embedded-language tokenisation happens elsewhere. Terminal.
- `ArrowWeft` — the `=>` line. Carries `arrow: ArrowToken` and optional
  `code: CodeToken`. Tokeniser fills `code` from text after `=>` if any.
- `TildeWeft` — the `~+` line. Carries `tilde: TildeToken` and optional
  `prose: ProseToken`. Tokeniser fills `prose` from text after the tilde
  run if any.
- `Weft` (default) — any line in pre-chapter mode without recognised
  structure. Terminal.

`SectionBodyWeftSchema` is the exported union `(ArrowWeft | CodeWeft |
TildeWeft | ProseWeft)` — the element type for LoomSection.code and
LoomChapter.code.

`---` is not a syntactic feature. A line of dashes is classified by the
current mode like any other content (CodeWeft inside a `=>` block,
PreambleWeft before any transition, etc.). No SeparatorWeft, no
chapter-break syntax.

---

## AST hierarchy

`LoomAstBuilder.build` groups wefts into this hierarchy:

```
LoomDocument
  └── LoomChapter[]            (ChapterHeadingWeft — # level)
        └── LoomSection[]      (SectionHeadingWeft — ##+ level)
```

Section / Chapter shape:

```
LoomSection: heading + preamble (PreambleWeft[]) + code (SectionBodyWeft[])
LoomChapter: heading + preamble (PreambleWeft[]) + code (SectionBodyWeft[]) + children
```

The grammar's forward-only mode progression is preserved implicitly in the
`code` array order: valid prefixes are `[]`, `[ArrowWeft, ...]`, or
`[TildeWeft, ...]`. The classifier enforces the ordering; the AST just
records it. `{Loom}` Sections take the same shape — the Specifier token on
the heading is the only marker that distinguishes them.

---

## Stages

### `WeftClassifier`

A Mealy machine over `(Mode, Probe)` driven by `Stream.mapAccum` carrying
the previously emitted Weft.

- **Mode** ∈ `orphan | preamble | code | prose`, derived from the previous
  Weft via `modeOf`.
- **Probe** is pure pattern recognition over the current line text; no
  Mode awareness.
- **Dispatch** is a decision table laid out as `Match.exhaustive` on Mode
  with probe-narrowing inside the preamble and code rows. Chapter and
  Section heading probes are mode-independent and handled with early
  returns.

Emitted Wefts carry `incompleteHealth` where subtoken filling is pending.
ChapterHeading additionally carries NOK placeholder `tag` and `specifier`
subnodes at zero-width EOL positions so the strict schema filter is
satisfied without pretending content exists.

### `WeftTokeniser`

Pure `Stream.map` with `Match.exhaustive` over every LoomWeft kind. The
stage is subtoken expansion plus health resolution.

- **`ChapterHeadingWeft` / `SectionHeadingWeft`** — scan tag and specifier
  anchors, build composite tokens, fill `texts[]` from the gaps between
  structural tokens. Synthetic close at EOL with error health when source
  has the open but no close. Bad label content preserved in
  `label.unexpected[]` with synthetic empty `value`. ChapterHeading
  synthesises error-health placeholders for missing tag or specifier.
- **`ArrowWeft` / `TildeWeft`** — fill optional `code` / `prose` subtoken
  via the lookbehind `Probe` on `CodeTokenSchema` / `ProseTokenSchema`;
  flip health to `ok`.
- **`PreambleWeft` / `ProseWeft`** — structural-final at this stage; flip
  health to `ok`.
- **`Weft` / `CodeWeft`** — passthrough; already `okHealth` from the
  Classifier; terminal per design.

Post-Tokeniser invariant: no weft has `health.status === "incomplete"`.

### `LoomAstBuilder`

`build(Stream<LoomWeft>) → Effect<LoomDocument>`. Groups wefts into the
`LoomChapter` hierarchy via `Stream.mapAccum` with a chapter accumulator:
ChapterHeadingWeft flushes the previous chapter; a sentinel flushes the
final. Inside a chapter, the same accumulator pattern groups wefts into
`LoomSection`s — one container kind, one path. Folds into `LoomDocument`
via `Stream.runFold`.

### `Loom` (orchestrator)

Wires `LoomSourceRanges` → `WeftClassifier` → `WeftTokeniser` →
`LoomAstBuilder` into a single `Loom.ast(text): Effect<LoomDocument>`
entry point. `MixedEOL` from `LoomSourceRanges` is caught at the
orchestrator and converted to a minimal LoomDocument with NOK root health
via `emptyDocumentFor`; no further stages run on that path.

---

## Invariants

- `LoomWeft` is the stream element between every stage. There is no
  intermediate `ClassifiedLine` type.
- Every AST citizen — container, Weft, or Token — flows through
  `loomNode()`. No parallel non-`loomNode` schemas in `LoomAst.ts` /
  `LoomTokens.ts` / `Weft.ts`.
- Frame synthesis and `loomLanguagePlugin` projection are outside the AST
  pipeline.
