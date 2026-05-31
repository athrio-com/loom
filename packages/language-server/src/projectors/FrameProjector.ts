import { Effect } from 'effect'
import type { LoomDocument, LoomSection } from '#ast/LoomAst'
import type { WarpToken } from '#ast/LoomTokens'
import * as Frame from './Frame'
import { concatAll, join, literal, sourced, type Mapped } from './Mapper'

// =============================================================================
// FrameProjector — orchestrates the projection of a `LoomDocument`
// into the projected Frame as a `Mapped` value.
//
// Three modules cooperate. `Mapper.ts` defines the algebra: the
// `Mapped` envelope (generated code + mapping records) and the
// atoms / combinators (`literal`, `sourced`, `concat`, `join`,
// `m`) used to build values in that envelope. `Frame.ts` declares
// the static shape of the projected output: each template is a
// pure function from named `Mapped` inputs to a `Mapped` output,
// using `m`-tagged template literals. This module — the orchestrator
// — walks the input AST, computes the values each template expects,
// and assembles them into a final `Mapped` for the whole document.
//
// Returned values are `Effect<Mapped>`. The atomic AST → `Mapped`
// computations are pure (`sourced`, `literal`, `concatAll`); the
// `Effect.gen` wrap is uniform across the call graph so future
// concerns — diagnostics collection, cross-file imports, layered
// error handling — slot in without changing call sites.
//
// Read this file top-down as the story of one projection. The entry
// is `projectDocument`. Each subsequent block is the next thing
// that happens, with the AST readers — partitioners, slicers,
// scalar extractors — pushed to the bottom of the file where they
// belong.
// =============================================================================

// =============================================================================
// Entry — `projectDocument(doc): Effect<Mapped>`.
//
// Partitions the document's sections by tag origin (source-supplied
// vs hash-synthesised), projects each group through its visibility
// template, and assembles the four top-level pieces — imports,
// exported sections, private sections, the composition root —
// through `Frame.Document`. The composition root (`loomMain`) is
// the empty literal until tangle sinks land.
// =============================================================================

export const projectDocument = (doc: LoomDocument): Effect.Effect<Mapped> =>
  Effect.gen(function* () {
    const exported = yield* Effect.forEach(
      exportedSectionsOf(doc),
      projectExportedSection,
    )
    const private_ = yield* Effect.forEach(
      privateSectionsOf(doc),
      projectPrivateSection,
    )
    return Frame.Document({
      imports: Frame.Imports(),
      exportedSections: join(exported, '\n\n'),
      privateSections: join(private_, '\n\n'),
      loomMain: literal(''),
    })
  })

// =============================================================================
// Section projection — one `Effect.Service` class per input section.
//
// Visibility is decided upstream in `projectDocument`'s partition;
// each branch here only fills the two holes its template declares:
// the class name, and the Service body (picked by variant
// downstream in `projectServiceBody`).
// =============================================================================

const projectExportedSection = (section: LoomSection): Effect.Effect<Mapped> =>
  Effect.gen(function* () {
    const body = yield* projectServiceBody(section)
    return Frame.ExportedSection({ className: classNameOf(section), body })
  })

const projectPrivateSection = (section: LoomSection): Effect.Effect<Mapped> =>
  Effect.gen(function* () {
    const body = yield* projectServiceBody(section)
    return Frame.PrivateSection({ className: classNameOf(section), body })
  })

// =============================================================================
// Service body — static when the section's preamble carries no
// Warps, effectful when it declares one or more. Both shapes live
// in `Frame.ts`; the variant choice is engine logic over the AST.
// =============================================================================

const projectServiceBody = (section: LoomSection): Effect.Effect<Mapped> => {
  const warps = warpsOf(section)
  return warps.length === 0
    ? Effect.succeed(
        Frame.StaticBody({
          name: headingTitleOf(section),
          preamble: preambleTextOf(section),
          code: codeTextOf(section),
        }),
      )
    : projectEffectfulBody(section, warps)
}

const projectEffectfulBody = (
  section: LoomSection,
  warps: ReadonlyArray<WarpToken>,
): Effect.Effect<Mapped> =>
  Effect.gen(function* () {
    const bindings = yield* Effect.forEach(warps, projectWarpBinding)
    const dependencies = yield* Effect.forEach(warps, projectDependency)
    return Frame.EffectfulBody({
      warpBindings: join(bindings, '\n    '),
      dependencies: join(dependencies, ', '),
      name: headingTitleOf(section),
      preamble: preambleTextOf(section),
      code: codeTextOf(section),
    })
  })

// =============================================================================
// Warp-level projection — one yield line and one dependency entry
// per preamble Warp.
// =============================================================================

const projectWarpBinding = (warp: WarpToken): Effect.Effect<Mapped> =>
  Effect.succeed(
    Frame.WarpBinding({
      name: sourced(warp.name, 'identifier'),
      tag: sourced(warp.annotation, 'identifier'),
    }),
  )

const projectDependency = (warp: WarpToken): Effect.Effect<Mapped> =>
  Effect.succeed(
    Frame.Dependency({
      tag: sourced(warp.annotation, 'identifier'),
    }),
  )

// =============================================================================
// AST readers — pure helpers that produce `Mapped` from input AST
// nodes. All of these read `node.source` (set by the Tokeniser /
// AstBuilder) and wrap with `sourced` to record a mapping back to
// each node's `position`. Engine-glue text (empty string for a
// missing tag, etc.) wraps with `literal` — unmapped, invisible to
// the LSP.
// =============================================================================

const isHashTag = (section: LoomSection): boolean =>
  /^S_[0-9a-z]+$/.test(section.heading.tag?.label.value ?? '')

const exportedSectionsOf = (doc: LoomDocument): ReadonlyArray<LoomSection> =>
  doc.sections.filter((s) => !isHashTag(s))

const privateSectionsOf = (doc: LoomDocument): ReadonlyArray<LoomSection> =>
  doc.sections.filter(isHashTag)

const warpsOf = (section: LoomSection): ReadonlyArray<WarpToken> =>
  section.preamble.flatMap((p) => p.warps)

const classNameOf = (section: LoomSection): Mapped =>
  section.heading.tag
    ? sourced(section.heading.tag.label, 'identifier')
    : literal('')

// The heading's title is a single trimmed token — the text between
// the marker and the first structural token. It maps back to its own
// span, so the projected `name` field routes to the heading title.
// Absent when the heading carries no title text.
const headingTitleOf = (section: LoomSection): Mapped =>
  section.heading.title
    ? sourced(section.heading.title, 'identifier')
    : literal('')

// The section's preamble prose — every PreambleWeft between the
// heading and the first transition, concatenated 1:1 (EOLs and
// blank lines included, exactly as for code). Loom maps the prose
// it carries byte-for-byte rather than synthesising or trimming it,
// so the projected `preamble` field traces back to the source prose.
const preambleTextOf = (section: LoomSection): Mapped =>
  concatAll(section.preamble.map((p) => sourced(p, 'prose')))

// The section's product code is every body weft contributing
// source up to (but excluding) the first `~` transition. An
// ArrowWeft contributes its optional inline code only — the `=>`
// marker itself is structural. A CodeWeft contributes its whole
// line, EOL included.
const codeTextOf = (section: LoomSection): Mapped => {
  const stop = section.code.findIndex(
    (w) => w.type === 'TildeWeft' || w.type === 'ProseWeft',
  )
  const body = stop < 0 ? section.code : section.code.slice(0, stop)
  return concatAll(
    body.flatMap(
      (w): ReadonlyArray<Mapped> =>
        w.type === 'CodeWeft'
          ? [sourced(w)]
          : w.type === 'ArrowWeft' && w.code
            ? [sourced(w.code)]
            : [],
    ),
  )
}
