# Loom — Design Checkpoints and Implementation Plan

Read `LoomAst.ts` first. It is the primary specification and prompt for the
pipeline. Everything below records design decisions made through the AST
landing passes. Honour all of them.

---

## Architecture — three layers, one shape

```
Containers  (LoomAst.ts)   ─ LoomDocument → LoomChapter → LoomSection /
                            │ LoomDependencies / LoomTangle, LoomHeading
                            │ multi-line structural units
                            ▼
Wefts       (Weft.ts)      ─ ChapterHeading / SectionHeading / Deps / Tangle
                            │ headings; ArrowWeft, TildeWeft, PreambleWeft,
                            │ ProseWeft, CodeWeft, DependencyWeft, TangleWeft;
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

`okHealth` and `incompleteHealth` are exported from `LoomNode.ts` — use them
everywhere the producer has nothing to report or is emitting a Classifier-Stage
partial.

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
- `DependenciesHeadingWeft` / `TangleHeadingWeft`: `tag.label.value` must
  be `"D"` / `"T"` once health is `ok`; the Classifier-Stage placeholder
  (incomplete-health, empty-label tag) is admitted before that.

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
Preamble mode  (default)  →  PreambleWefts (specially tokenised)
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

Reserved sections (LoomDependencies, LoomTangle) do not admit these
transitions — they are heading-plus-body only, body is a homogeneous array
of the section's specific Weft kind.

---

## Weft vocabulary

`HeadingWeft` is dissolved into four specific kinds. All four are emitted
directly by the Classifier Stage — Deps/Tangle discrimination is a
Classifier responsibility, driven by `Probe` annotations on the
`DependenciesHeadingWeftSchema` / `TangleHeadingWeftSchema` (matching
`/^#{2,6} [^\[\]{}]*\[D\][^\[\]{}]*$/` and the `[T]` analogue: exactly one
reserved tag, no extras, no specifier). The Classifier consults these via
`getProbe`; no token construction happens at the Classifier Stage. The
Tokeniser fills the real tag.

- `ChapterHeadingWeft` — `#` (level 1). Requires tag + specifier (filter).
  Classifier emits with NOK placeholders; Tokeniser fills from source or
  synthesises error-health placeholders.
- `SectionHeadingWeft` — `##`+ (level 2+). Tag/specifier optional. Default
  for any `##…` line that does not match the Deps/Tangle Probe.
- `DependenciesHeadingWeft` — `##`+ with exactly one `[D]` tag, no
  specifier. Classifier emits with a NOK placeholder tag; Tokeniser fills
  the real tag, at which point the health-aware filter enforces
  `tag.label.value === "D"`.
- `TangleHeadingWeft` — same shape, `[T]` discriminator.

All heading Wefts carry `texts: ReadonlyArray<TextToken>` — an array of
contiguous text segments, not a single token, because heading text can be
non-contiguous (e.g. `# [Loom] is written in {Loom}` has text after the tag
and before the specifier).

Body Wefts:

- `PreambleWeft` — line in Preamble mode (default after heading). Inner
  tokenisation model TBD; Tokeniser flips health to `ok`.
- `ProseWeft` — line in Prose mode (after a Tilde transition). Same.
- `CodeWeft` — line in Code mode (after an Arrow transition). Opaque to
  Loom; embedded-language tokenisation happens elsewhere. Terminal.
- `ArrowWeft` — the `=>` line. Carries `arrow: ArrowToken` and optional
  `code: CodeToken`. Tokeniser fills `code` from text after `=>` if any.
- `TildeWeft` — the `~+` line. Carries `tilde: TildeToken` and optional
  `prose: ProseToken`. Tokeniser fills `prose` from text after the tilde
  run if any.
- `DependencyWeft` — line inside a Deps section, opaque per design
  (homogeneous body, no transitions admitted). Classifier emits directly
  in `deps` mode.
- `TangleWeft` — same, for Tangle sections.
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
        ├── LoomSection[]      (SectionHeadingWeft — ##+ level)
        ├── LoomDependencies   (DependenciesHeadingWeft — ## [D])
        └── LoomTangle         (TangleHeadingWeft — ## [T])
```

`LoomChapterChildSchema = Union(LoomSection, LoomDependencies, LoomTangle)`
is the element type of `LoomChapter.children`.

Section / Chapter shape:

```
LoomSection: heading + preamble (PreambleWeft[]) + code (SectionBodyWeft[])
LoomChapter: heading + preamble (PreambleWeft[]) + code (SectionBodyWeft[]) + children
```

The grammar's forward-only mode progression is preserved implicitly in the
`code` array order: valid prefixes are `[]`, `[ArrowWeft, ...]`, or
`[TildeWeft, ...]`. The classifier enforces the ordering; the AST just
records it.

Reserved section shape:

```
LoomDependencies: heading + code (DependencyWeft[])
LoomTangle:       heading + code (TangleWeft[])
```

No preamble, no arrow, no mode transitions.

---

## LoomServicePlugin

A minimal `LoomServicePlugin` for `languageId: "loom"` is needed to surface
Loom structural diagnostics. It reads the `LoomDocument` from the root
`VirtualCode` and walks the AST collecting nodes where `health.status !==
"ok"`.

---

## Implementation order

Introduce features incrementally in this order. Do not skip ahead. Do not
decide by yourself to move to the next item.

### Done

1. **Health and Diagnostic schemas** — `LoomNode.ts` owns the foundation:
   Severity / Diagnostic / HealthStatus / Health / okHealth and the
   `loomNode()` combinator. Every existing node and subnode schema carries
   `health: HealthSchema`.

2. **New AST nodes** — `LoomDependencies` and `LoomTangle` in `LoomAst.ts`.
   `LoomChapter.children` is the `Union(LoomSection, LoomDependencies,
   LoomTangle)` array.

3. **Token schema updates** — `TextTokenSchema`, `CodeTokenSchema`,
   `ProseTokenSchema` in `LoomTokens.ts`. Position-only, with Probe
   annotations. Level-specific heading-start tokens
   (`ChapterHeadingStartTokenSchema`, `SectionHeadingStartTokenSchema`)
   replace the generic HeadingStart.

4. **Weft schema rewrite** — every Weft kind present, `texts` is an array,
   union complete. PreambleWeft added.

Out-of-band passes (after the original step 4, before step 5):

A. **Token-AST unification** — tokens crossed from "stream-only" into the
   AST as health-bearing leaves via `loomNode()`. Tag/Specifier subnodes
   (`TagOpen`/`Label`/`Close`, `SpecifierOpen`/`Label`/`Close`) became
   named loomNodes; HeadingStart tokens were flattened (no inner `markers`
   substruct, `value` lives on the token). The parallel
   `LoomTag`/`LoomTagOpen`/… definitions in `LoomAst.ts` were dropped;
   containers now reference token schemas directly. `LoomHeading.markers`
   became a union of the two HeadingStart token kinds.

B. **Weft promotion + container reshape** — Wefts followed tokens into the
   AST as health-bearing leaves. `source: LineRange` → `position: Position`.
   `LoomSection` / `LoomChapter` body shape rewritten around the corrected
   forward-only grammar: a `preamble` array of PreambleWefts and a `code`
   array of `SectionBodyWeft` (the union of ArrowWeft, CodeWeft, TildeWeft,
   ProseWeft). The separate `arrow?: ArrowToken` field is gone — the
   ArrowWeft is now the first element of `code` when the arrow transition
   fires.

5. **`WeftClassifier.ts`** — the Classifier Stage. Mealy machine over
   `(Mode, Probe)`. Mode ∈ `orphan | preamble | code | prose | deps |
   tangle`, derived from the previous Weft via `modeOf`. Probe is pure
   pattern recognition over the line text. Decision table laid out as
   `Match.exhaustive` on Mode with probe-narrowing inside preamble/code
   rows. Universal heading patterns (chapter, section) handled with early
   returns. Section discrimination consults the line-level `Probe`
   annotations on `DependenciesHeadingWeftSchema` /
   `TangleHeadingWeftSchema` to emit Deps/Tangle headings directly.
   Inside `deps`/`tangle` modes, body lines become opaque `DependencyWeft`
   / `TangleWeft` — reserved sections do not admit transitions per the
   grammar. Wefts carry `incompleteHealth` where subtoken filling is
   pending; Chapter/Deps/Tangle headings additionally carry NOK
   placeholder tags (and ChapterHeading a NOK specifier) at zero-width
   EOL so the strict schema filter is satisfied without pretending.

   Landed alongside: `incomplete` health status + `incompleteHealth`
   constant in `LoomNode.ts`; the `unexpected?: ReadonlyArray<
   UnexpectedToken>` field on every loomNode; `loomNode`'s `type` field
   gets `withConstructorDefault`; cross-field health-aware filters on
   `TagLabel` / `SpecifierLabel` and on the reserved-heading schemas.
   Unit and integration tests under `WeftClassifier.test.ts` and
   `WeftClassifier.integration.test.ts`; dev probe at
   `scripts/classify-loom.ts`.

6. **`WeftTokeniser.ts`** — the Tokeniser Stage. Pure `Stream.map`,
   `Match.exhaustive` over every LoomWeft kind. Per-kind subtoken
   expansion:

   - `ChapterHeadingWeft` / `SectionHeadingWeft`: scan tag and specifier
     anchors, build composite tokens (synthetic close at EOL with error
     health when source has the open but no close; bad label content
     preserved in `label.unexpected[]` with synthetic empty `value`),
     fill `texts[]` from the gaps. ChapterHeading synthesises
     error-health placeholders for missing tag/specifier (post-Tokeniser
     ChapterHeading is never `incomplete`).
   - `DependenciesHeadingWeft` / `TangleHeadingWeft`: replace the
     Classifier-Stage NOK placeholder tag with the real tag from source;
     fill `texts[]`. Health-aware filter on the heading schema enforces
     `tag.label.value === "D"` / `"T"` once status flips to `ok`.
   - `ArrowWeft` / `TildeWeft`: fill optional `code` / `prose` subtoken
     via the lookbehind `Probe` on `CodeTokenSchema` /
     `ProseTokenSchema`; flip health to `ok`.
   - `PreambleWeft` / `ProseWeft`: structural-final at this stage — flip
     health to `ok`.
   - `Weft` / `CodeWeft` / `DependencyWeft` / `TangleWeft`: passthrough
     (already `okHealth` from the Classifier; opaque/terminal per design).

   Promotion does **not** live here — the Classifier emits Deps/Tangle
   directly. The Tokeniser is purely subtoken expansion + health
   resolution. Post-Tokeniser invariant: `health.status` is never
   `incomplete`.

   Tests at `WeftTokeniser.test.ts`: heading tokenisation, body weft
   subtoken expansion, multi-tag / multi-specifier handling, synthetic
   close on unclosed brackets, malformed label values, text gaps, health
   aggregation.

### Remaining

7. **`LoomAstBuilder.ts`** — implement `build(Stream<LoomWeft>)` using
   `Stream.mapAccum` with a chapter accumulator. Groups wefts into the
   `LoomChapter` hierarchy: ChapterHeadingWeft flushes the previous chapter;
   sentinel flushes the final. Inside a chapter, the same accumulator
   pattern groups wefts into Section / Dependencies / Tangle. Folds into
   `LoomDocument` via `Stream.runFold`.

8. **`Loom.ts` (orchestrator)** — already wired with `LoomSourceRanges` +
   `WeftClassifier` + `WeftTokeniser` + `LoomAstBuilder`. `emptyDocumentFor
   (err: MixedEOL)` already produces a minimal LoomDocument with NOK root
   health. Re-verify once step 7 lands that the pipeline composes
   end-to-end.

---

## Do not

- Introduce a `ClassifiedLine` intermediate type — `LoomWeft` is the stream
  element between every stage.
- Implement Frame synthesis or `loomLanguagePlugin` projection — out of
  scope for the AST pipeline.
- Reintroduce parallel non-`loomNode` schemas in `LoomAst.ts` /
  `LoomTokens.ts` / `Weft.ts` — every AST citizen flows through
  `loomNode()`, no exceptions.
