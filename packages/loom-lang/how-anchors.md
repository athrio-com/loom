# Loom anchors — lexical resolution (Anchors v2)

This note specifies the anchor model that replaces the corpus-wide title index with
lexical, per-file resolution, and adds the directory anchor that places a book's
chapters. It is the design reference for the tokeniser and resolution changes (tasks
#13, #14); it folds into `architecture.md` and `how-lsp.md` in the unified spec pass.

## The problem

Today an anchor resolves by heading title against a corpus-wide index
(`sectionTitles` in `LoomCorpusAst`). Two consequences follow.

The titles are a global namespace. Within a `placeReachable` scope every title must
be unique, or `collidingTitles` faults. Loom source reuses titles freely — "The
module" heads 34 looms, "What this module draws on" heads 21 — so the index works
only because per-file tangle scopes each file to itself.

The book is blocked. A build-book places many looms in one scope; the shared titles
then collide across files, and the tangler refuses with a `TangleError`.

The fix is the move every module system made: resolve a name *in a file*, and name
the file when crossing one. Lexical scope, not a global symbol table.

## Three forms

| Written | Kind | Resolves to |
|---|---|---|
| `::[Name]` | Loom anchor, local | the section `Name` in *this* file |
| `::[Name](path.loom)` | Loom directory anchor | the file `path.loom`, placed as a chapter |
| `[text](path.loom#section)` | plain CommonMark link | nothing for Loom — Markdown navigation only |

The `::` sigil is the whole distinction. A `::` anchor is Loom's: it composes code or
places a chapter. A plain `[text](url)` carries no `::`, so the anchor scanner — which
keys on `::[` — never sees it. It stays prose and earns Markdown's own tooling.
`volar-service-markdown` already serves the prose plane, so a `[text](other.loom#section)`
link gets go-to and hover for free, the `#section` fragment included.

So the parenthesised path divides by sigil. On a `::` anchor the path names a `.loom`
file to place — the book's directory anchor, with no fragment. In a plain Markdown
link the path and its `#fragment` are ordinary navigation, and Loom never touches
them.

## The token

`WarpAnchorToken` gains an optional `target`: the `(…)` trailing the close, carrying a
`path` — a `.loom` file resolved relative to the anchor's own file. An absent target
marks a local anchor that resolves in this file. The `name` keeps its role as the
bracket text, the section title.

The anchor Probe regex extends to consume the optional group:
`/::\[[^\]]*\](?:\([^)]*\))?/g`. `constructAnchors` reads the `(…)` after the close as
the target path. There is no `#` to split — a fragment belongs to a Markdown link,
which carries no `::` and never reaches this scanner.

## Resolution is lexical

A local anchor `::[Name]` resolves `Name` in *this file's* section index. A directory
anchor `::[Name](path.loom)` resolves its `path` relative to the anchor's file and
takes that module as the placed chapter.

The corpus-wide `sectionTitles` index is retired as a *resolver*. A title need only be
unique *within a file*. `collidingTitles` shrinks to an intra-file check: two sections
in one file that normalise to one name, a real ambiguity for a local `::[Name]`.
Cross-file collisions vanish, because nothing resolves a bare title across files any
more — a chapter is named by its path.

`fromProduct` already resolves a `NameRef`'s `{path, name}` target across the corpus,
so the de re projection needs no change — only `bindAnchor` changes which `path` it
stamps onto the edge.

## Role by position

The plane comes from where the anchor sits.

- A **code-line** anchor composes, and only locally. It never takes a path: cross-module
  reuse is the target language's own `import`, not Loom transclusion, and keeping
  composition within-file preserves the type-resolution model where a fragment checks
  inside its root.
- An anchor in a **`[dir]`-sink's prose** places a chapter: `::[Chapter](path.loom)`
  places `path.loom` under the directory. The `[dir]` heading is the placement marker;
  the path names which file.
- An anchor in **any other prose** refers locally with `::[Name]`. Cross-file
  navigation is a plain Markdown link, not a `::` anchor.

## Migration

Existing within-file `::[Name]` anchors are unchanged — no target means local. The new
path form serves the book's chapter placement. The breaking change is retiring the
global index: any place that today reaches a section in *another* file by bare title
must either name a chapter's file with `::[Name](path.loom)` or, for prose navigation,
become a plain Markdown link.

## Implementation map

- **#13 — tokeniser and token.** `loom-tokens.loom`: `WarpAnchorToken` gains the
  optional `target` subtoken (a path). `loom-weft-tokeniser.loom`: extend the Probe and
  `constructAnchors` to read the trailing `(path)`. Plain Markdown links need no
  handling — they never match the scanner.
- **#14 — resolution.** `product-builder.loom`: `bindAnchor` resolves a target's path
  and stamps `NameRef.target.path`. `loom-corpus-ast.loom`: the sink tree's placement
  (`pointings`) and the navigation walks (`definitionAt`, `referencesAt`, `renameAt`)
  resolve by path; `collidingTitles` narrows to intra-file. The corpus-wide
  `sectionTitles` stops being a resolver.
