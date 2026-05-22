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
{ type: <literal>, position: Position, health: Health, ...fields }
```

This means the walker recognises a node by the presence of `type` and recurses
into any field whose value has one. No three-vocabulary translation step; every
layer is a discriminable AST node.

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
the schema — schema constraints stay strict and the `health` field carries
the truth about what's known vs pending vs wrong.

The Classifier Stage routes purely on heading level and recognised probes —
no fallback to default Weft for malformed headings. When a schema field is
structurally required but cannot be filled at the Classifier Stage (the
ChapterHeading filter requires `tag` and `specifier`), the classifier emits
**NOK placeholder tokens** carrying `health.status === "incomplete"` at
zero-width-EOL positions. The schema filter is satisfied; the health field
communicates that the subnodes are stand-ins.

The Tokeniser Stage walks each weft, tokenises subtokens from the source,
and constructs the strict-schema target via `Schema.make`. On success it
replaces placeholders with real tokens and promotes the weft's health to
`ok`. On failure (multi-tag, missing required content, etc.) the `ParseError`
is converted into a `Diagnostic` and the weft's health flips to `error`. The
schema is the source of truth; NOK→error propagation falls out of validation
failures rather than hand-coded checks.

Example: `# Chapter I` produces a `ChapterHeadingWeft` (schema-valid,
`incompleteHealth`) carrying NOK `Tag` and `Specifier` placeholders, all
with `incompleteHealth`. The Tokeniser Stage either fills them with real
tokens (promoting the weft to `ok`) or, if the source has no tag, surfaces
the missing-structure `ParseError` as an `error`-status diagnostic on the
weft. `Schema.is(LoomDocument)` holds end-to-end at every stage; the health
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

`HeadingWeft` is dissolved into four specific kinds. Only two are emitted
by the Classifier Stage; the other two emerge from the Tokeniser Stage via
schema-driven promotion of `SectionHeadingWeft`.

- `ChapterHeadingWeft` — `#` only (level 1), requires tag + specifier.
  Emitted by the Classifier Stage with NOK placeholder tag/specifier tokens
  when the source has not yet been tokenised.
- `SectionHeadingWeft` — `##`+ (level 2+), tag/specifier optional. Emitted
  by the Classifier Stage for every `##…` line, regardless of tag content.
- `DependenciesHeadingWeft` — `##`+ with tag `[D]`. The Tokeniser Stage
  promotes a Section to Deps when its single tokenised tag is `[D]`; the
  schema's `tag.label.value === "D"` filter guards the promotion. Multi-tag
  or wrong-tag conditions surface as `error` health on the weft via the
  `ParseError` from a failed `Schema.make`.
- `TangleHeadingWeft` — `##`+ with tag `[T]`, same promotion mechanism.

All heading Wefts carry `texts: ReadonlyArray<TextToken>` — an array of
contiguous text segments, not a single token, because heading text can be
non-contiguous (e.g. `# [Loom] is written in {Loom}` has text after the tag
and before the specifier).

Body Wefts:

- `PreambleWeft` — line in Preamble mode (default after heading). Subtokens
  TBD.
- `ProseWeft` — line in Prose mode (after a Tilde transition). Subtokens TBD.
- `CodeWeft` — line in Code mode (after an Arrow transition). Opaque to
  Loom; embedded-language tokenisation happens elsewhere.
- `ArrowWeft` — the `=>` line. Carries `arrow: ArrowToken` and optional
  `code: CodeToken`.
- `TildeWeft` — the `~` line. Carries `tilde: TildeToken` and optional
  `prose: ProseToken`.
- `DependencyWeft` — line in a LoomDependencies body. Subtokens TBD.
- `TangleWeft` — line in a LoomTangle body. Subtokens TBD.
- `Weft` (default) — any line without recognised structure.

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

5. **`WeftClassifier.ts`** — the Classifier Stage. Implemented as a Mealy
   machine over `(Mode, Probe)`. Mode is derived from the previous Weft via
   `modeOf`; probe is pure pattern recognition over the line text. Decision
   table laid out as `Match.exhaustive` on Mode with probe-narrowing inside
   the preamble/code rows. Universal heading patterns (chapter, section)
   handled with early returns. Emission set narrowed to `ClassifierStageWeft`
   — the eight kinds reachable here. `DependenciesHeadingWeft` and
   `TangleHeadingWeft` are **not** emitted; promotion is the Tokeniser
   Stage's job. Wefts carry `incompleteHealth`; `ChapterHeadingWeft`
   additionally carries NOK placeholder tag/specifier tokens (all at
   zero-width EOL, all `incompleteHealth`) so the schema filter is satisfied
   without pretending the subnodes are real. Schema filters stay strict —
   the placeholder mechanism is the Classifier Stage's only device for
   missing fields.

   Landed alongside: `incomplete` health status + `incompleteHealth`
   constant in `LoomNode.ts`; `loomNode`'s `type` field gets
   `withConstructorDefault` so `Schema.make` auto-fills the tag on
   unrefined schemas (filtered schemas still need `type` passed
   explicitly). Unit and integration tests under
   `WeftClassifier.test.ts` and `WeftClassifier.integration.test.ts`;
   dev probe at `scripts/classify-loom.ts`.

### Remaining

6. **`WeftTokeniser.ts`** — the Tokeniser Stage. Implement
   `tokeniseWefts(text)` as a pure `Stream.map`. Two responsibilities:

   (a) **Per-kind subtoken expansion.** Tokenise `texts[]`, `tag`,
       `specifier`, `code?`, `prose?` from the source. Replace NOK
       placeholders on ChapterHeadingWeft with the real tokens.

   (b) **Schema-driven promotion.** When a `SectionHeadingWeft` tokenises
       to exactly one reserved tag (`[D]` or `[T]`), construct the target
       `DependenciesHeadingWeft` / `TangleHeadingWeft` via `Schema.make`.
       The schema filter (`tag.label.value === "D"` / `"T"`) accepts on
       success; on any violation (multi-tag, wrong label, etc.) the
       `ParseError` is adapted into a `Diagnostic` (via
       `ParseResult.ArrayFormatter`) and attached to the weft's
       `health.diagnostics` with `status: "error"`.

   No mode state — purely `(text, weft) → weft'`. Health transitions:
   `incomplete → ok` on full tokenisation, `incomplete → error` on failure.

7. **`LoomAstBuilder.ts`** — implement `build(Stream<LoomWeft>)` using
   `Stream.mapAccum` with a chapter accumulator. Groups wefts into the
   `LoomChapter` hierarchy: ChapterHeadingWeft flushes the previous chapter;
   sentinel flushes the final. Inside a chapter, the same accumulator
   pattern groups wefts into Section / Dependencies / Tangle. Folds into
   `LoomDocument` via `Stream.runFold`.

8. **`Loom.ts` (orchestrator)** — already wired with `LoomSourceRanges` +
   the three stage Services. `emptyDocumentFor(err: MixedEOL)` already
   produces a minimal LoomDocument with NOK root health. Re-verify once
   steps 6–7 land that the pipeline composes end-to-end.

---

## Do not

- Introduce a `ClassifiedLine` intermediate type — `LoomWeft` is the stream
  element between every stage.
- Implement Frame synthesis or `loomLanguagePlugin` projection — out of
  scope for the AST pipeline.
- Reintroduce parallel non-`loomNode` schemas in `LoomAst.ts` /
  `LoomTokens.ts` / `Weft.ts` — every AST citizen flows through
  `loomNode()`, no exceptions.
