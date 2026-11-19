---
name: code
description: Loom's functional discipline for code — the rules, worked examples, and checklist for writing every component as pure functional programming with Effect (Context.Service over Context.Tag, a table or a Match over if/else ladders and nested ternaries, Option over null, an array's own methods and Effect's Array over loops, errors as data). The counterpart to the prose standard: apply it when writing or reviewing the code in any .loom corpus or any @athrio/* package, and check against its questions before presenting.
---

# Pure functional programming with Effect

In Loom, prose and code are equal layers of one product. The prose standard governs the prose, the layer a person reads. This standard governs the code, the layer that runs. The two meet at a boundary the prose standard draws itself. That standard judges code only by how it reads alongside its prose, and defers the rest to "the project's functional discipline." This standard is that discipline.

Every Loom package is pure functional programming with Effect, end to end. The standard holds for all of it: the code section of any `.loom` corpus, and the `@athrio/*` source those sections tangle to. You never hand-write the tangled source — you edit the corpus and re-tangle — but the code obeys the same rules wherever it lives.

Loom runs on Effect v4 (the `effect` package, the `4.1` line). The stable modules — `Schema`, `Match`, `Stream`, `Data`, `Effect`, `Layer`, `Option`, `Result`, `Array`, `Context`, `ManagedRuntime`, `FileSystem` — all import from the root `"effect"`; the CLI framework lives at `effect/unstable/cli`, and `@effect/platform-bun` (for `BunRuntime`, `BunServices`) stays a separate package. This matters because Effect v3 idioms are close but not identical: a v3 habit — `Effect.Service`, `.Default`, `Option.fromNullable`, `Array.filterMap` over an `Option` — will type-check wrong or not at all. The rules below are written to v4.

CLAUDE.md states the rule plainly: "Practice pure FP with Effect … Compose via `Effect.gen` and `yield*`; let Layers wire dependencies." A few commitments sit behind it. A function is total and referentially transparent. The same input yields the same output, with no hidden effect. An effect is a value — a description Effect runs once, at the edge — not a thing that happens when you name it. An error is a value too, carried in the type. An illegal state is unrepresentable, so the compiler rejects it before a test can. Each rule below applies one of these commitments to a place where code in this repository tends to drift.

Apply the standard in three passes:

- **Before you write,** read every rule body below. Read the chapter of the book for the layer you are changing — the shape of a loom (the AST), reading the text (the parser), the product, tangling, or the editor — because the book is Loom's only specification. Then read a peer module in the same package. The rule names the shape; the chapter gives the intent; the peer shows the idiom.
- **While you write,** build top-down from the entry point. Model each concern as a Service, compose with `pipe` and `Effect.gen`, and let the types carry absence and failure. Write the shape the rule describes, not an imperative shape translated into Effect.
- **Before you present,** run every closing question over your diff, then run `bunx tsc` and `bun test`. The types are where exhaustiveness and the schemas are checked, so a green compile is part of the standard, not separate from it.

Invoke the `/code` command to run this pass on demand.

A heading below only names its rule, and a closing question only checks it. The rule is the body. Read the body.

## An Effect runs once, at the edge

An Effect is a description of work, not the work. Naming it does nothing. Effect runs it. Every Loom process begins at one runtime edge and stays a single Effect until it. The CLI's `main` composes one `program` and hands it to `BunRuntime.runMain(program)`. The language server is a long-lived host: `LoomServer` builds a `ManagedRuntime` once at startup and answers Volar's synchronous calls through it. Build top-down from that edge: entry point, then Services, then Layers, then composition.

Inside the program, compose. Reach a value with `Effect.flatMap` or a `yield*` in `Effect.gen`; never call `Effect.runSync` or `Effect.runPromise` to pull a value out and continue in plain imperative code. Running mid-flow severs the program from Effect's error channel, dependency context, and interruption.

One synchronous boundary in the codebase does run an effect in the middle: `LoomLanguagePlugin`'s `createVirtualCode` is a host API Volar calls synchronously, so the `ManagedRuntime` captured at startup runs the effect right there with `runtime.runSync(…)`. That is a foreign-boundary exception, named and isolated — a `ManagedRuntime` exists precisely to bridge Effect to a synchronous host. Tests run effects at their own boundary too. Neither licenses `runSync` inside ordinary service code.

*The fault and its fix.*
- ✗ `const config = Effect.runSync(loadConfig); return build(config)`
- ✓ `loadConfig.pipe(Effect.flatMap((config) => build(config)))`

> Does the program start from a runtime edge — `BunRuntime.runMain` or a startup `ManagedRuntime` — and stay one Effect until it? Is every `runSync`/`runPromise` at a true boundary — a synchronous host API or a test — never mid-flow?

## Every component is a `Context.Service`

A Loom component is a `Context.Service`: `class LoomMemo extends Context.Service<LoomMemo>()("LoomMemo", { … })`. One `make:` field holds an Effect that produces the service's methods. Use `make: Effect.succeed({ … })` when the methods are pure and synchronous, as `LoomConfig` is. Use `make: Effect.gen(function* () { … })` when the service needs its own dependencies or its own state, as `PackageConfig`, `LoomCompiler`, and `LoomMemo` do. The service then declares its Layer by hand: `static readonly layer = Layer.effect(this, this.make)`.

`Context.Service` is v4's successor to v3's `Effect.Service` — same intent, changed shape. The `.Default` layer and the `dependencies:` field that `Effect.Service` generated are gone: you write `static readonly layer` yourself and wire dependencies into it with `Layer.provide`. What it still gives is a named tag and typed injection through `yield*`. No `Context.Tag`, plain object, or bare class gives that with a Layer, and the codebase holds zero `Context.Tag`. When a service feels too heavy and a plain object feels simpler, that is the signal to learn `Context.Service`, not to leave it — the simpler object loses the Layer, the injection, and the dependency wiring you will rebuild worse by hand.

*The fault and its fix.*
- ✗ `const PackageConfig = Context.GenericTag<PackageConfig>("PackageConfig")`, then a hand-written layer, or a lingering v3 `Effect.Service<…>()(…, { effect, dependencies })`
- ✓ `class PackageConfig extends Context.Service<PackageConfig>()("PackageConfig", { make: Effect.gen(function* () { const config = yield* LoomConfig; return { … } }) }) { static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(LoomConfig.layer)) }`

> Is every component a `Context.Service` with an explicit `static readonly layer`? Did you reach for a `Context.Tag`, a plain object, or a stale `Effect.Service`/`.Default` because the service felt hard?

## Layers wire the graph; you only yield

A service reaches a dependency with `const config = yield* LoomConfig` inside its `make` `Effect.gen`, and wires that dependency into its own Layer with `Layer.provide(LoomConfig.layer)`. It never imports a dependency and constructs it by hand. The `.layer` holds the wiring, so a service body reads as a list of what it uses, not a chain of what it builds.

At the entry point, assemble the graph once and provide it once. Compose independent services with `Layer.mergeAll`, and a dependency graph with `Layer.provide`. The CLI's `main` shows the shape: `program` pipes through `Effect.provide(LoomTangler.layer)`, `Effect.provide(DocumentSource.layer)`, `Effect.provide(PackageConfig.layer)`, and the rest, and only then does `BunRuntime.runMain` run it. `ManagedRuntime.make` takes the same closed layer — mergeAll the roots, then `Layer.provide` each dependency under them.

*The fault and its fix.*
- ✗ `const config = new LoomConfigImpl(); const pkg = new PackageConfigImpl(config)`
- ✓ `const config = yield* LoomConfig` in the service's `make`, `Layer.provide(LoomConfig.layer)` on its `static readonly layer`, and one `Effect.provide(…)` chain at the entry point

> Is each dependency reached with `yield*` and wired through `Layer.provide` in the service's own `.layer`? Is the graph assembled once at the entry point rather than constructed at call sites?

## A model and its Builder

Every significant structure is a Schema **model** — `LoomDocument`, `Product`, `LoomVirtualCode` — defined with `Schema.Struct`, `Schema.Union`, or the `loomNode` helper. The pass that produces a model is a **Builder**: a `Context.Service` named `XxxBuilder` wrapping a pure function from one model to the next. `LoomAstBuilder.build` takes a loom's wefts and returns a `ParsedDocument`; `ProductBuilder.build` turns a module's sections into its `Product`. The Builder is the pass.

Name the pass for its model, with "build" as the verb. The earlier agent nouns — `Transducer`, `Resolver`, `Synthesiser` — are gone, and the verbs `transduce`, `resolve`, `synthesise`, `render` no longer name passes.

*The fault and its fix.*
- ✗ `type Product = { … }` as a plain type, plus a loose `function produce(module) { … }`
- ✓ a `ParsedDocument` schema, paired with a `LoomAstBuilder` service whose `build(wefts): ParsedDocument` is the pass

> Is each structure a Schema model paired with an `XxxBuilder` service? Is the pass named for its model, not an agent verb?

## A node is constructed with `nodeOf`

A node is a model value that carries a `type` tag: a weft, a token, a section, a product fragment, a woven block. Construct one through its schema with `nodeOf`, from `LoomNode`: `nodeOf(PreambleWeftSchema, { … })`. `nodeOf` reads the tag the schema declares and writes it onto the fields. The schema names the node at the place it is constructed, and the compiler checks every field against the schema's type. A bare object literal with a hand-written `type` loses both.

Do not construct a node through its schema's `.make`. That method walks the whole schema on every call, to fill in defaults and run checks, and the walk costs about ten times what the node costs to construct: about 1,080 ns against 100 ns, measured on a code weft. Loom constructs a node for every token of every line, on every keystroke, so `.make` took about a quarter of a build. All it added to a node was the tag, because the compiler had already checked the fields. For the same reason a node schema carries no constructor default beyond its tag: `nodeOf` fills none in, so the caller writes every field, a product node's `health` included.

A structure with no tag, such as a `Product`, a `WovenPage`, or a `TocChapter`, has nothing for a schema to write. Construct it as an object literal in a typed position: the body of an arrow with a return type, or a `const` with an annotation.

`nodeOf` checks nothing while the program runs, so it suits a value the program itself makes. Decode instead, with `Schema.decodeUnknownResult`, in two places. One is the edge, where a value arrives from outside the program, such as a manifest or a configuration file. The other is where a value's fit is the very question: `buildSpecifierLabel` decodes a label to learn whether it is well formed, and constructs a faulted token with `nodeOf` when it is not.

*The fault and its fix.*
- ✗ `CodeWeftSchema.make({ …weft, health: okHealth })`, or `{ type: "CodeWeft", …weft, health: okHealth }`
- ✓ `nodeOf(CodeWeftSchema, { …weft, health: okHealth })`, and for a structure with no tag, `(page): WovenNavEntry => ({ number: "", title: page.title, slug: page.slug })`

> Is every node constructed with `nodeOf`, not through `.make` and not as a bare literal with a hand-written tag? Is a structure with no tag a literal in a typed position? Is a value decoded only at the edge, or where its fit is the question?

## Make the illegal state unrepresentable

Model the domain so a wrong value cannot be built, rather than admitting it and checking for it later. A closed set of cases is a tagged union, not a string guarded at every use: `LoomWeftSchema` is a `Schema.Union` of the weft kinds, and a value outside them never exists to be checked. Parse untrusted input once, at the edge, with `Schema.decodeUnknownResult`, then carry the typed value inward where nothing re-validates it. Alexis King named the principle: parse, don't validate.

*The fault and its fix.*
- ✗ `weft: { kind: string }`, then `if (kind !== "arrow" && kind !== "tilde" && …) throw` at each use
- ✓ `Schema.Union([HeadingWeftSchema, ArrowWeftSchema, …])`, which admits only the kinds it lists

> Could an illegal value even be constructed? Is untrusted input parsed once at the edge into a typed model, rather than validated again and again downstream?

## An error is a value

An error is a value in the type, not an exception thrown past it. A single failure is a `Data.TaggedError` — `TangleError`, `ReadError` — carrying its own fields and `message`. A closed catalog of faults is a `Data.TaggedEnum`: `LoomFault` lists every Loom diagnostic, and its `describe` maps each tag to a message through the enumeration's own exhaustive `$match`. Raise a failure with `Effect.fail` or `yield*`, and recover by tag with `Effect.catchTag` or `Effect.catchTags`, so the type tells you which failures still remain. Do not `throw`, do not `catch (e)` and read its string, do not widen the error to `unknown`.

*The fault and its fix.*
- ✗ `throw new Error("cannot read " + path)`, caught later as `catch (e) { if (String(e).includes("read")) … }`
- ✓ `class ReadError extends Data.TaggedError("ReadError")<{ readonly path: Path; readonly cause: unknown }> {}`, recovered with `Effect.catchTag("ReadError", …)`

> Is every failure a tagged value, raised with `Effect.fail` and recovered by tag? Did you `throw`, or inspect an error's string, instead?

## Every case is closed in one place

When behavior turns on which case a value is, dispatch on the whole value once, in one place the compiler can close. Add a case to the union and that place fails to compile until you handle it. An `if`/`else if` ladder over the same cases compiles fine with one case missing and falls silently through to the wrong branch.

Which construct closes the cases depends on what they read. Where every case names only the kind of node, a table closes them, and the next rule says how. A `Data.TaggedEnum` carries an exhaustive table of its own, `$match`, which takes one case for every tag: `Place.$match(place, { Book: …, Part: …, Chapter: …, Section: …, Box: … })`. `describe` reads every fault through the one `LoomFault` gives, kept as `matchFault`. Where a case reads more than a tag, a `Match` closed by `Match.exhaustive` does it: `Match.type<Facts>().pipe(Match.when({ codeless: true }, …), Match.when({ written: false, whole: true }, …), …, Match.exhaustive)`.

*The fault and its fix.*
- ✗ `if (w.type === "HeadingWeft") … else if (w.type === "ArrowWeft") … else …`
- ✓ `byType<LoomWeft>()({ HeadingWeft: …, ArrowWeft: …, … })`, which fails to compile while a tag has no case

> Is every dispatch on a union written once, in a table or a `Match` the compiler closes, so a new case breaks the build rather than slipping through?

## A node is told apart by a table

Most dispatch in Loom asks one question: which kind of node is this? A matcher answers it by trying its cases in turn. A matcher of nine cases takes about 130 ns to answer, and running matchers once took a fifth of every keystroke. A table answers by reading one property: its cases are a record keyed by the tag, and a call takes the case under the node's own tag, in about 20 ns.

So wherever every case names only a node's `type`, the cases are a table, built once at module scope with `byType`, from `LoomNode`: `const modeAfter: (weft: LoomWeft) => Mode = byType<LoomWeft>()({ HeadingWeft: () => "preamble", ArrowWeft: () => "code", … })`. The compiler demands a case for every tag of the union, refuses a tag the union does not hold, and hands each case the node of its own tag. `byType` is to a node what `$match` is to a tagged enum.

Three things complete the form.

- **Some tags share a default.** `byTypeOr` takes the cases that differ and a default for the rest: `byTypeOr<LoomWeft, [inBox: boolean]>()({ PreambleWeft: …, ProseWeft: … }, (weft) => weft)`.
- **A case needs more than the node.** The second type argument names the further arguments, and a call passes them after the node: `byType<Part, [within: Within]>()({ Fragment: (fragment, { home }) => …, … })`, called as `inlinePart(part, { modules, home, … })`. A case names only the arguments it reads.
- **The cases give different members of one union.** State the result after the first call, `byTypeOr<Probe, Line>()<LoomWeft>(…)`, or on the constant, since the compiler otherwise takes the first case's type for all of them.

A node that may be absent is lifted first, and the table reads what is there: `Option.exists(Option.fromNullishOr(anchor.specifier), namesModuleKind)`.

A value that is no union at all, such as an `unknown` that may be an array, a node, or neither, has nothing for the compiler to close. Guard clauses at the top of the function tell it apart, as the tree fold's `walked` does: `if (Array.isArray(value)) return walkedItems(value, cases)`, then `if (!isNode(value)) return value`.

A `Match` stays for cases that read more than a node's tag: a pattern on another field, such as `{ type: "FenceWeft", side: "open" }`, a predicate, a literal, or a fact the selector worked out. The website builds on Effect alone and holds no node of the foundation, so a matcher built once tells its values apart.

*The fault and its fix.*
- ✗ `Match.type<LoomWeft>().pipe(Match.when({ type: "HeadingWeft" }, () => "preamble" as const), Match.when({ type: "ArrowWeft" }, () => "code" as const), …, Match.exhaustive)`
- ✓ `byType<LoomWeft>()({ HeadingWeft: () => "preamble", ArrowWeft: () => "code", … })`

> Does every case name only a node's `type`? Then are the cases a table built with `byType` or `byTypeOr`, and is a value that is no union told apart by guard clauses?

## A matcher is built once

A matcher is a value, and building one costs far more than running it. `Match.value(x).pipe(Match.when(…), …)` builds a matcher for the one value `x`, runs it, and throws it away, so a function written that way builds its matcher again on every call. With nine cases that is about 1,750 ns a call. The same matcher built once runs in about 120 ns. Matchers rebuilt on every call once took a sixth of a tangle of Loom's own book.

So Loom does not use `Match.value`, or `Match.valueTags`, anywhere: not in a parser, not in a command, not in a test. One rule is easier to keep than a rule with an exception, and no reader has to judge how often a function runs. Every matcher is built once, at module scope, and called as a function. Which constructor builds it depends on what the cases read.

- **The cases read the matched value alone.** `Match.type<T>()` matches its one argument. `const verdictOf = Match.type<ReturnType<Ignore["test"]>>().pipe(Match.when({ ignored: true }, () => Option.some(true)), Match.when({ unignored: true }, () => Option.some(false)), Match.orElse(() => Option.none<boolean>()))`.
- **The cases read one or two other values.** `Match.fn(select)` builds a matcher over a function's arguments. Its selector picks the argument to match, and each case receives the matched value first and then every argument. Put the matched argument last, so a case names only the arguments it reads: `const nextFenced = Match.fn((_fenced: Option.Option<Fence>, weft: LoomWeft) => weft).pipe(Match.when({ type: "FenceWeft", side: "open" }, (open) => openingFence(open.source)), Match.when({ type: "FenceWeft", side: "close" }, () => Option.none<Fence>()), Match.orElse((_weft, fenced) => fenced))`.
- **The cases read many values of the function they came from.** Hand those over as one record, the first argument, and a case takes from it what it reads: `const readingAt = Match.fn((_within: { readonly full: Path; readonly scope: Scope }, entry: { readonly opened: boolean; readonly closed: boolean; readonly kept: boolean }) => entry).pipe(Match.when({ opened: true }, (_entry, { full, scope }) => …), …)`, called as `readingAt({ full, scope }, { opened, closed, kept })`. A row of underscored arguments in every case is the sign that the record is wanted.
- **The value is a `Data.TaggedEnum`.** Its own `$match` builds nothing, so it may stand anywhere, inside a function body too, and its cases close over whatever they like: `Place.$match(place, { Book: ({ book }) => bookSteps(Option.some(book)), … })`.

Four things follow from building a matcher before any value exists.

A pattern cannot read a value of the call. Where a case would test one, the selector works the facts out first and the patterns read the facts: `Match.fn((line: string, delims: AnchorDelims) => ({ blank: line.trim() === "", fixed: … })).pipe(Match.when({ blank: true }, () => "blank" as const), …)`.

A matcher that calls itself states its own type, `const misfitsIn: (kind: string, issue: SchemaIssue.Issue, path: Path) => ReadonlyArray<Misfit> = Match.fn(…)`, because the compiler cannot infer a type from its own use. Any other matcher states what it returns with `Match.withReturnType<R>()` as its first step, which also types each case's result.

`Match.tagsExhaustive` hands its cases no arguments beyond the matched value. A table that needs one, such as a Foldkit `update` that needs the model, gives a function of it from every case: `Match.type<Message>().pipe(Match.withReturnType<(model: Model) => Step>(), Match.tagsExhaustive({ Ticked: ({ delta }) => (model) => stepped(model, delta), … }))`, called as `stepFor(message)(model)`.

A matcher over a record with nested patterns, such as `{ weft: { type: "FenceWeft" } }`, cannot be closed by `Match.exhaustive`. Match the union itself with `Match.fn` instead.

A matcher whose every case names only a node's `type` is no matcher at all under the rule before this one. It is a table.

*The fault and its fix.*
- ✗ `const nextFenced = (fenced, weft) => Match.value(weft).pipe(Match.when({ type: "FenceWeft", side: "open" }, (open) => openingFence(open.source)), Match.orElse(() => fenced))`
- ✓ `const nextFenced = Match.fn((_fenced: Option.Option<Fence>, weft: LoomWeft) => weft).pipe(Match.when({ type: "FenceWeft", side: "open" }, (open) => openingFence(open.source)), Match.orElse((_weft, fenced) => fenced))`

> Is every matcher built once at module scope, with `Match.type` or `Match.fn`, or is the value a tagged enum read through its own `$match`? Is there a `Match.value` or a `Match.valueTags` anywhere? Does any matcher name only a node's `type` in every case?

## The second `?` wants a `Match`

A single guard ternary is fine. `severity === "info" ? "ok" : severity` reads at a glance, and a flat guard clause at the top of a function body is fine too. The smell is one ternary nested inside another. `a ? x : b ? y : z` makes the reader track which branch they are in and where each `:` belongs, and it grows worse with every case added.

When you reach for the second `?`, switch to a table or a `Match`. Each case becomes one branch, read top to bottom, with exhaustiveness checked. The value you are branching on is usually already a tagged union, so a table keyed by its tag is a direct translation, and a `Match` serves where a case reads more than the tag.

*The fault and its fix.*
- ✗ `probe.type === "arrow" ? makeArrow() : probe.type === "tilde" ? makeTilde() : makeDefault()`
- ✓ `byTypeOr<Probe>()({ arrow: makeArrow, tilde: makeTilde }, makeDefault)`, a table, since a probe is tagged by `type` and each case names only the tag

> Any ternary nested inside another? A single guard is fine; the second `?` is the signal to switch to a table or a `Match`.

## Absence is an `Option`

An absent value is an `Option<A>`, not an `A | undefined`. Lift a nullable to an `Option` at its source with `Option.fromNullishOr` — a `Map.get` result above all — then stay in `Option` with `Option.map`, `Option.flatMap`, `Option.match`, and `Option.getOrElse`. `LoomMemo.get` is the shape: `Option.match(Option.fromNullishOr(s.modules.get(path)), { onSome: (module) => …, onNone: () => … })`. To keep only the present members of a collection, map to `Option` and then `Array.getSomes`: `ProductBuilder` does `Array.getSomes(block.map(pieceOf))`, where `pieceOf` returns an `Option<CodePiece>`. (In v4 `Array.filterMap` takes a `Result`-returning function, not an `Option`-returning one, so map and then reach for `Array.getSomes` when your step yields an `Option`.)

The compound nullable ternary is the smell. `a !== undefined && b !== undefined ? f(a, b) : fallback` is `Option.all([Option.fromNullishOr(a), Option.fromNullishOr(b)]).pipe(Option.map(([a, b]) => f(a, b)), Option.getOrElse(() => fallback))`. A single flat guard clause in a function body is still fine; the compound `&&` over two nullables is the one to replace.

*The fault and its fix.*
- ✗ `const m = modules.get(path); if (m !== undefined) return m.imports; return []`
- ✓ `pipe(Option.fromNullishOr(modules.get(path)), Option.match({ onNone: () => [], onSome: (m) => m.imports }))`

> Is each absent value an `Option`, lifted at its source with `Option.fromNullishOr`? Any compound `&&`/`||` nullable ternary that `Option.all` and `Option.map` would express?

## No loop, no mutation

There is no `for`, no `while`, no `let` accumulator. A transformation is a chain of an array's own methods, `map`, `filter`, and `flatMap`, and a fold is its `reduce`. Where an array has no method for a step, Effect's `Array` module supplies one, such as `Array.getSomes`, `Array.dedupe`, or `Array.mapAccum`. The next rule says which to reach for. `LoomAstBuilder.build` is the shape: `groupNodes(wefts).reduce((doc, node) => appendToDocument(node, doc), initialDocument)` folds each grouped node into a growing document.

Update without mutation. Extend a record by spreading it — `{ ...doc, sections: [...doc.sections, section] }` — and a map by copying it — `new Map(index).set(title, entry)`. The one `for` loop in the codebase, `lineOfOffset`, scans characters by code point for speed; it is a deliberate, isolated exception, and it is the only one.

*The fault and its fix.*
- ✗ `let out = []; for (const s of sections) { out.push(build(s)) } return out`
- ✓ `sections.map(build)`

> Any `for`, `while`, or `let` accumulator that an array's method or an `Array` combinator would express? Is each update a spread or a fresh `Map`, never a mutation in place?

## An array's own method, where it has one

An array already knows how to map, filter, and fold itself. Where its own method does what a function of Effect's `Array` module does, call the method: `sections.map(build)`, `wefts.filter(isFence)`, `parts.flatMap(piecesOf)`, `healths.reduce(withHealth, okHealth)`, `names.some(isTaken)`, `lines.join("\n")`. Nine methods qualify: `map`, `filter`, `flatMap`, `reduce`, `some`, `every`, `join`, `forEach`, and `flat`, which does what `Array.flatten` does.

Effect's function for each of the nine does the same work, behind a check of how it was called. Loom maps and filters small arrays for every token of every line, and those checks once took about 7% of a keystroke. The method is as pure as the function: neither changes the array it reads.

A method hands its callback the item, the item's index, and the whole array. So a function passed by name takes the item alone, or names the further arguments on purpose.

Effect's `Array` module keeps everything else. Three kinds of step remain its own.

- **A step that gives an `Option`.** `Array.head`, `Array.last`, `Array.get`, `Array.findFirst`, and `Array.findFirstIndex` give an `Option`. The method `find` and an index give `undefined`, which the rule on absence forbids.
- **A step no method does.** `Array.getSomes`, `Array.dedupe`, `Array.groupWith`, `Array.zip`, `Array.mapAccum`, `Array.partition`, `Array.range`, and `Array.fromIterable` have no method. `Array.sort`, `Array.sortWith`, and `Array.reverse` belong here too, because the methods `sort` and `reverse` change the array in place.
- **A step whose type the method loses.** `Array.map` over an array that the type knows is not empty gives an array that is not empty either, and the method `map` forgets that. `Array.contains` compares by Effect's equality, where the method `includes` compares by identity.

A `pipe` holds its first argument, so the steps that open a pipe are methods on that argument. A pipe whose every step is a method is no pipe at all: `pipe(wefts, Array.filter(isFence), Array.map(faultedFence))` is `wefts.filter(isFence).map(faultedFence)`. Where a step with no method follows, the methods before it move onto the first argument, `pipe(block.map(pieceOf), Array.getSomes, Array.dedupe)`, and a pipe left with one step is a plain call, `Array.getSomes(block.map(pieceOf))`.

A step further along a pipe holds no array, only its place in the pipe. There the step is Effect's function of one argument: `pipe(declared.parts.filter(inBook), Array.sort(byPart), Array.map(toTocPart))`. The same holds wherever a function of an array is wanted and no array is at hand, as in `Effect.map(Array.flatten)`.

*The fault and its fix.*
- ✗ `Array.map(sections, build)`, or `pipe(wefts, Array.filter(isFence), Array.map(faultedFence))`
- ✓ `sections.map(build)`, and `wefts.filter(isFence).map(faultedFence)`

> Does an array's own method do the step? Then is it called on the array? Is Effect's `Array` kept for a step that gives an `Option`, a step no method does, a step whose type the method loses, and a step further along a pipe?

## A function's name is its return

A function's name is a promise about what it returns. `probeOf` returns a `Probe`, `pieceOf` returns an `Option<CodePiece>`, `modeOf` returns a `Mode`. A function named `classifyPreambleLine` that also returns an `ArrowWeft` or a `TildeWeft` breaks the promise; narrow it to one return type, or name it for what it yields and return an `Option`.

When several recognizers compete for one input, order them by priority in a single pass and let the first match win, as `probeOf` tries heading, then arrow, then tilde, then plain. Do not split the recognizers across two passes — an "always applies" pass and a "sometimes applies" pass — that duplicates the priority order and hides it.

*The fault and its fix.*
- ✗ `classifyPreambleLine` returning an `ArrowWeft`, a `TildeWeft`, or a `PreambleWeft`
- ✓ `probeWeft` returning a `LoomWeft`, `pieceOf` returning an `Option<CodePiece>`

> Does each function's name name its return? Is a recognizer one priority-ordered pass with the first match winning, not two passes that re-rank the same cases?

## Read the peer; revise toward the shape

Before you add a file, read a peer in the same package and match its idioms — the service shape, the `pipe` style, how it names a fold and closes a `Match`. `WeftClassifier`, `ProductBuilder`, and `LoomFault` are the reference modules. A new file that ignores its neighbors reads as imported from another codebase.

When existing code and the target shape disagree, revise the whole thing toward the target. Do not bolt the new shape alongside the old — an `Option` path added "to be safe" beside the `undefined` path it was meant to replace leaves both, and the seam shows. And if a change breaks something that worked — a passing test, a resolved anchor, a highlighted section — the change is wrong: revert it and understand why before going on.

*The fault and its fix.*
- ✗ pasting a non-Effect snippet from elsewhere, or adding an `Option` branch next to the `undefined` branch it replaces
- ✓ opening `ProductBuilder`, following its Builder, `pipe`, and `Match` shape, and replacing the old shape whole

> Did you read a peer file first and match its idioms? Did you revise toward the shape rather than patch beside it? Did anything that worked before stop working?

## The final pass

Run every question over your diff, sentence by sentence and branch by branch, before you present. Then run `bunx tsc` and `bun test`. Each question's rule is its section above; when a check is unclear, read that section again.

- Does the program start from a runtime edge and stay one Effect until it? Is every `runSync`/`runPromise` at a true boundary, never mid-flow?
- Is every component a `Context.Service` with an explicit `static readonly layer`? Did you reach for a `Context.Tag`, a plain object, or a stale `Effect.Service`/`.Default` because the service felt hard?
- Is each dependency reached with `yield*` and wired through `Layer.provide` in the service's `.layer`? Is the graph assembled once at the entry point?
- Is each structure a Schema model paired with an `XxxBuilder` service? Is the pass named for its model, not an agent verb?
- Is every node constructed with `nodeOf`, not through `.make` and not as a bare literal? Is a structure with no tag a literal in a typed position? Is a value decoded only at the edge, or where its fit is the question?
- Could an illegal value even be constructed? Is untrusted input parsed once at the edge, not validated repeatedly downstream?
- Is every failure a tagged value, raised with `Effect.fail` and recovered by tag? Did you `throw`, or read an error's string, instead?
- Is every dispatch on a union written once, in a table or a `Match` the compiler closes, so a new case breaks the build rather than slipping through?
- Does every case name only a node's `type`? Then are the cases a table built with `byType` or `byTypeOr`, and is a value that is no union told apart by guard clauses?
- Is every matcher built once at module scope, with `Match.type` or `Match.fn`, or is the value a tagged enum read through its own `$match`? Is there a `Match.value` or a `Match.valueTags` anywhere? Does any matcher name only a node's `type` in every case?
- Any ternary nested inside another? The second `?` is the signal to switch to a table or a `Match`.
- Is each absent value an `Option`, lifted at its source with `Option.fromNullishOr`? Any compound nullable ternary that `Option.all` and `Option.map` would express?
- Any `for`, `while`, or `let` accumulator that an array's method or an `Array` combinator would express? Is each update a spread or a fresh `Map`, not a mutation?
- Does an array's own method do the step? Then is it called on the array? Is Effect's `Array` kept for a step that gives an `Option`, a step no method does, a step whose type the method loses, and a step further along a pipe?
- Does each function's name name its return? Is a recognizer one priority-ordered pass, first match winning?
- Did you read a peer file first and match its idioms? Did you revise toward the shape rather than patch beside it? Did anything that worked before stop working?

---

## Sources

- The Loom directives in `CLAUDE.md` — "Practice pure FP with Effect" and "Build top-down from the entry point."
- The Effect documentation (effect.website) — `Context.Service`, `Layer`, `ManagedRuntime`, `Match`, `Option`, `Schema`, `Data`.
- Alexis King, "Parse, Don't Validate" (2019).
- Yaron Minsky, "Effective ML" — make illegal states unrepresentable (Jane Street, 2011).
- Scott Wlaschin, "Railway Oriented Programming" — errors as values in a composed pipeline.
