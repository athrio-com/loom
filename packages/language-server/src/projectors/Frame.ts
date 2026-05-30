import { m, type Mapped } from "./Mapper"

// =============================================================================
// Frame — the projected Frame as static, mapping-aware templates.
//
// Every exported value in this module is a pure function from named
// `Mapped` inputs to a `Mapped` output, built with Mapper's `m`
// tagged template. There is no AST awareness here, no Effect, no
// orchestration: each template declares the shape of one piece of
// the projected output, with `${…}` slots for the values that will
// be substituted in.
//
// The orchestration — walking the input `LoomDocument`, deciding
// which template applies to which AST node, computing the
// substitution values — lives in `FrameProjector.ts`. Together with
// `Mapper.ts`, the three files form a clean split:
//
//   Mapper.ts          — the algebra (Mapped, atoms, combinators)
//   Frame.ts           — the templates  (shape declarations)
//   FrameProjector.ts  — the orchestrator (AST → Mapped via Frame)
//
// Keeping Frame static (no Effect, no AST) makes the templates
// easy to read in isolation — the shape of the projected Frame is
// one paragraph of TypeScript per template, with `${…}` holes — and
// keeps `Mapper`'s composition rules the only thing that knows how
// pieces glue together.
// =============================================================================


// --- The Document ------------------------------------------------------------
// The top of the projection: import header, exported sections,
// private sections, and the composition root in that order.

export const Document = (slots: {
  readonly imports: Mapped
  readonly exportedSections: Mapped
  readonly privateSections: Mapped
  readonly loomMain: Mapped
}): Mapped =>
  m`${slots.imports}

${slots.exportedSections}

${slots.privateSections}

${slots.loomMain}`


// --- The Imports Header ------------------------------------------------------
// Module-level imports. Constant for now; cross-file Warp
// resolution will fold in synthesised `import type` lines later.

export const Imports = (): Mapped =>
  m`import { Effect } from "effect"`


// --- Exported Section --------------------------------------------------------
// A public `Effect.Service` class — the section's `[Tag]` was
// source-supplied, so the class is `export`ed and reachable across
// files.

export const ExportedSection = (slots: {
  readonly className: Mapped
  readonly body: Mapped
}): Mapped =>
  m`export class ${slots.className} extends Effect.Service<${slots.className}>()("${slots.className}", ${slots.body}) {}`


// --- Private Section ---------------------------------------------------------
// A private `Effect.Service` class — the section's tag is
// hash-synthesised by the Tokeniser, so the class is unexported and
// file-local.

export const PrivateSection = (slots: {
  readonly className: Mapped
  readonly body: Mapped
}): Mapped =>
  m`class ${slots.className} extends Effect.Service<${slots.className}>()("${slots.className}", ${slots.body}) {}`


// --- Static Body -------------------------------------------------------------
// The Service body when the section's preamble carries no Warps.

export const StaticBody = (slots: {
  readonly name: Mapped
  readonly code: Mapped
}): Mapped =>
  m`{ succeed: { name: \`${slots.name}\`, code: \`${slots.code}\` } }`


// --- Effectful Body ----------------------------------------------------------
// The Service body when the section's preamble declares one or
// more Warps. Yields each dependency before returning the
// `name`/`code` pair; the `dependencies` field carries the layers
// in parallel.

export const EffectfulBody = (slots: {
  readonly warpBindings: Mapped
  readonly name: Mapped
  readonly code: Mapped
  readonly dependencies: Mapped
}): Mapped =>
  m`{
  effect: Effect.gen(function* () {
    ${slots.warpBindings}
    return { name: \`${slots.name}\`, code: \`${slots.code}\` }
  }),
  dependencies: [${slots.dependencies}],
}`


// --- Warp Binding ------------------------------------------------------------
// One `yield*` line inside an `EffectfulBody`.

export const WarpBinding = (slots: {
  readonly name: Mapped
  readonly tag: Mapped
}): Mapped =>
  m`const ${slots.name} = yield* ${slots.tag}`


// --- Dependency --------------------------------------------------------------
// One entry in an `EffectfulBody`'s dependencies list.

export const Dependency = (slots: {
  readonly tag: Mapped
}): Mapped =>
  m`${slots.tag}.Default`
