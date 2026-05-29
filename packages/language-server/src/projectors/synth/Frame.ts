import { Effect } from "effect"
import type { Position } from "#ast/LoomNode"
import type { LoomDocument, LoomSection } from "#ast/LoomAst"
import type { WarpToken } from "#ast/LoomTokens"

// =============================================================================
// Frame — the projected Frame as typed Effectful templates.
//
// One-to-one with `frame-synth.loom`: every `# Section [Tag]` template
// over there is exported here under the same `Tag` name. Each function
// takes the AST nodes it projects from and returns an `Effect<string>`
// of the interpolated result. Templates compose by calling each other:
// recursion is direct function invocation inside `${…}` substitutions,
// no generic anchor machinery, no template registry.
//
// Convention. Inside every template's `Effect.gen` body, the template
// itself is defined first as a local `template(vars)` thunk returning
// an `Effect<string>`. The thunk holds the multiline string blueprint;
// it is *not* evaluated at the time the const is declared — its
// `${…}` substitutions are bound only when the gen later computes its
// values and invokes the thunk. Reading top-down: shape first,
// substitution second.
//
// Below the templates lives a small DSL — predicates, partitioners,
// source slicers, and one list-mapping fold — that the templates lean
// on. The module stops there. It is *not* a generic interpreter; the
// orchestration is exactly the function call graph you see below.
// =============================================================================


// === Templates ===============================================================


// --- The Document ------------------------------------------------------------
// The top of the projection. Composes the import header, the exported
// sections, the private sections, and the composition root. Empty
// parts collapse — no stray blank lines.

export const Document = (
  doc: LoomDocument,
  source: string,
): Effect.Effect<string> =>
  Effect.gen(function* () {
    const template = (vars: {
      readonly Imports: string
      readonly ExportedSections: string
      readonly PrivateSections: string
      readonly LoomMain: string
    }) =>
      Effect.succeed(
        [vars.Imports, vars.ExportedSections, vars.PrivateSections, vars.LoomMain]
          .filter((p) => p.length > 0)
          .join("\n\n"),
      )

    return yield* template({
      Imports: yield* Imports(),
      ExportedSections: yield* concatMap(exportedOf(doc), (s) => ExportedSection(s, source), "\n\n"),
      PrivateSections: yield* concatMap(privateOf(doc), (s) => PrivateSection(s, source), "\n\n"),
      LoomMain: "",
    })
  })


// --- The Imports Header ------------------------------------------------------
// Module-level imports. Constant for now; cross-file Warp resolution
// will fold in synthesised `import type` lines later.

export const Imports = (): Effect.Effect<string> =>
  Effect.gen(function* () {
    const template = () =>
      Effect.succeed(`import { Effect } from "effect"`)

    return yield* template()
  })


// --- Exported Section --------------------------------------------------------
// A public Service class — the section's `[Tag]` was source-supplied.

export const ExportedSection = (
  section: LoomSection,
  source: string,
): Effect.Effect<string> =>
  Effect.gen(function* () {
    const template = (vars: {
      readonly className: string
      readonly Body: string
    }) =>
      Effect.succeed(
        `export class ${vars.className} extends Effect.Service<${vars.className}>()("${vars.className}", ${vars.Body}) {}`,
      )

    return yield* template({
      className: classNameOf(section),
      Body: yield* Body(section, source),
    })
  })


// --- Private Section ---------------------------------------------------------
// A private Service class — the section's tag is hash-synthesised.

export const PrivateSection = (
  section: LoomSection,
  source: string,
): Effect.Effect<string> =>
  Effect.gen(function* () {
    const template = (vars: {
      readonly className: string
      readonly Body: string
    }) =>
      Effect.succeed(
        `class ${vars.className} extends Effect.Service<${vars.className}>()("${vars.className}", ${vars.Body}) {}`,
      )

    return yield* template({
      className: classNameOf(section),
      Body: yield* Body(section, source),
    })
  })


// --- Static Body -------------------------------------------------------------
// The Service body when the section's preamble carries no Warps.

export const StaticBody = (
  section: LoomSection,
  source: string,
): Effect.Effect<string> =>
  Effect.gen(function* () {
    const template = (vars: {
      readonly name: string
      readonly preamble: string
      readonly code: string
    }) =>
      Effect.succeed(
        `{ succeed: { name: \`${vars.name}\`, preamble: \`${vars.preamble}\`, code: \`${vars.code}\` } }`,
      )

    return yield* template({
      name: headingName(section, source),
      preamble: preambleText(section, source),
      code: codeText(section, source),
    })
  })


// --- Effectful Body ----------------------------------------------------------
// The Service body when the section's preamble declares one or more
// Warps. Yields each dependency before returning the
// `name`/`preamble`/`code` triple; the `dependencies` field carries
// the layers in parallel.

export const EffectfulBody = (
  section: LoomSection,
  source: string,
): Effect.Effect<string> =>
  Effect.gen(function* () {
    const template = (vars: {
      readonly WarpBindings: string
      readonly name: string
      readonly preamble: string
      readonly code: string
      readonly Dependencies: string
    }) =>
      Effect.succeed(`{
          effect: Effect.gen(function* () {
            ${vars.WarpBindings}
            return { name: \`${vars.name}\`, preamble: \`${vars.preamble}\`, code: \`${vars.code}\` }
          }),
          dependencies: [${vars.Dependencies}],
        }`,
      )

    const warps = warpsOf(section)
    
    return yield* template({
      WarpBindings: yield* concatMap(warps, WarpBinding, "\n    "),
      name: headingName(section, source),
      preamble: preambleText(section, source),
      code: codeText(section, source),
      Dependencies: yield* concatMap(warps, Dependency, ", "),
    })
  })


// --- Warp Binding ------------------------------------------------------------
// One `yield*` line inside an `EffectfulBody`.

export const WarpBinding = (warp: WarpToken): Effect.Effect<string> =>
  Effect.gen(function* () {
    const template = (vars: {
      readonly name: string
      readonly tag: string
    }) =>
      Effect.succeed(`const ${vars.name} = yield* ${vars.tag}`)

    return yield* template({
      name: warp.name.value,
      tag: warp.annotation.value,
    })
  })


// --- Dependency --------------------------------------------------------------
// One entry in an `EffectfulBody`'s dependencies list.

export const Dependency = (warp: WarpToken): Effect.Effect<string> =>
  Effect.gen(function* () {
    const template = (vars: {
      readonly tag: string
    }) =>
      Effect.succeed(`${vars.tag}.Default`)

    return yield* template({
      tag: warp.annotation.value,
    })
  })


// === DSL =====================================================================
// Pure helpers over the AST: predicates, partitioners, source slicers,
// and one Effectful list-concat fold. The templates lean on these so
// the substitution sites stay declarative.

const slice = (source: string, position: Position): string =>
  source.slice(position.start.offset, position.end.offset)

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

const headingName = (section: LoomSection, source: string): string =>
  section.heading.texts
    .map((t) => slice(source, t.position))
    .join("")
    .trim()

const preambleText = (section: LoomSection, source: string): string =>
  section.preamble
    .map((p) => slice(source, p.position))
    .join("")
    .trim()

const codeText = (section: LoomSection, source: string): string => {
  const stop = section.code.findIndex(
    (w) => w.type === "TildeWeft" || w.type === "ProseWeft",
  )
  const body = stop < 0 ? section.code : section.code.slice(0, stop)
  return body
    .flatMap((w): ReadonlyArray<string> =>
        w.type === "CodeWeft"              ? [slice(source, w.position)]
      : w.type === "ArrowWeft" && w.code   ? [slice(source, w.code.position)]
      :                                      [],
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

const Body = (
  section: LoomSection,
  source: string,
): Effect.Effect<string> =>
  warpsOf(section).length === 0
    ? StaticBody(section, source)
    : EffectfulBody(section, source)
