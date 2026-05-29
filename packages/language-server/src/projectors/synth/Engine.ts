import { Effect, Match, Option, pipe } from "effect"
import type { Position } from "#ast/LoomNode"
import type { LoomDocument, LoomSection } from "#ast/LoomAst"
import type {
  ArrowWeft,
  CodeWeft,
  SectionBodyWeft,
} from "#ast/Weft"
import type {
  WarpAnchorToken,
  WarpToken,
} from "#ast/LoomTokens"

// =============================================================================
// Engine — the Loom Frame projector.
//
// What this file does, in one sentence: it reads a parsed input
// `LoomDocument` and a parsed *templates* document (`frame-synth.loom`)
// and produces the projected TypeScript Frame as one string of text.
//
// The architectural commitment, made up-front so everything below
// makes sense: every literal of the output — every keyword, every
// brace, every import line, every `export class …` wrapper, every
// `.Default` suffix — lives in the templates document, not in this
// file. The Engine never writes TypeScript. It only orchestrates:
// pick the right template for each AST node, compute the values that
// fill its named placeholders, and stitch the results.
//
// Anchors and tags. An anchor `{{key}}` in a template body is a
// plain string placeholder; the value the Engine substitutes is
// whatever the projection code puts under that key in the values
// map. By convention, two key shapes coexist:
//
//   - Lower-case keys (`className`, `name`, `code`, `tag`) are
//     scalar holes. The value is a string read out of the input AST
//     — no further projection.
//
//   - Capitalised keys (`Imports`, `ExportedSections`, `Body`,
//     `WarpBindings`, `Dependencies`) name a downstream template by
//     its tag. The value is the result of rendering that template
//     once, or rendering it over a list of input nodes and joining.
//
// The match between a capitalised key and a section tag in
// `frame-synth.loom` is a convention this file encodes by hand. There
// is no auto-dispatch: the Engine doesn't scan the templates for tag
// references and resolve them automatically. Each projection
// function below states explicitly which template it renders and
// which key it fills.
//
// Read the rest of this file top-down as the story of one call to
// `render`. The first section is the entry. Each subsequent section
// is the next thing that happens, with the lower-level mechanics —
// interpolation, slicers — pushed to the bottom where they belong.
// =============================================================================

// =============================================================================
// Entry — `Engine.render(templates, templatesSource, input, inputSource)`.
//
// The call begins here. We index the templates document into a flat
// lookup, build a context carrying the index plus the two source
// strings, and hand the input document to `projectDocument`. The
// recursion unfolds from there.
// =============================================================================

export class Engine extends Effect.Service<Engine>()(
  "Engine",
  {
    succeed: {
      render: (
        templates:        LoomDocument,
        templatesSource:  string,
        input:            LoomDocument,
        inputSource:      string,
      ): string => projectDocument(input, {
        templates:       indexTemplates(templates),
        templatesSource,
        inputSource,
      }),
    },
  },
) { }

// =============================================================================
// Indexing — read templates from the templates document.
//
// Before the recursion begins we collect every tagged section's body
// into a flat lookup: tag label → template. A template's body is the
// section's `ArrowWeft + CodeWeft` array up to the first `~`
// transition. Post-tilde wefts are author commentary and never
// appear in output. Hash-synthesised tags (`S_<base36>`) are private
// and not reachable from projection code, so they're excluded.
// =============================================================================

interface Template {
  readonly body: ReadonlyArray<ArrowWeft | CodeWeft>
}

const isBodyTemplate = (w: SectionBodyWeft): w is ArrowWeft | CodeWeft =>
  w.type === "ArrowWeft" || w.type === "CodeWeft"

const indexTemplates = (
  doc: LoomDocument,
): ReadonlyMap<string, Template> =>
  new Map(
    doc.sections.flatMap((section) =>
      pipe(
        Option.fromNullable(section.heading.tag?.label.value),
        Option.filter((v) => !/^S_[0-9a-z]+$/.test(v)),
        Option.match({
          onNone:  () => [] as ReadonlyArray<readonly [string, Template]>,
          onSome: (tag) =>
            [[tag, { body: section.code.filter(isBodyTemplate) }] as const],
        }),
      ),
    ),
  )

// =============================================================================
// Context — what the recursion threads through itself.
//
// `templatesSource` lets us slice each template body weft by its
// position. `inputSource` lets the input-side slicers (heading text,
// preamble prose, product code) read text out of the document being
// projected. `templates` is the indexed lookup we just built.
// =============================================================================

interface Ctx {
  readonly templates:       ReadonlyMap<string, Template>
  readonly templatesSource: string
  readonly inputSource:     string
}

// =============================================================================
// The recursion, step 1 — project the document.
//
// `projectDocument` renders the `Document` template, the
// outermost shape. Four holes:
//
//   - `Imports`          → render the `Imports` template once.
//   - `ExportedSections` → filter the input's sections to those with
//                          source-supplied tags, map each through
//                          `projectExportedSection`, join with a
//                          blank line between them.
//   - `PrivateSections`  → the mirror for hash-tagged sections,
//                          through `projectPrivateSection`.
//   - `LoomMain`         → omitted from the values map; the
//                          substituter resolves a missing key to "".
//                          A future tangle-aware variant will fill
//                          it via a matching template.
// =============================================================================

const projectDocument = (doc: LoomDocument, ctx: Ctx): string =>
  useTemplate(ctx, "Document", (t) =>
    interpolate(t, {
      Imports: projectImports(ctx),
      ExportedSections: doc.sections
        .filter((s) => !isHashTag(s))
        .map((s) => projectExportedSection(s, ctx))
        .join("\n\n"),
      PrivateSections: doc.sections
        .filter((s) => isHashTag(s))
        .map((s) => projectPrivateSection(s, ctx))
        .join("\n\n"),
    }, ctx.templatesSource),
  )

// =============================================================================
// The recursion, step 2a — project the imports header.
//
// `projectImports` renders the `Imports` template with no holes
// filled. The result is a fixed import line for now; future
// cross-file-Warp resolution will feed a `typeImports` hole here.
// =============================================================================

const projectImports = (ctx: Ctx): string =>
  useTemplate(ctx, "Imports", (t) =>
    interpolate(t, {}, ctx.templatesSource),
  )

// =============================================================================
// The recursion, step 2b — project one exported section.
//
// `projectExportedSection` renders the `ExportedSection` template.
// The visibility decision lives upstream in `projectDocument`'s
// partition; here we only fill the two holes the template declares:
//
//   - `className` → the section's tag label, a scalar from the AST.
//   - `Body`      → the Service body, picked by variant in
//                   `projectServiceBody`. Either a `StaticBody` or
//                   an `EffectfulBody` render.
// =============================================================================

const projectExportedSection = (section: LoomSection, ctx: Ctx): string =>
  useTemplate(ctx, "ExportedSection", (t) =>
    interpolate(t, {
      className: classNameOf(section),
      Body:      projectServiceBody(section, ctx),
    }, ctx.templatesSource),
  )

// =============================================================================
// The recursion, step 2c — project one private section.
//
// `projectPrivateSection` is the mirror of `projectExportedSection`
// for hash-tagged sections. Same holes, different template
// (the `class …` line without `export`).
// =============================================================================

const projectPrivateSection = (section: LoomSection, ctx: Ctx): string =>
  useTemplate(ctx, "PrivateSection", (t) =>
    interpolate(t, {
      className: classNameOf(section),
      Body:      projectServiceBody(section, ctx),
    }, ctx.templatesSource),
  )

// =============================================================================
// The recursion, step 3 — pick the body variant.
//
// A section with no preamble Warps is *static*: its body is the
// `StaticBody` template, three holes for `name` / `preamble` /
// `code` extracted from the input AST. A section with one or more
// preamble Warps is *effectful*: an `Effect.gen` shape with yield
// lines and a dependencies array.
//
// The variant choice is engine logic over the AST (count the
// Warps); both output shapes live in templates.
// =============================================================================

const projectServiceBody = (section: LoomSection, ctx: Ctx): string => {
  const warps = section.preamble.flatMap((p) => p.warps)
  return warps.length === 0
    ? projectStaticBody(section, ctx)
    : projectEffectfulBody(section, warps, ctx)
}

const projectStaticBody = (section: LoomSection, ctx: Ctx): string =>
  useTemplate(ctx, "StaticBody", (t) =>
    interpolate(t, {
      name:     headingName(section, ctx.inputSource),
      preamble: preambleText(section, ctx.inputSource),
      code:     codeText(section, ctx.inputSource),
    }, ctx.templatesSource),
  )

const projectEffectfulBody = (
  section: LoomSection,
  warps:   ReadonlyArray<WarpToken>,
  ctx:     Ctx,
): string =>
  useTemplate(ctx, "EffectfulBody", (t) =>
    interpolate(t, {
      WarpBindings: warps
        .map((w) => projectWarpBinding(w, ctx))
        .join("\n    "),
      name:         headingName(section, ctx.inputSource),
      preamble:     preambleText(section, ctx.inputSource),
      code:         codeText(section, ctx.inputSource),
      Dependencies: warps
        .map((w) => projectDependency(w, ctx))
        .join(", "),
    }, ctx.templatesSource),
  )

// =============================================================================
// The recursion, step 4 — warp-level details.
//
// Inside an effectful body, each preamble Warp produces one yield
// line (`WarpBinding`) and one entry in the dependencies list
// (`Dependency`). The engine maps the section's Warps through both
// templates and joins the results — `\n    ` for yield lines (to
// preserve indentation inside the `Effect.gen` block, which the
// surrounding template carries at the placeholder position), `, `
// between dependency entries. Those join strings are structural
// whitespace and punctuation, not output content, and stay
// engine-side.
// =============================================================================

const projectWarpBinding = (warp: WarpToken, ctx: Ctx): string =>
  useTemplate(ctx, "WarpBinding", (t) =>
    interpolate(t, {
      name: warp.name.value,
      tag:  warp.annotation.value,
    }, ctx.templatesSource),
  )

const projectDependency = (warp: WarpToken, ctx: Ctx): string =>
  useTemplate(ctx, "Dependency", (t) =>
    interpolate(t, {
      tag: warp.annotation.value,
    }, ctx.templatesSource),
  )

// =============================================================================
// Template lookup helper — guards every projection step.
//
// `useTemplate` is a tiny convenience: look the tag up, run the
// build function with the template if found, return "" otherwise.
// The missing-template path is defensive; in normal operation every
// tag the projection functions name is present in the templates
// document.
// =============================================================================

const useTemplate = (
  ctx:   Ctx,
  tag:   string,
  build: (t: Template) => string,
): string =>
  pipe(
    Option.fromNullable(ctx.templates.get(tag)),
    Option.match({
      onNone:  () => "",
      onSome:  build,
    }),
  )

// =============================================================================
// Interpolation — fill a template body with a values map.
//
// The substitution is line-oriented: we walk each ArrowWeft /
// CodeWeft, slice its source text, and replace every `{{key}}`
// anchor with `values[key]`. Source slices already carry their
// trailing newline, so the per-weft concatenation produces natural
// line breaks.
//
// After concatenation we strip leading and trailing newlines from
// the result. That trim makes templates compose cleanly: an
// ArrowWeft's `=>` line and any decorative blank line after it leave
// a leading `\n` on the raw concatenation, and the final blank line
// before the next section leaves trailing `\n`s. Both are formatting
// artifacts of the source `.loom`, not part of the template's
// payload. Trimming them lets an inline placeholder like
// `{{className}}` splice without breaking the surrounding line,
// while parent templates reintroduce blank-line separation
// explicitly through joins.
//
// An anchor whose name is missing from the values map resolves to
// "". Loud-failure diagnostics are reserved for a future pass.
// =============================================================================

const slice = (source: string, position: Position): string =>
  source.slice(position.start.offset, position.end.offset)

const interpolate = (
  template: Template,
  values:   Record<string, string>,
  source:   string,
): string => {
  const raw = template.body
    .map((weft) => renderTemplateWeft(weft, values, source))
    .join("")
  return raw.replace(/^\n+|\n+$/g, "")
}

const renderTemplateWeft = (
  weft:   ArrowWeft | CodeWeft,
  values: Record<string, string>,
  source: string,
): string =>
  pipe(
    Match.value(weft),
    Match.when({ type: "ArrowWeft" }, (w) =>
      pipe(
        Option.fromNullable(w.code),
        Option.match({
          onNone:  () => "",
          onSome: (c) => substituteAnchors(
            slice(source, c.position),
            c.position.start.offset,
            w.anchors,
            values,
          ),
        }),
      ),
    ),
    Match.when({ type: "CodeWeft" }, (w) =>
      substituteAnchors(
        slice(source, w.position),
        w.position.start.offset,
        w.anchors,
        values,
      ),
    ),
    Match.exhaustive,
  )

// =============================================================================
// Anchor substitution — stitch one line's text with values by key.
//
// The Tokeniser captured each `{{…}}` anchor as a `WarpAnchorToken`
// with absolute source offsets. We walk them in offset order as a
// left fold over `{ out, cursor }`, appending the unchanged span up
// to each anchor and then the value looked up by `anchor.name.value`.
// The trailing span after the last anchor is appended once at the
// end.
// =============================================================================

type StitchAcc = { readonly out: string; readonly cursor: number }

const substituteAnchors = (
  lineText:        string,
  lineStartOffset: number,
  anchors:         ReadonlyArray<WarpAnchorToken>,
  values:          Record<string, string>,
): string => {
  if (anchors.length === 0) return lineText
  const sorted = [...anchors].sort(
    (a, b) => a.position.start.offset - b.position.start.offset,
  )
  const folded = sorted.reduce<StitchAcc>(
    (acc, anchor) => {
      const relStart = anchor.position.start.offset - lineStartOffset
      const relEnd   = anchor.position.end.offset   - lineStartOffset
      return {
        out:    acc.out
                + lineText.slice(acc.cursor, relStart)
                + (values[anchor.name.value] ?? ""),
        cursor: relEnd,
      }
    },
    { out: "", cursor: 0 },
  )
  return folded.out + lineText.slice(folded.cursor)
}

// =============================================================================
// Input-side slicers and predicates — values the engine extracts
// from the AST of the document being projected.
//
// These are pure functions over the input AST and the input source
// text. They compute *scalar* values the projection functions hand
// to `interpolate`: the section's class name, the heading text, the
// preamble prose, the product code, and a visibility predicate.
// None of them emit TypeScript; they only read the input.
// =============================================================================

const classNameOf = (section: LoomSection): string =>
  section.heading.tag?.label.value ?? ""

const isHashTag = (section: LoomSection): boolean =>
  pipe(
    Option.fromNullable(section.heading.tag?.label.value),
    Option.map((v) => /^S_[0-9a-z]+$/.test(v)),
    Option.getOrElse(() => false),
  )

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

// `productSpansOf` reports the source spans that contribute to a
// section's product code per body weft kind. `ArrowWeft` contributes
// its optional inline code; `CodeWeft` contributes its whole line;
// `TildeWeft` and `ProseWeft` contribute nothing (prose is authoring
// context, not code).
const productSpansOf = (w: SectionBodyWeft): ReadonlyArray<Position> =>
  pipe(
    Match.value(w),
    Match.when({ type: "ArrowWeft" }, (a) =>
      pipe(
        Option.fromNullable(a.code),
        Option.match({
          onNone:  () => [] as ReadonlyArray<Position>,
          onSome: (c) => [c.position],
        }),
      ),
    ),
    Match.when({ type: "CodeWeft" },  (c) => [c.position] as ReadonlyArray<Position>),
    Match.when({ type: "TildeWeft" }, () => [] as ReadonlyArray<Position>),
    Match.when({ type: "ProseWeft" }, () => [] as ReadonlyArray<Position>),
    Match.exhaustive,
  )

// `codeText` stops at the first `~` transition: the forward-only
// mode progression guarantees no body weft after the first `~` is
// code.
const isProseTransition = (w: SectionBodyWeft): boolean =>
  w.type === "TildeWeft" || w.type === "ProseWeft"

const beforeProse = (
  body: ReadonlyArray<SectionBodyWeft>,
): ReadonlyArray<SectionBodyWeft> => {
  const cut = body.findIndex(isProseTransition)
  return cut < 0 ? body : body.slice(0, cut)
}

const codeText = (section: LoomSection, source: string): string =>
  beforeProse(section.code)
    .flatMap(productSpansOf)
    .map((p) => slice(source, p))
    .join("")
    .trim()
