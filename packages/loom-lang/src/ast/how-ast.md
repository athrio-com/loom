# Loom AST — Specification

The Loom parsing pipeline produces a `LoomDocument` AST from raw source
text. This document specifies the architecture, grammar, vocabulary, and
per-stage contracts.

This is the **parse** pass of Loom's transformation pipeline (text →
`LoomDocument`); `how-lsp.md` → The Transformation Pipeline frames the whole
chain and the morphisms each stage is.

---

## Architecture — three layers, one shape

```
Containers  (LoomAst.ts)   ─ LoomDocument → LoomSection; LoomHeading;
                            │ multi-line structural units
                            ▼
Wefts       (Weft.ts)      ─ HeadingWeft; PreambleWeft, ArrowWeft,
                            │ CodeWeft, TildeWeft, ProseWeft; one line
                            │ each, mode-classified
                            ▼
Tokens      (LoomTokens.ts) ─ HeadingStart, Tag, Specifier, PathSpecifier,
                            │ Arrow, Tilde, Text, Code, Prose; inner-line
                            │ position slices. Tag/Specifier composites
                            │ carry named subnode tokens
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
diagnostic. All other structural problems (malformed tags, missing brackets,
a missing `lang` declaration) live in the `health` field of the relevant node.
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
  non-ok; a real label must match `^[a-zA-Z0-9_-]+$`. The path-specifier
  label admits path separators under the same health-aware scheme.
- `WarpName`: same pattern — empty `value` admitted only when health is
  non-ok; a real name must match the TS-identifier shape
  `^[a-zA-Z_][a-zA-Z0-9_]*$`.

**Two NOK channels.** When the Classifier Stage emits a node it does not
have content for, it fills required subnodes with **NOK placeholders** at
zero-width-EOL positions carrying `incompleteHealth`. The Tokeniser Stage
replaces them with real tokens parsed from source. When source content
exists but is malformed (a label with a space, an unclosed bracket), the
Tokeniser builds a schema-valid node anyway — synthetic empty `value`,
error health, the bad text preserved in `unexpected[]`. Bytes are never
dropped.

**Post-Tokeniser invariant.** A weft that has passed the Tokeniser is never
`incomplete`. Its `health.status` is `ok`, `error`, or `warning` — the
aggregate of its subnodes. A heading with a malformed tag carries the error
on its `TagLabel` leaf; a tagless heading instead carries a hash-synthesised
`TagToken` with ok health (a private section, not an error).
`Schema.is(LoomDocument)` holds end-to-end at every stage; the health walker
collects positioned diagnostics from leaves where problems live.

---

## Document Preamble

The lines before the first heading form the Document Preamble — a run of
`PreambleWeft`s on `document.preamble`. The document is, in effect, a
headingless section: it has a preamble but no code of its own, and the
Sections that follow carry the content.

The primary language is declared by a Warp whose name is `lang`:

```
{{lang: Scala}}

A library of integer arithmetic.

# Adder [Add]
…
```

The annotation (`Scala`) is the default language for any Section that
carries no Specifier of its own. The declaration is an ordinary `WarpToken`
in the AST — recognised as the language by its `lang` name at a later stage,
not by a dedicated token kind. When the Document Preamble carries no `lang`
Warp, the builder raises a `warning` on the document's health: the primary
language can't be identified, but parsing proceeds.

A writer may set the preamble off with `---` divider lines; these are
decorative content, not structure (see Weft vocabulary). The Document
Preamble ends at the first heading.

---

## Grammar — mode progression

A Section body opens in Preamble; the first `=>` / `~` enters Code / Prose, which
then alternate:

```
[Heading]
   │
   ▼
Preamble mode  (default)  →  PreambleWefts
   │
   ├── Arrow  → Code mode  →  CodeWefts   ⇄  Tilde → Prose
   └── Tilde  → Prose mode →  ProseWefts  ⇄  Arrow → Code
```

- **Arrow** is the only way into Code mode; **Tilde** the only way into Prose.
- Code and Prose **alternate**: a `~` ends a code *chunk* (back to prose), and a
  later `=>` re-enters Code. A Section's code body is the run of all its `=>`
  chunks — the body composes them as one, the interleaved prose is documentation.
- `PreambleWeft` is its own kind — distinct from `ProseWeft`, which appears only
  after a Tilde transition; the Document Preamble takes neither transition.
- `TildeWeft` inline content is prose only — never code.
- `ArrowWeft` inline content is code only — never prose.

The Document Preamble is preamble mode without a heading; Arrow and Tilde
transitions begin only within a Section. All Sections admit the same
transitions regardless of Specifier — a Section written in Loom (`{Loom}`)
is grammatically identical to one written in Scala or JSON. The Specifier
changes what the Code is typed against, not the shape of the body.

---

## Specifiers — label and path

A heading may carry a Specifier in braces, of two kinds:

- **Label specifier** — `{Scala}`, `{Bash}`, `{Loom}`. A short identifier
  (`^[a-zA-Z0-9_-]+$`) naming the Section's language, or the reserved
  `{Loom}` marker. Token: `SpecifierToken`.
- **Path specifier** — `{src/main/scala/Arithmetic.scala}`. A value
  carrying path separators, marking the Section as a tangle (file-emission)
  sink. Token: `PathSpecifierToken`.

The Tokeniser tells them apart by the presence of path separators — no extra
syntax. A Section with no Specifier inherits the Document Preamble's `lang`.

`{Loom}` is a power-user escape hatch: the Section's code block is projected
literally into the Frame rather than wrapped as composed product code. It
carries no dependency role. The de-dicto / de-re cut, tangle composition,
and dependency wiring are Frame-pass concerns (`how-frame.md`), not AST-pipeline
concerns — the AST records the Specifier token and nothing more.

---

## Warps

Warps unify the `{{…}}` forms. There are two reference forms.

**Warp declaration** — `{{name: annotation [= default]}}`, recognised in a
Preamble Weft (the Document Preamble or a Section's preamble). Token:
`WarpToken`. It binds a local `name`, used as a `{{name}}` anchor in the
Section's code.

**Name anchor** — `{{name}}` or `{{Heading Name}}`, recognised in Arrow and
Code Wefts. Token: `WarpAnchorToken`. A single-word anchor resolves first to
a Warp binding, then — failing that — to a Section by heading name. A
multi-word anchor (`{{Multiplier Function}}`) is always a heading-name
reference.

```
## Square [Sq]

Uses {{mul: Mul}} to multiply.

=>

{{mul}}

def square(x: Int): Int = mul(x, x)
```

Annotation forms:

- **Tag reference** — `{{mul: Mul}}` binds local `mul` to the Section tagged
  `Mul`. A cross-file reference uses the bare tag (`Mul`); the Frame
  generates the import. There is no dotted (`Other.Mul`) form and no
  namespace wrapper.
- **TS type with default** — `{{port: string = "8080"}}` declares a typed
  parameter with a concrete substitution.
- **TS type, no default** — `{{port: string}}` declares a typed parameter
  with no substitution; the Frame pass can check the declaration shape but
  not the value. The diagnostic is a warning, not an error.

Token recognition is mode-driven: Preamble for declarations, Arrow / Code for
references. The same `{{…}}` source shape resolves to a different schema by
host Weft, not by colon-sniffing. How a Warp resolves into the Frame — a
Service dependency, an inlined code value — is a Frame-pass concern; at the AST
layer a Warp is a declaration and an anchor is a reference.

---

## Weft vocabulary

One heading weft — `HeadingWeft` — for every `#{1,6}` line. The level is
recorded in the `headingStart` token and carries no structural meaning; all
headings create flat Sections. `tag` and `specifier` are optional. The
Tokeniser synthesises a hash-derived `tag` for a tagless heading so that
every Section has a stable identifier; the hash is taken from the heading
text.

All heading Wefts carry `texts: ReadonlyArray<TextToken>` — an array of
contiguous text segments, not a single token, because heading text can be
non-contiguous (e.g. `# [Loom] is written in {Loom}` has a text segment
after the tag and before the specifier).

Body Wefts:

- `PreambleWeft` — a line in Preamble mode: the Document Preamble (before any
  heading) or a Section's preamble (after its heading, before any
  transition). Carries `warps: ReadonlyArray<WarpToken>` — every
  `{{name: annotation [= default]}}` declaration recognised on the line.
- `ProseWeft` — a line in Prose mode (after a Tilde transition). No inner
  tokens at the AST stage; inner-token expansion belongs to the Frame pass.
- `CodeWeft` — a line in Code mode (after an Arrow transition). Carries
  `anchors: ReadonlyArray<WarpAnchorToken>` — every `{{name}}` /
  `{{Heading Name}}` reference recognised on the line. The line content is
  otherwise opaque to Loom (embedded-language tokenisation happens
  elsewhere).
- `ArrowWeft` — the `=>` line. Carries `arrow: ArrowToken`, optional
  `code: CodeToken`, and `anchors` for references inside the inline code.
- `TildeWeft` — the `~+` line. Carries `tilde: TildeToken` and optional
  `prose: ProseToken`. The Tokeniser fills `prose` from text after the tilde
  run if any.

There is no default `Weft` kind: lines before the first heading are Document
Preamble `PreambleWeft`s, not a separate orphan kind.

`SectionBodyWeftSchema` is the exported union `(ArrowWeft | CodeWeft |
TildeWeft | ProseWeft)` — the element type for `LoomSection.code`.

`---` is not a syntactic feature. A line of dashes is classified by the
current mode like any other content (a `CodeWeft` inside a `=>` block, a
`PreambleWeft` in the Document Preamble). No SeparatorWeft, no frontmatter
fence.

---

## AST hierarchy

Two container tiers, all `loomNode`s:

```
LoomDocument
  ├── preamble: PreambleWeft[]    (Document Preamble — pre-heading lines)
  └── sections: LoomSection[]     (flat — one per heading, any level)
```

Container shape:

```
LoomDocument: preamble (PreambleWeft[]) + sections (LoomSection[])
LoomSection:  heading + preamble (PreambleWeft[]) + code (SectionBodyWeft[])
```

`LoomDocument` is the implicit module, named by its file rather than by a
heading. Its `preamble` carries the `lang` declaration and any introductory
prose; its `sections` are flat, with no nesting. Heading level is prose
organisation for the reader and has no bearing on the tree.

The grammar's mode progression is preserved implicitly in each Section's `code`
array: it begins at the first transition — valid prefixes `[]`, `[ArrowWeft, ...]`,
or `[TildeWeft, ...]` — after which Code and Prose alternate. The Classifier
enforces this; the AST just records it. `{Loom}` Sections take the same shape as any other — the
Specifier token on the heading is the only marker that distinguishes them.

Every input weft has a place in the tree; nothing is dropped between stages.

---

## Stages

### `WeftClassifier`

A Mealy machine over `(Mode, Probe)` driven by `Stream.mapAccum` carrying the
previously emitted Weft.

- **Mode** ∈ `preamble | code | prose`, derived from the previous Weft via
  `modeOf`. The document opens in `preamble` — the Document Preamble — so
  there is no `orphan` mode and no default `Weft` kind.
- **Probe** is pure pattern recognition over the current line text; no Mode
  awareness.
- **Dispatch** is a decision table laid out as `Match.exhaustive` on Mode
  with probe-narrowing inside the preamble and code rows. The heading probe
  is mode-independent — one probe for `#{1,6}` — and handled with an early
  return that opens the new Section's body in `preamble` mode.

Emitted Wefts carry `incompleteHealth` where subtoken filling is pending; the
Tokeniser settles it.

### `WeftTokeniser`

Pure `Stream.map` with `Match.exhaustive` over every LoomWeft kind. The stage
is subtoken expansion plus health resolution.

- **`HeadingWeft`** — scan tag and specifier anchors, build composite tokens,
  fill `texts[]` from the gaps between structural tokens. A label specifier
  and a path specifier are distinguished by the presence of path separators.
  Synthetic close at EOL with error health when source has an open but no
  close; bad label content preserved in `label.unexpected[]` with a synthetic
  empty `value`. A tagless heading receives a hash-derived `TagToken` (ok
  health), so every Section has a stable identifier.
- **`PreambleWeft`** — scan `{{` / `}}` pairs, build Warp declarations
  (`open` / `name` / `annotation` / `default?` / `close`), populate `warps[]`.
  Stray `}}` lands on `weft.unexpected[]`; a top-level `,` / `;` inside an
  annotation or default lands on `warp.unexpected[]`.
- **`ArrowWeft`** — fill the optional inline `code` subtoken via the
  `CodeTokenSchema` Probe; scan `{{` / `}}` pairs and build WarpAnchor
  references into `anchors[]`.
- **`CodeWeft`** — scan `{{` / `}}` pairs and build WarpAnchor references into
  `anchors[]`. An anchor's content is a single identifier or a multi-word
  heading name; line content otherwise stays opaque to Loom.
- **`TildeWeft`** — fill the optional inline `prose` subtoken via the
  `ProseTokenSchema` Probe; flip health to `ok`.
- **`ProseWeft`** — flip health to `ok`. Inner-token expansion belongs to the
  Frame pass.

A Warp anchor's content is a single identifier or a multi-word heading name;
anything that is neither (e.g. `{{name: Type}}` written in Code mode) lands
on the host weft's `unexpected[]`. Warp declaration content is
`name [: annotation [= default]]`; a missing `:` synthesises an error-health
annotation so the schema's required `annotation` field stays filled.

Post-Tokeniser invariant: no weft has `health.status === "incomplete"`.

### `LoomAstBuilder`

`build(Stream<LoomWeft>) → Effect<LoomDocument>`. A flat grouping, with no
chapter tier:

- `PreambleWeft` before the first heading → `document.preamble`.
- `HeadingWeft` → the `heading` of a new `LoomSection` appended to
  `document.sections`; closes any open Section.
- `PreambleWeft` after a heading → the open Section's `preamble`.
- `ArrowWeft`, `CodeWeft`, `TildeWeft`, `ProseWeft` → the open Section's
  `code`.

If the Document Preamble carries no `lang` Warp, the builder sets a `warning`
on the document's health. Container nodes otherwise carry `okHealth`;
diagnostics on contained nodes ride with them, untouched. Never fails.

### `Loom` (orchestrator)

Wires `LoomSourceRanges` → `WeftClassifier` → `WeftTokeniser` →
`LoomAstBuilder` into a single `Loom.ast(text): Effect<LoomDocument>` entry
point. `MixedEOL` from `LoomSourceRanges` is caught at the orchestrator and
converted to a minimal LoomDocument with NOK root health via
`emptyDocumentFor`; no further stages run on that path.

---

## Invariants

- `LoomWeft` is the stream element between every stage. There is no
  intermediate `ClassifiedLine` type.
- Every AST citizen — container, Weft, or Token — flows through `loomNode()`.
  No parallel non-`loomNode` schemas in `LoomAst.ts` / `LoomTokens.ts` /
  `Weft.ts`.
- The Frame pass and `loomLanguagePlugin` projection are outside the AST
  pipeline.
