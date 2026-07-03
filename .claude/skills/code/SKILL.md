---
name: code
description: Loom's functional discipline for code — the rules, worked examples, and checklist for writing every component as pure functional programming with Effect (Effect.Service over Context.Tag, Match over if/else ladders and nested ternaries, Option over null, Array.* over loops, errors as data). The counterpart to the prose standard: apply it when writing or reviewing the code in any .loom corpus or any @athrio/* package, and check against its questions before presenting.
---

# Pure functional programming with Effect

In Loom, prose and code are equal layers of one product. The prose standard governs the prose, the layer a person reads. This standard governs the code, the layer that runs. The two meet at a boundary the prose standard draws itself. That standard judges code only by how it reads alongside its prose, and defers the rest to "the project's functional discipline." This standard is that discipline.

Every Loom package is pure functional programming with Effect, end to end. The standard holds for all of it: the code section of any `.loom` corpus, and the `@athrio/*` source those sections tangle to. You never hand-write the tangled source — you edit the corpus and re-tangle — but the code obeys the same rules wherever it lives.

CLAUDE.md states the rule plainly: "Practice pure FP with Effect … Compose via `Effect.gen` and `yield*`; let Layers wire dependencies." A few commitments sit behind it. A function is total and referentially transparent. The same input yields the same output, with no hidden effect. An effect is a value — a description Effect runs once, at the edge — not a thing that happens when you name it. An error is a value too, carried in the type. An illegal state is unrepresentable, so the compiler rejects it before a test can. Each rule below applies one of these commitments to a place where code in this repository tends to drift.

Apply the standard in three passes:

- **Before you write,** read every rule body below. Read the layer spec for what you are changing — `architecture.md`, `packages/loom-lang/src/ast/how-frame.md`, or `packages/loom-lang/how-lsp.md`. Then read a peer module in the same package. The rule names the shape; the peer shows it.
- **While you write,** build top-down from the entry point. Model each concern as a Service, compose with `pipe` and `Effect.gen`, and let the types carry absence and failure. Write the shape the rule describes, not an imperative shape translated into Effect.
- **Before you present,** run every closing question over your diff, then run `bunx tsc` and `bun test`. The types are where exhaustiveness and the schemas are checked, so a green compile is part of the standard, not separate from it.

Invoke the `/code` command to run this pass on demand.

A heading below only names its rule, and a closing question only checks it. The rule is the body. Read the body.

## An Effect runs once, at the edge

An Effect is a description of work, not the work. Naming it does nothing. Effect runs it. Every Loom process begins at one runtime entry point — `NodeRuntime.runMain(program)` in the CLI's `main` and in `LoomServer` — and the program stays a single Effect until that edge. Build top-down from there: entry point, then Services, then Layers, then composition.

Inside the program, compose. Reach a value with `Effect.flatMap` or a `yield*` in `Effect.gen`; never call `Effect.runSync` or `Effect.runPromise` to pull a value out and continue in plain imperative code. Running mid-flow severs the program from Effect's error channel, dependency context, and interruption.

One synchronous boundary in the codebase does run an effect in the middle: `LoomLanguagePlugin`'s `createVirtualCode` is a host API Volar calls synchronously, so a runtime captured at startup runs the effect right there. That is a foreign-boundary exception, named and isolated. Tests run effects at their own boundary too. Neither licenses `runSync` inside ordinary service code.

*The fault and its fix.*
- ✗ `const config = Effect.runSync(loadConfig); return build(config)`
- ✓ `loadConfig.pipe(Effect.flatMap((config) => build(config)))`

> Does the program start from a runtime entry point and stay one Effect until the edge? Is every `runSync`/`runPromise` at a true boundary — a synchronous host API or a test — never mid-flow?

## Every component is an `Effect.Service`

A Loom component is an `Effect.Service`: `class LoomMemo extends Effect.Service<LoomMemo>()("LoomMemo", { … })`. It comes in two forms. Use `succeed: { … }` when the methods are pure and synchronous, as `LoomConfig` and `FrameAstBuilder` are. Use `effect: Effect.gen(function* () { … })` when the service needs its own dependencies, as `PackageConfig` and `LoomCompiler` do.

`Effect.Service` gives three things together: the `.Default` Layer, typed injection through `yield*`, and the `dependencies` field. No `Context.Tag`, plain object, or bare class gives all three, and the codebase holds zero `Context.Tag`. When a service feels too heavy and a plain object feels simpler, that is the signal to learn `Effect.Service`, not to leave it — the simpler object loses the Layer, the injection, and the dependency wiring you will rebuild worse by hand.

*The fault and its fix.*
- ✗ `const PackageConfig = Context.GenericTag<PackageConfig>("PackageConfig")`, then a hand-written layer
- ✓ `class PackageConfig extends Effect.Service<PackageConfig>()("PackageConfig", { effect: Effect.gen(function* () { const config = yield* LoomConfig; return { … } }), dependencies: [LoomConfig.Default] }) {}`

> Is every component an `Effect.Service` with a `.Default` Layer? Did you reach for a `Context.Tag` or a plain object because the service felt hard?

## Layers wire the graph; you only yield

A service declares what it needs in `dependencies: [LoomConfig.Default, …]` and reaches each one with `const config = yield* LoomConfig` inside `Effect.gen`. It never imports a dependency and constructs it by hand. The Layer holds the wiring, so a service body reads as a list of what it uses, not a chain of what it builds.

At the entry point, assemble the graph once and provide it once. Compose independent services with `Layer.mergeAll`, and a dependency graph with `Layer.provide(child, parent)`. The CLI's `main` shows the shape: the command pipes through `Effect.provide(LoomTangler.Default)`, `Effect.provide(DocumentSource.Default)`, and the rest, and only then does `NodeRuntime.runMain` run it.

*The fault and its fix.*
- ✗ `const config = new LoomConfigImpl(); const pkg = new PackageConfigImpl(config)`
- ✓ `dependencies: [LoomConfig.Default]` on the service, `const config = yield* LoomConfig` in its body, and one `Effect.provide(…)` chain at the entry point

> Are dependencies declared in `dependencies` and reached with `yield*`? Is the graph assembled once in a Layer at the entry point rather than constructed at call sites?

## A model and its Builder

Every significant structure is a Schema **model** — `LoomDocument`, `FrameModule`, `LoomVirtualCode` — defined with `Schema.Struct`, `Schema.Union`, or the `loomNode` helper. The pass that produces a model is a **Builder**: an `Effect.Service` named `XxxBuilder` wrapping a pure function from one model to the next. `FrameAstBuilder.build` takes a `LoomDocument` and returns a `FrameModule`. The Builder is the pass.

Name the pass for its model, with "build" as the verb. The earlier agent nouns — `Transducer`, `Resolver`, `Synthesiser` — are gone, and the verbs `transduce`, `resolve`, `synthesise`, `render` no longer name passes. Construct a model node through its schema, not a bare object literal: `PreambleWeftSchema.make({ … })` fills the `type` tag from the schema's constructor default. A schema refined with `Schema.filter` does not propagate that default through the refinement, so there a literal is correct — `SpecifierLabelTokenSchema`, which constrains its `value`, is such a refined case.

*The fault and its fix.*
- ✗ `type FrameModule = { … }` as a plain type, plus a loose `function synthesise(doc) { … }`
- ✓ a `FrameModule` schema, paired with a `FrameAstBuilder` service whose `build(doc): Effect.Effect<FrameModule>` is the pass

> Is each structure a Schema model paired with an `XxxBuilder` service? Are nodes built through `.make`, not bare literals? Is the pass named for its model, not an agent verb?

## Make the illegal state unrepresentable

Model the domain so a wrong value cannot be built, rather than admitting it and checking for it later. A closed set of cases is a tagged union, not a string guarded at every use: `LoomWeftSchema` is a `Schema.Union` of the six weft kinds, and a value outside those six never exists to be checked. Parse untrusted input once, at the edge, with `Schema.decodeUnknownEither`, then carry the typed value inward where nothing re-validates it. Alexis King named the principle: parse, don't validate.

*The fault and its fix.*
- ✗ `weft: { kind: string }`, then `if (kind !== "arrow" && kind !== "tilde" && …) throw` at each use
- ✓ `Schema.Union(HeadingWeftSchema, ArrowWeftSchema, …)`, which admits only the kinds it lists

> Could an illegal value even be constructed? Is untrusted input parsed once at the edge into a typed model, rather than validated again and again downstream?

## An error is a value

An error is a value in the type, not an exception thrown past it. A single failure is a `Data.TaggedError` — `TangleError`, `ReadError` — carrying its own fields and `message`. A closed catalog of faults is a `Data.TaggedEnum`: `LoomFault` lists every Loom diagnostic, and its `describe` maps each tag to a message through an exhaustive `Match`. Raise a failure with `Effect.fail` or `yield*`, and recover by tag with `Effect.catchTag` or `Effect.catchTags`, so the type tells you which failures still remain. Do not `throw`, do not `catch (e)` and read its string, do not widen the error to `unknown`.

*The fault and its fix.*
- ✗ `throw new Error("cannot read " + path)`, caught later as `catch (e) { if (String(e).includes("read")) … }`
- ✓ `class ReadError extends Data.TaggedError("ReadError")<{ readonly path: Path; readonly cause: unknown }> {}`, recovered with `Effect.catchTag("ReadError", …)`

> Is every failure a tagged value, raised with `Effect.fail` and recovered by tag? Did you `throw`, or inspect an error's string, instead?

## One `Match` closes every case

When behavior turns on which case a value is, match the whole value once and let `Match.exhaustive` prove every case is handled. `modeOf` and `dispatchNode` are the shape: `Match.value(weft).pipe(Match.when({ type: "HeadingWeft" }, …), …, Match.exhaustive)`. On a `Data.TaggedEnum`, match the tag — `LoomFault.describe` runs `Match.value(fault).pipe(Match.tag("UnclosedDelimiter", …), …, Match.exhaustive)`.

The exhaustive close is the point. Add a case to the union and the `Match` fails to compile until you handle it. An `if`/`else if` ladder over the same cases compiles fine with one case missing and falls silently through to the wrong branch.

*The fault and its fix.*
- ✗ `if (w.type === "HeadingWeft") … else if (w.type === "ArrowWeft") … else …`
- ✓ `Match.value(w).pipe(Match.when({ type: "HeadingWeft" }, …), Match.when({ type: "ArrowWeft" }, …), …, Match.exhaustive)`

> Is union dispatch a single `Match` closed by `Match.exhaustive` (or `Match.orElse`), so a new case breaks the build rather than slipping through?

## The second `?` wants a `Match`

A single guard ternary is fine. `severity === "info" ? "ok" : severity` reads at a glance, and a flat guard clause at the top of a function body is fine too. The smell is one ternary nested inside another. `a ? x : b ? y : z` makes the reader track which branch they are in and where each `:` belongs, and it grows worse with every case added.

When you reach for the second `?`, switch to `Match`. Match on the value with `Match.when` or `Match.tag`, and each case becomes one branch, read top to bottom, with exhaustiveness checked. The value you are branching on is usually already a tagged union, so the `Match` is a direct translation.

*The fault and its fix.*
- ✗ `probe.kind === "arrow" ? makeArrow() : probe.kind === "tilde" ? makeTilde() : makeDefault()`
- ✓ `Match.value(probe).pipe(Match.when({ kind: "arrow" }, makeArrow), Match.when({ kind: "tilde" }, makeTilde), Match.orElse(makeDefault))`

> Any ternary nested inside another? A single guard is fine; the second `?` is the signal to switch to `Match`.

## Absence is an `Option`

An absent value is an `Option<A>`, not an `A | undefined`. Lift a nullable to an `Option` at its source with `Option.fromNullable` — a `Map.get` result above all — then stay in `Option` with `Option.map`, `Option.flatMap`, `Option.match`, and `Option.getOrElse`, and keep only the present members of a collection with `Array.filterMap`. `dependenciesOf` is the shape: `pipe(Option.fromNullable(modules.get(path)), Option.match({ onNone: () => [], onSome: (m) => m.imports }))`.

The compound nullable ternary is the smell. `a !== undefined && b !== undefined ? f(a, b) : fallback` is `Option.all([Option.fromNullable(a), Option.fromNullable(b)]).pipe(Option.map(([a, b]) => f(a, b)), Option.getOrElse(() => fallback))`. A single flat guard clause in a function body is still fine; the compound `&&` over two nullables is the one to replace.

*The fault and its fix.*
- ✗ `const m = modules.get(path); if (m !== undefined) return m.imports; return []`
- ✓ `pipe(Option.fromNullable(modules.get(path)), Option.match({ onNone: () => [], onSome: (m) => m.imports }))`

> Is each absent value an `Option`, lifted at its source? Any compound `&&`/`||` nullable ternary that `Option.all` and `Option.map` would express?

## No loop, no mutation

There is no `for`, no `while`, no `let` accumulator. A transformation is a `pipe` of `Array.map`, `Array.filter`, `Array.filterMap`, and `Array.flatMap`; a fold is `Array.reduce`. These are Effect's `Array` module — its data-last, immutable combinators imported from `effect`, not the global `Array`. `buildFrame` is the shape: `pipe(doc.sections, Array.map(buildMember(index, lang, modulePath)), Array.reduce(emptyFrame, appendMember), finaliseModule)`. Over a stream, the same shapes live on `Stream`.

Update without mutation. Extend a record by spreading it — `{ ...doc, sections: [...doc.sections, section] }` — and a map by copying it — `new Map(index).set(title, entry)`. The one `for` loop in the codebase, `lineOfOffset`, scans characters by code point for speed; it is a deliberate, isolated exception, and it is the only one.

*The fault and its fix.*
- ✗ `let out = []; for (const s of sections) { out.push(build(s)) } return out`
- ✓ `pipe(sections, Array.map(build))`

> Any `for`, `while`, or `let` accumulator that an `Array` combinator over `pipe` would express? Is each update a spread or a fresh `Map`, never a mutation in place?

## A function's name is its return

A function's name is a promise about what it returns. `probeOf` returns a `Probe`, `pieceOf` returns an `Option<CodePiece>`, `modeOf` returns a `Mode`. A function named `classifyPreambleLine` that also returns an `ArrowWeft` or a `TildeWeft` breaks the promise; narrow it to one return type, or name it for what it yields and return an `Option`.

When several recognizers compete for one input, order them by priority in a single pass and let the first match win, as `probeOf` tries heading, then arrow, then tilde, then plain. Do not split the recognizers across two passes — an "always applies" pass and a "sometimes applies" pass — that duplicates the priority order and hides it.

*The fault and its fix.*
- ✗ `classifyPreambleLine` returning an `ArrowWeft`, a `TildeWeft`, or a `PreambleWeft`
- ✓ `probeWeft` returning a `LoomWeft`, `pieceOf` returning an `Option<CodePiece>`

> Does each function's name name its return? Is a recognizer one priority-ordered pass with the first match winning, not two passes that re-rank the same cases?

## Read the peer; revise toward the shape

Before you add a file, read a peer in the same package and match its idioms — the service shape, the `pipe` style, how it names a fold and closes a `Match`. `WeftClassifier`, `FrameAstBuilder`, and `LoomFault` are the reference modules. A new file that ignores its neighbors reads as imported from another codebase.

When existing code and the target shape disagree, revise the whole thing toward the target. Do not bolt the new shape alongside the old — an `Option` path added "to be safe" beside the `undefined` path it was meant to replace leaves both, and the seam shows. And if a change breaks something that worked — a passing test, a resolved anchor, a highlighted section — the change is wrong: revert it and understand why before going on.

*The fault and its fix.*
- ✗ pasting a non-Effect snippet from elsewhere, or adding an `Option` branch next to the `undefined` branch it replaces
- ✓ opening `FrameAstBuilder`, following its Builder, `pipe`, and `Match` shape, and replacing the old shape whole

> Did you read a peer file first and match its idioms? Did you revise toward the shape rather than patch beside it? Did anything that worked before stop working?

## The final pass

Run every question over your diff, sentence by sentence and branch by branch, before you present. Then run `bunx tsc` and `bun test`. Each question's rule is its section above; when a check is unclear, read that section again.

- Does the program start from a runtime entry point and stay one Effect until the edge? Is every `runSync`/`runPromise` at a true boundary, never mid-flow?
- Is every component an `Effect.Service` with a `.Default` Layer? Did you reach for a `Context.Tag` or a plain object because the service felt hard?
- Are dependencies declared in `dependencies` and reached with `yield*`? Is the graph assembled once in a Layer at the entry point?
- Is each structure a Schema model paired with an `XxxBuilder` service? Are nodes built through `.make`? Is the pass named for its model, not an agent verb?
- Could an illegal value even be constructed? Is untrusted input parsed once at the edge, not validated repeatedly downstream?
- Is every failure a tagged value, raised with `Effect.fail` and recovered by tag? Did you `throw`, or read an error's string, instead?
- Is union dispatch a single `Match` closed by `Match.exhaustive`, so a new case breaks the build rather than slipping through?
- Any ternary nested inside another? The second `?` is the signal to switch to `Match`.
- Is each absent value an `Option`, lifted at its source? Any compound nullable ternary that `Option.all` and `Option.map` would express?
- Any `for`, `while`, or `let` accumulator that an `Array` combinator would express? Is each update a spread or a fresh `Map`, not a mutation?
- Does each function's name name its return? Is a recognizer one priority-ordered pass, first match winning?
- Did you read a peer file first and match its idioms? Did you revise toward the shape rather than patch beside it? Did anything that worked before stop working?

---

## Sources

- The Loom directives in `CLAUDE.md` — "Practice pure FP with Effect" and "Build top-down from the entry point."
- The Effect documentation (effect.website) — `Effect.Service`, `Layer`, `Match`, `Option`, `Schema`, `Data`.
- Alexis King, "Parse, Don't Validate" (2019).
- Yaron Minsky, "Effective ML" — make illegal states unrepresentable (Jane Street, 2011).
- Scott Wlaschin, "Railway Oriented Programming" — errors as values in a composed pipeline.
