# Loom — Design Checkpoints and Implementation Plan

Read `LoomAst.ts` first. It is the primary specification and prompt for the
pipeline. Everything below records design decisions made since the last
implementation pass. Honour all of them.

---

## Checkpoints

### Pipeline

Four stages:

```
lineRanges.stream(text)        string → Effect<Stream<LineRange>, MixedEOL>
classify.classifyWefts(text)   Stream<LineRange> → Stream<LoomWeft>
tokenise.tokeniseWefts(text)   Stream<LoomWeft>  → Stream<LoomWeft>
documentBuilder.build          Stream<LoomWeft>  → Effect<LoomDocument>
```

`Loom.ast(text)` is the entry point. It never fails — `MixedEOL` is
caught and returned as a minimal LoomDocument with NOK root health.

### Error model — Health

Every AST node carries a required `health` field (draft). Tokens and Wefts
are stream-internal — they never reach the final document walk — so they
do not carry `health`. Diagnostics raised during classify/tokenise are
attached to the AST node those wefts contribute to.

```typescript
interface Health {
  readonly status:      "ok" | "error" | "warning"
  readonly diagnostics: ReadonlyArray<Diagnostic>
}

interface Diagnostic {
  readonly message:  string
  readonly position: Position
  readonly severity: "error" | "warning" | "info"
}
```

The AST speaks for itself. No separate diagnostic collector, no Ref service.
`MixedEOL` produces a document with NOK root health and a single positioned
diagnostic. All other structural errors (malformed tags, missing brackets,
invalid mode transitions) live in the `health` field of the relevant node.
A flat diagnostic list is derived by walking the AST and collecting nodes
where `health.status !== "ok"`.

### Weft vocabulary

`HeadingWeft` is dissolved into four specific kinds recognised at classify time:

- `ChapterHeadingWeft` — `#` only (level 1), requires tag + specifier
- `SectionHeadingWeft` — `##`+ (level 2+), tag/specifier optional
- `DependenciesHeadingWeft` — `##` + `[D]` tag, recognised by level + tag probe simultaneously
- `TangleHeadingWeft` — `##` + `[T]` tag, same recognition approach

All heading Wefts carry `texts: ReadonlyArray<TextToken>` — an array of
contiguous text segments, not a single token, because heading text can be
non-contiguous (e.g. `# [Loom] is written in {Loom}` has text after the tag).

`TildeWeft` inline content is prose only — never code.
`ArrowWeft` inline content is code only — never prose.

### AST hierarchy

`LoomAstBuilder.build` groups wefts into this hierarchy:

```
LoomDocument
  └── LoomChapter[]          (ChapterHeadingWeft — # level)
        ├── LoomSection[]    (SectionHeadingWeft — ##+ level)
        ├── LoomDependencies (DependenciesHeadingWeft — ## [D])
        └── LoomTangle       (TangleHeadingWeft — ## [T])
```

### LoomServicePlugin

A minimal `LoomServicePlugin` for `languageId: "loom"` is needed to surface
Loom structural diagnostics. It reads the `LoomDocument` from the root
`VirtualCode` and walks the AST collecting `health.status !== "ok"` nodes.

---

## Implementation order

Introduce features incrementally in this order. Do not skip ahead. Do not decide by yourself to move to the next item.

1. **`Health` and `Diagnostic` schemas** — add to `LoomDocument.ts`. Every
   existing token and node schema gains a required `health: HealthSchema` field.
   Update all existing schemas — `LoomHeading`, `LoomTag`, `LoomSpecifier`,
   `LoomArrow`, `LoomSection`, `LoomChapter`, `LoomDocument`.

2. **New AST nodes** — add `LoomDependencies` and `LoomTangle` schemas to
   `LoomDocument.ts`. Update `LoomChapter.children` to include them alongside
   `LoomSection`.

3. **Token schema updates** — add `TextTokenSchema`, `InlineCodeTokenSchema`,
   `InlineProseTokenSchema` to `LoomTokens.ts`. All position-only, with `Probe`
   annotations. Follow existing token conventions exactly.

4. **Weft schema rewrite** — apply the updated `LoomWefts.ts` prompt (already
   provided separately). Ensure every Weft kind is present, `texts` is an array,
   and the union is complete.

5. **`WeftClassifier.ts`** — implement `classifyWefts(text)` using
   `Stream.mapAccum` with `ParseContext`. Mode tracks prose/code/deps/tangle
   and current section kind. `DependenciesHeadingWeft` and `TangleHeadingWeft`
   are recognised at this stage — no later promotion.

6. **`WeftTokeniser.ts`** — implement `tokeniseWefts(text)` as a pure
   `Stream.map`. Per-kind probe expansion. Fills `texts[]`, `tag`, `specifier`,
   `code?`, `prose?` on each Weft. No mode state.

7. **`DocumentBuilder.ts`** — implement `build(Stream<LoomWeft>)` using
   `Stream.mapAccum` with a chapter accumulator. Groups wefts into the
   `LoomChapter` hierarchy. Sentinel flushes the final chapter. Folds into
   `LoomDocument` via `Stream.runFold`.

8. **`LoomAst.ts`** — wire the three services together as specified. Implement
   `emptyDocumentFor(err: MixedEOL)` producing a minimal `LoomDocument` with
   NOK root health.

---

## Do not

- Introduce a `ClassifiedLine` intermediate type — `LoomWeft` is the stream
  element between every stage.
- Implement Frame synthesis or `loomLanguagePlugin` projection — out of scope.