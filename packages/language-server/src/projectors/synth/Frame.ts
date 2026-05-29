import { Effect } from "effect"
import type { LoomDocument, LoomSection } from "#ast/LoomAst"
import type { WarpToken } from "#ast/LoomTokens"

// =============================================================================
// Frame — the projected Frame as typed Effectful templates.
//
// One-to-one with `frame-synth.loom`: every `# Section [Tag]` template
// over there is exported here under the same `Tag` name. Each function
// takes the AST nodes it projects from, computes whatever scalar
// values it needs from them (and from other templates yielded
// inline), and returns an `Effect<string>` of the interpolated
// result.
//
// Substitution is native `${…}` in a template literal. There is no
// inner thunk, no values record, no generic anchor machinery — the
// function IS the template. Templates compose by direct function
// invocation, yielded inside `${yield* OtherTemplate(node)}`.
//
// AST nodes carry their own `source` slice (set by the Tokeniser and
// AstBuilder), so the projection functions read text from the AST
// directly. No `source: string` parameter threads through this
// module.
//
// Below the templates lives a small DSL — predicates, partitioners,
// scalar readers, and one list-mapping fold — that the templates
// lean on. The module stops there. It is *not* a generic
// interpreter; the orchestration is exactly the function call graph
// you see below.
// =============================================================================


// === Templates ===============================================================


// --- The Document ------------------------------------------------------------
// The top of the projection. Composes the import header, the exported
// sections, the private sections, and the composition root. Empty
// parts collapse — no stray blank lines.

export const Document = (doc: LoomDocument): Effect.Effect<string> =>
  Effect.gen(function* () {
    const imports = yield* Imports()
    const exportedSections = yield* concatMap(exportedOf(doc), ExportedSection, "\n\n")
    const privateSections = yield* concatMap(privateOf(doc), PrivateSection, "\n\n")
    return [imports, exportedSections, privateSections]
      .filter((p) => p.length > 0)
      .join("\n\n")
  })


// --- The Imports Header ------------------------------------------------------
// Module-level imports. Constant for now; cross-file Warp resolution
// will fold in synthesised `import type` lines later.

export const Imports = (): Effect.Effect<string> =>
  Effect.succeed(`import { Effect } from "effect"`)


// --- Exported Section --------------------------------------------------------
// A public Service class — the section's `[Tag]` was source-supplied.

export const ExportedSection = (section: LoomSection): Effect.Effect<string> =>
  Effect.gen(function* () {
    const className = classNameOf(section)
    const body = yield* Body(section)
    return `export class ${className} extends Effect.Service<${className}>()("${className}", ${body}) {}`
  })


// --- Private Section ---------------------------------------------------------
// A private Service class — the section's tag is hash-synthesised.

export const PrivateSection = (section: LoomSection): Effect.Effect<string> =>
  Effect.gen(function* () {
    const className = classNameOf(section)
    const body = yield* Body(section)
    return `class ${className} extends Effect.Service<${className}>()("${className}", ${body}) {}`
  })


// --- Static Body -------------------------------------------------------------
// The Service body when the section's preamble carries no Warps.

export const StaticBody = (section: LoomSection): Effect.Effect<string> =>
  Effect.succeed(
    `{ succeed: { name: \`${headingName(section)}\`, preamble: \`${preambleText(section)}\`, code: \`${codeText(section)}\` } }`,
  )


// --- Effectful Body ----------------------------------------------------------
// The Service body when the section's preamble declares one or more
// Warps. Yields each dependency before returning the
// `name`/`preamble`/`code` triple; the `dependencies` field carries
// the layers in parallel.

export const EffectfulBody = (section: LoomSection): Effect.Effect<string> =>
  Effect.gen(function* () {
    const warps = warpsOf(section)
    const warpBindings = yield* concatMap(warps, WarpBinding, "\n    ")
    const dependencies = yield* concatMap(warps, Dependency, ", ")
    const name = headingName(section)
    const preamble = preambleText(section)
    const code = codeText(section)
    return `{
  effect: Effect.gen(function* () {
    ${warpBindings}
    return { name: \`${name}\`, preamble: \`${preamble}\`, code: \`${code}\` }
  }),
  dependencies: [${dependencies}],
}`
  })


// --- Warp Binding ------------------------------------------------------------
// One `yield*` line inside an `EffectfulBody`.

export const WarpBinding = (warp: WarpToken): Effect.Effect<string> =>
  Effect.succeed(`const ${warp.name.value} = yield* ${warp.annotation.value}`)


// --- Dependency --------------------------------------------------------------
// One entry in an `EffectfulBody`'s dependencies list.

export const Dependency = (warp: WarpToken): Effect.Effect<string> =>
  Effect.succeed(`${warp.annotation.value}.Default`)


// === DSL =====================================================================
// Pure helpers over the AST: predicates, partitioners, scalar readers
// from `node.source`, and one Effectful list-concat fold. The
// templates lean on these so the substitution sites stay declarative.

const isHashTag = (section: LoomSection): boolean =>
  /^S_[0-9a-z]+$/.test(section.heading.tag?.label.value ?? "")

const classNameOf = (section: LoomSection): string =>
  section.heading.tag?.label.value ?? ""

const exportedOf = (doc: LoomDocument): ReadonlyArray<LoomSection> =>
  doc.sections.filter((s) => !isHashTag(s))

const privateOf = (doc: LoomDocument): ReadonlyArray<LoomSection> =>
  doc.sections.filter(isHashTag)

const warpsOf = (section: LoomSection): ReadonlyArray<WarpToken> =>
  section.preamble.flatMap((p) => p.warps)

const headingName = (section: LoomSection): string =>
  section.heading.texts.map((t) => t.source).join("").trim()

const preambleText = (section: LoomSection): string =>
  section.preamble.map((p) => p.source).join("").trim()

const codeText = (section: LoomSection): string => {
  const stop = section.code.findIndex(
    (w) => w.type === "TildeWeft" || w.type === "ProseWeft",
  )
  const body = stop < 0 ? section.code : section.code.slice(0, stop)
  return body
    .flatMap((w): ReadonlyArray<string> =>
      w.type === "CodeWeft" ? [w.source]
        : w.type === "ArrowWeft" && w.code ? [w.code.source]
          : [],
    )
    .join("")
    .trim()
}

// `concatMap` — map an Effectful function over a list and join the
// resulting strings with a separator. Templates lean on this when
// they fan out over a list of child nodes.
const concatMap = <A>(
  items: ReadonlyArray<A>,
  fn: (a: A) => Effect.Effect<string>,
  sep: string,
): Effect.Effect<string> =>
  Effect.map(Effect.forEach(items, fn), (xs) => xs.join(sep))


// --- Body (variant picker, internal) -----------------------------------------
// Not a template — the dispatcher between `StaticBody` and
// `EffectfulBody`. Section preamble Warps decide which template the
// section's body uses.

const Body = (section: LoomSection): Effect.Effect<string> =>
  warpsOf(section).length === 0
    ? StaticBody(section)
    : EffectfulBody(section)
