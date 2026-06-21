# Loom Execution — Running the Frame

This spec owns the layer that makes the frame real: Loom **runs** the generated
frame program, and running it produces the product. It covers `#loom/core` — the
composition contract the frame calls — the frame runner that executes a corpus,
and the way execution feeds both the de re projection and the editor's
invalidation. `architecture.md` frames the two planes and the pipeline;
`how-frame.md` owns how the frame is built; this spec owns what happens when the
frame is run.

## Why the frame runs

A `.loom` file is read along two planes. The **frame** is the de dicto plane: the
TypeScript program Loom synthesises to compose a file's sections — the
`Effect.Service` classes, their `compose` and `tangle` calls, the Warp wiring. The
**product** is the de re plane: the author's own code, each section in its own
language, carried as that section's `code`.

The frame is a program you run, and the value it computes is the product. Its
`Effect.Service` classes, its `core.compose(…)` calls, its self-wired composition
root all execute, and what they return is the de re.

Running the frame is the one composition. `ProductAst` is the value the frame
produces, not a parallel derivation a second pass rebuilds from the frame read as
data. There is one implementation, so nothing can drift.

## The composition contract

`#loom/core` is the module every frame imports. Its functions do not join text.
They construct the de re `ProductAst` — the `ComposedCode`, `Fragment`, and `Ref`
nodes a run builds from the frame.

A `fragment` is a literal span of product code with the `.loom` position it maps
back to. A `compose` call assembles one section's parts — its fragments and its
references — into the section's `ComposedCode`, stamping the section's corpus-wide
identity and its product language onto the result.

```typescript
export const fragment = (text: string, origin: Position): Fragment => …
export const compose = (
  origin: SectionId,
  languageId: string,
  ...parts: ReadonlyArray<Part>
): ComposedCode => …
```

A `refer` call is the transclusion edge, and it carries the design's central rule:
**composition refers, it never inlines by value.** A section reaches another
section's code by yielding it as a dependency, so `refer` receives that section's
own `ComposedCode` and reads its `origin` — the edge it builds holds only the
target's identity, never a copy of the target's parts. Running the reference
*proves* the wiring, because the dependency it reads came from a `yield*` that
Effect had to resolve against a real layer.

```typescript
export const refer = (code: { origin: SectionId }, anchor: Position): Ref => …   // { target: Some(code.origin), anchor }
```

An anchor that resolves to nothing is a frame fault, not a runtime one. The frame
renders `core.refer(name.code, anchor)` against a name nothing in scope defines, so
the type checker rejects it on the anchor — the same de dicto diagnostic a Warp to a
missing tag raises — and the run never reaches a valid de re for that section. The
de re stays disabled until the frame is correct; the diagnostic the author sees comes
from the type checker reading the frame, not from the run.

The prose channel keeps its peer. A `weave` call mirrors `compose`, assembling a
section's prose fragments and prose references into a `WovenProse` — the de re
prose, a first-class value beside the code, not a flattened string.

```typescript
export const weave = (origin: SectionId, ...parts: ReadonlyArray<ProsePart>): WovenProse => …
```

The `tangle` primitive is pure as well. It binds a composed result to a file path
and returns a plain descriptor — the path paired with its `ComposedCode` — writing
nothing.

```typescript
export const tangle = (path: string, code: ComposedCode): TangledFile => ({ path, code })
```

Because `tangle` writes nothing, the frame is safe to run in the editor. Running a
frame composes values and performs no input or output. The tangler does the writing
afterward, at the end of the world. The frame computes *what* to emit. The runtime
decides *whether* to emit it.

## One frame, two readings

The frame text does not fork for execution. The `FrameModule` renders once, and
that single text serves both planes.

The first reading is `fromFrame`, the de dicto projection the TypeScript checker
reads. The checker verifies composition correctness — that `compose`, `refer`, and
`fragment` are called with the right types, that every alias a reference uses
resolves, that the Service types line up. The product code rides inside a
backtick literal as an opaque string, exactly as it should: the checker never
type-checks product content, because that is the de re plane's work.

The second reading is execution. Stripping the frame's types and evaluating it
yields each section's `ComposedCode`. A fragment's `.loom` origin travels as a
literal position object baked into the frame — structural glue with no mapping of
its own — so the executed `ComposedCode` carries the source spans the de re
projection needs.

The third reading is `fromProduct`. It flattens a `ComposedCode` to the section's
product virtual code with its mappings, following `Ref` edges across the corpus and
cutting cycles with a visited set. Its input is the run's output.

This is why two readings are not two implementations. Every composition decision —
which fragment, which edge, in what order — lives in the one `FrameModule`.
`fromFrame` and execution are two algebras over that single model, the same way
`fromFrame` and `fromProduct` already are.

## The runner

The runner executes a corpus and returns its product. One runner serves the
editor and the tangler, so there is a single execution path, not one per caller.

It works in three steps. First it **strips** each module's frame of its types with
`stripTypeScriptTypes`, Node's built-in synchronous transpiler, memoised per module
so a keystroke re-strips only the file that changed. Then it **evaluates** the
stripped frame, resolving the frame's imports through an injected resolver:
`#loom/core` binds to the runnable core, `effect` to Effect, and a sibling
`./other.loom` to that module's already-evaluated frame. Modules evaluate in
dependency order, which the corpus walk already supplies, and each evaluated module
is memoised. Finally it **provides and collects**: it runs each module's generated
section manifest under the corpus's layers, gathering every section's
`ComposedCode` into `codeByPath`.

The manifest is the seam that reaches private sections. `FrameAstBuilder` emits one
generated effect per module that yields every section — exported and tagless alike —
and returns the module's `name → ComposedCode` map together with its tangle
descriptors. A tagless section is reachable here because the manifest is generated
*inside* the module, where the private class is in scope; the runner, standing
outside, could never name it. Running the manifest is the act that turns a frame
into a module's product.

The whole run is `Effect.runSync` over pure composition — no suspension, no input
or output — which is what lets it sit inside Volar's synchronous projection hook.

## The composition root, made corpus-wide

The runner wires every service in the corpus into one requirement-free context. A
service's `.Default` layer carries the dependencies its `yield*` calls declare, so
the runner must satisfy each before it builds the services that need it. Every frame
exports its services in `__services` for this. Each service is paired with its
`.Default` layer, the service class itself, and the classes it depends on. The
private sections are included too, since a private section is reachable from inside
the module the same way the manifest reaches it.

Each service is identified by its tag key: the module-qualified string its
`Effect.Service` declares, `<path>#<name>`. Two modules may each define a section
named `Bit`; their tag keys differ by path, so the two stay distinct services rather
than colliding on the bare name. A dependency is carried as the service class itself,
not as a name, so a cross-file `yield* Mul` resolves to the very `Mul` the importing
frame named — the runner reads that class's tag key to place it.

The runner gathers those exports across the whole corpus, sorts the services so a
dependency comes before the service that needs it, and folds them in that order:
each service is built with its already-built dependencies provided to it
(`Layer.provideMerge`). The dependency relation is a directed acyclic graph — a Warp
cycle is a diagnostic, never a built layer — so the sort always succeeds, and the
fold ends in one context that provides every service with no requirement left open.

This corrects the self-provision `how-frame.md` anticipated. Providing the merged
layer set to itself does not close the loop. Building the provided copy still demands
the very services it is meant to supply, so the run fails with the dependency unmet.
Wiring the graph in dependency order is what actually resolves it. The author still writes only sections and Warps; the runner
derives the order and the wiring from the graph the frame already carries.

## Total over execution

Running the frame is pure and total by construction. The core primitives are pure,
and a generated Service body only yields its dependencies, composes, and returns.
Nothing a generated frame does touches the world or fails to terminate.

A correct frame runs to a de re; an incorrect one does not, and the run says so by
producing nothing. When a Warp or anchor references a name nothing in scope defines,
the frame is well-formed but the reference is unbound: the type checker reports it on
the de dicto frame, and the run, reaching the unbound name, yields no de re. The
runner catches the failure so the editor never crashes, and the de re stays disabled
until the frame is correct. This is the division of labour. The type checker
diagnoses a frame that is valid but incorrect, and the run withholds a de re it cannot
soundly produce. A failed run is never a silent wrong answer. It is an absent one,
with the cause on the frame.

The failure is contained to one module. The runner builds and runs each module under
its own dependency cone, not one context shared across the corpus, and catches each
module's run on its own. So an unbound reference, or any fault in a module's cone,
costs that module its de re and leaves every other module's untouched. A single broken
frame disables its own product, never the corpus's.

What the runner can evaluate is the frame grammar the builder emits. It resolves three
imports — `#loom/core`, `effect`, and a sibling `.loom` by relative path — and rewrites
namespace, named, and side-effect imports together with `export class`, `export const`,
and `export function`. Product code stays opaque: it rides inside masked template
literals, so its own imports and exports never reach the rewrite. A frame that reaches
outside this grammar — an `import` of some other package, a default import, an
`export default` — has no resolution, so that module's de re is absent while the editor
still type-checks its frame. The generated frame stays well within this boundary; only
the `{Loom}` escape hatch can cross it.

That escape hatch is the one surface where the totality guarantee can break, since its
author code splices into the frame and runs at module load. One guard holds today. The
runner provides **no effectful layers** at keystroke time, so author code cannot acquire
a filesystem or network service through Effect while editing. Two more are planned and
not yet built. A step-and-time budget cuts a non-terminating `{Loom}` body rather than
letting it hang the editor. A diagnostic flags a `{Loom}` section that holds executable
statements rather than the declarations, imports, and types it is meant to carry. Until
those land, `{Loom}` is where Loom's guarantees stop, and its author code runs
unbudgeted.

## Execution and invalidation

Running a corpus on every keystroke would be wasteful if every change re-ran
everything. It does not, because of how references are built.

A `Ref` holds its target's identity, not its content. So a module's executed
`ComposedCode` depends only on its own frame, never on the bodies of the sections
it refers to. When `B` changes, `B`'s `ComposedCode` is recomputed, but `A`'s —
which refers to `B` — is byte-identical, because `A`'s edge to `B` was only ever
`B`'s `SectionId`. The runner memoises each module's `ComposedCode` and recomputes
just the module whose frame changed.

This is what lets the editor delegate invalidation to Volar, the design proved in
the previous session. After projecting a file, the plugin registers — through
`getAssociatedScript` — that the file depends on every module it transitively
imports. When `B`'s snapshot changes, Volar marks each registered dependent stale
and re-projects it. Re-projecting `A` re-runs `fromProduct`, which looks up `B`'s
freshly recomputed `ComposedCode` in `codeByPath` and inlines it, so `A`'s output
is fresh by construction. Loom keeps no reverse dependency graph; it evicts the
changed module from its memos so the next read recomputes against new bytes, and
Volar decides what re-projects.

The runner respects the same boundary the editor's `Source` does. Evaluating and
running a frame is pure computation over frames the build already produced from
disk; it calls no Volar API, so it never re-enters the projector mid-build. The
association is registered after the run, on the warm corpus, where the projection
it incidentally triggers is a cache hit rather than a re-entrant build.
