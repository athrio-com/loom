import { Array, Effect, Match, Option, Order, pipe } from 'effect'
import type { LoomDocument, LoomSection } from '#ast/LoomAst'
import { okHealth, type Health, type Point, type Position } from '#ast/LoomNode'
import type { WarpAnchorToken, WarpToken } from '#ast/LoomTokens'
import type { PreambleWeft, SectionBodyWeft } from '#ast/Weft'
import {
  type Binding,
  BindingItemSchema,
  BindingSchema,
  type CodeRef,
  CodeRefSchema,
  type Compose,
  ComposeArgItemSchema,
  ComposeSchema,
  type EmbeddedCode,
  EmbeddedCodeSchema,
  type FrameAuthoredToken,
  FrameAuthoredTokenSchema,
  type FrameCode,
  FrameCodeSchema,
  type FrameModule,
  FrameModuleSchema,
  FrameSynthTokenSchema,
  EffectfulBodySchema,
  type LayerRef,
  LayerRefItemSchema,
  LayerRefSchema,
  MemberItemSchema,
  RootSchema,
  type ServiceBody,
  type ServiceClass,
  ServiceClassSchema,
  type ServiceName,
  type SinkRef,
  SinkItemSchema,
  SinkRefSchema,
  StaticBodySchema,
  TangleBodySchema,
} from '#ast/FrameAst'

// =============================================================================
// FrameAstBuilder — the frame-side AST Builder.
//
//   build(doc: LoomDocument): Effect<FrameModule>
//
// `LoomAstBuilder` folds a weft Stream into the Loom AST; this folds the Loom
// AST's sections into the Frame AST. It is the LAST → FAST arrow — but it is a
// *build*, not a `Stream.transduce`, and not a *projection* (projection is what
// `FrameAstProjector` does to a target). It reads the same way `build` does:
//
//     pipe(
//       doc.sections,
//       Array.map(buildMember(index, lang)),     // section → a Frame member
//       Array.reduce(emptyFrame, appendMember),  // route into members|imports|layers|sinks
//       finaliseModule,                          // raise the composition root
//     )
//
// Total by construction: every section becomes a member, every binding sequence
// is `0..n`, and an edge that does not resolve becomes NOK *health on the node*,
// never a thrown `.make`. Health rides each node back to source through the
// mapping — grammatical health propagated from the Loom token a leaf is lifted
// from, semantic health (an unresolved anchor) attached here at build.
// =============================================================================

export class FrameAstBuilder extends Effect.Service<FrameAstBuilder>()(
  'FrameAstBuilder',
  {
    succeed: {
      build: (doc: LoomDocument): Effect.Effect<FrameModule> =>
        Effect.sync(() => buildFrame(doc)),
    },
  },
) {}

// buildFrame — the spine. The document has two parts and both feed the build:
// the Document Preamble (a headingless section — no code, so no member) declares
// the primary language, the default every Specifier-less section inherits; the
// sections become the members. So read the preamble for that default and index
// the section names, then build each section, fold, and finalise. (The document's
// own health — e.g. a missing `lang` — rides `doc.health`; propagating it is the
// health pass.)
export const buildFrame = (doc: LoomDocument): FrameModule => {
  const lang = primaryLanguage(doc.preamble)
  const index = nameIndex(doc.sections)
  return pipe(
    doc.sections,
    Array.map(buildMember(index, lang)),
    Array.reduce(emptyFrame, appendMember),
    finaliseModule,
  )
}

// =============================================================================
// The by-name resolver. A name anchor (`{{Adder}}`) resolves against a section's
// title — the always-available name. A tag is NEVER addressable this way; it is
// reachable only through a Warp. So the index is keyed by heading title and maps
// to the section's service name (its tag label, or the synthesised hash when the
// section is tagless).
// =============================================================================

type NameIndex = ReadonlyMap<string, string>

const nameIndex = (sections: ReadonlyArray<LoomSection>): NameIndex =>
  new Map(
    sections.flatMap((s) =>
      s.heading.title !== undefined
        ? [[s.heading.title.source, serviceNameOf(s)] as const]
        : [],
    ),
  )

// The primary product language — the Document Preamble's `{{lang: …}}` Warp,
// lowercased to a languageId; the default a Specifier-less section inherits. The
// `lang` Warp is an ordinary WarpToken, recognised as the language by its name at
// this stage (how-ast §"Document Preamble"). Absent, the AST already warned on
// `doc.health`; here it falls back to `plaintext`.
const primaryLanguage = (preamble: ReadonlyArray<PreambleWeft>): string =>
  preamble
    .flatMap((w) => w.warps)
    .find((w) => w.name.value === 'lang')
    ?.annotation.value.trim()
    .toLowerCase() ?? 'plaintext'

// =============================================================================
// Building one member. A section's specifier decides its kind — `Match`, never
// an `if`:
//   {path}   → a tangle Service: a private graph sink returning `core.tangle(…)`
//   {Loom}   → a FrameCode splice: raw de dicto frame code, with imports hoisted
//   else     → a product Service: exported iff it carries a real `[Tag]`
//
// A `Built` is the member plus what it contributes to the composition root: a
// `layer` (every Service merges its `.Default`), a `sink` (a tangle is yielded to
// run it), and any `imports` a `{Loom}` section hoists to the file head.
// =============================================================================

interface Built {
  readonly member: ServiceClass | FrameCode
  readonly layer: Option.Option<LayerRef>
  readonly sink: Option.Option<SinkRef>
  readonly imports: ReadonlyArray<FrameCode>
}

const buildMember =
  (index: NameIndex, lang: string) =>
  (section: LoomSection): Built =>
    pipe(
      Match.value(section.heading.specifier),
      Match.when({ type: 'PathSpecifier' }, (spec) =>
        buildService(index, lang, section, Option.some(pathOf(spec))),
      ),
      Match.when({ type: 'Specifier', label: { value: 'Loom' } }, () =>
        buildSplice(section),
      ),
      Match.orElse(() => buildService(index, lang, section, Option.none())),
    )

// buildService — a section → one `Effect.Service` class. `path` present marks a
// tangle (a private sink, `core.tangle(path, …)`); absent is a product Service
// (exported iff `[Tag]`). The body is `Static` (a `succeed` object) when the
// section declares no dependency, `Effectful`/`Tangle` (an `Effect.gen` of
// `0..n` `yield*` bindings) otherwise.
const buildService = (
  index: NameIndex,
  defaultLang: string,
  section: LoomSection,
  path: Option.Option<FrameAuthoredToken>,
): Built => {
  const warps = section.preamble.flatMap((w) => w.warps)
  const warpNames = new Set(warps.map((w) => w.name.value))
  const { compose, internals } = buildCompose(section, warpNames, index)
  const bindings = [...warps.map(warpBinding), ...internals]

  const name = serviceName(section)
  const languageId = Option.match(path, {
    // A tangle is language-agnostic — it composes any source (possibly several
    // languages) into one file and has no language of its own, so it is marked
    // `Loom` (the schema needs a string; it is not the document default and not
    // guessed from the path). The PathSpecifier alone makes the section a Tangle;
    // an authored {Loom} *label* is the only thing that becomes frame code (see
    // `buildSplice`), and the tangle's de re product is a `section-*` virtual
    // code, never the `frame` one (VirtualCode.ts) — so `Loom` here cannot leak
    // into the frame.
    onSome: () => 'Loom',
    onNone: () =>
      section.heading.specifier?.type === 'Specifier'
        ? section.heading.specifier.label.value.toLowerCase()
        : defaultLang,
  })

  const body = bodyOf(section, path, bindings, compose)
  const exported = Option.isNone(path) && isExported(section)

  const service = ServiceClassSchema.make({
    docPreamble: docPreamble(section),
    modifier: FrameSynthTokenSchema.make({ text: exported ? 'export ' : '' }),
    name,
    nameType: name,
    nameTag: name,
    body,
    languageId,
  })

  return {
    member: service,
    layer: Option.some(LayerRefSchema.make({ name })),
    sink: Option.map(path, () => SinkRefSchema.make({ name })),
    imports: [],
  }
}

// bodyOf — the body variant, chosen from the resolved model (not a count guard
// dodging a schema rule): a tangle is always effectful; a section is effectful
// iff it has any binding, else static. Bindings are a `0..n` sequence — no
// `head`, so the binding-less case is representable, never a `head!`.
const bodyOf = (
  section: LoomSection,
  path: Option.Option<FrameAuthoredToken>,
  bindings: ReadonlyArray<Binding>,
  compose: Compose,
): ServiceBody =>
  Option.match(path, {
    onSome: (p) =>
      TangleBodySchema.make({ bindings: items(bindings), path: p, code: compose }),
    onNone: () =>
      bindings.length > 0
        ? EffectfulBodySchema.make({
            bindings: items(bindings),
            name: titleField(section),
            preamble: preambleField(section),
            code: compose,
          })
        : StaticBodySchema.make({
            name: titleField(section),
            preamble: preambleField(section),
            code: compose,
          }),
  })

// items — a `0..n` binding list: each Binding wrapped in a `BindingItem` that
// owns its leading separator. `Array.map`, no head/tail split.
const items = (bindings: ReadonlyArray<Binding>) =>
  bindings.map((value) => BindingItemSchema.make({ value }))

// buildSplice — a `{Loom}` section: its non-import code spliced verbatim as de
// dicto FrameCode, its `import` lines hoisted to the file head. Over the code
// pieces (so inline-arrow code counts), not the CodeWefts alone. No Service, so
// it contributes neither a layer nor a sink.
const buildSplice = (section: LoomSection): Built => {
  const pieces = Array.filterMap(section.code, pieceOf)
  const isImport = (p: CodePiece) => /^\s*import\s/.test(p.source)
  const body = Array.filter(pieces, (p) => !isImport(p))

  return {
    member: Array.matchLeft(body, {
      onEmpty: () => FrameCodeSchema.make({ text: '', position: endOf(section) }),
      onNonEmpty: () =>
        FrameCodeSchema.make({ text: sourceOf(body), position: spanOf(body) }),
    }),
    layer: Option.none(),
    sink: Option.none(),
    imports: pipe(
      pieces,
      Array.filter(isImport),
      Array.map((p) => FrameCodeSchema.make({ text: p.source, position: p.position })),
    ),
  }
}

// =============================================================================
// Code → `core.compose(…)`. The product code (the CodeWefts after `=>`) is split
// at its anchors into product fragments (`EmbeddedCode`) and references
// (`CodeRef`), byte-faithfully — every span between anchors preserved. A name
// anchor also yields the internal `yield*` binding it hoists.
// =============================================================================

const buildCompose = (
  section: LoomSection,
  warps: ReadonlySet<string>,
  index: NameIndex,
): { readonly compose: Compose; readonly internals: ReadonlyArray<Binding> } => {
  const walked = Array.map(codeRuns(section.code), walkRun(bindAnchor(index, warps)))
  const args = Array.flatMap(walked, (w) => w.args)
  const internals = dedupeByName(Array.flatMap(walked, (w) => w.bindings))

  const compose = Array.matchLeft(args, {
    onEmpty: () => ComposeSchema.make({ tail: [] }),
    onNonEmpty: (head, tail) =>
      ComposeSchema.make({
        head,
        tail: Array.map(tail, (value) => ComposeArgItemSchema.make({ value })),
      }),
  })
  return { compose, internals }
}

type ComposeArg = EmbeddedCode | CodeRef

// A code piece — the unit of product code: a `CodeWeft`'s line, or an
// `ArrowWeft`'s inline code (the text after `=>`, taken to the line end so its
// newline survives). `anchors` are the references recognised inside it.
interface CodePiece {
  readonly source: string
  readonly position: Position
  readonly anchors: ReadonlyArray<WarpAnchorToken>
}

const pieceOf = (w: SectionBodyWeft): Option.Option<CodePiece> =>
  pipe(
    Match.value(w),
    Match.when({ type: 'CodeWeft' }, (c) =>
      Option.some({ source: c.source, position: c.position, anchors: c.anchors }),
    ),
    Match.when({ type: 'ArrowWeft' }, (a) =>
      Option.map(Option.fromNullable(a.code), (code) => ({
        source: a.source.slice(
          code.position.start.offset - a.position.start.offset,
        ),
        position: between(code.position.start, a.position.end),
        anchors: a.anchors,
      })),
    ),
    Match.orElse(() => Option.none<CodePiece>()),
  )

// A piece is blank when its line is whitespace only — an empty line after `=>`,
// an empty line before the next heading, or an arrow with no code at all.
const isBlank = (p: CodePiece): boolean => p.source.trim().length === 0

// trimBlank — drop the leading and trailing blank pieces of a run, so the emitted
// span is the code itself: no empty line before the first statement, none after
// the last. Interior blanks (the author's spacing between statements, or between
// anchors in a tangle sink) are kept, and the kept pieces carry their own `.loom`
// positions, so mappings stay exact. An all-blank run trims to nothing.
const trimBlank = (
  run: ReadonlyArray<CodePiece>,
): ReadonlyArray<CodePiece> =>
  pipe(
    run,
    Array.dropWhile(isBlank),
    Array.reverse,
    Array.dropWhile(isBlank),
    Array.reverse,
  )

// codeRuns — the section's code as contiguous runs. Each `=>` opens a run (its
// inline code, if any, then the `CodeWeft`s up to the next `~`); prose drops out.
// Each run's leading/trailing blank lines are trimmed (so an arrow with no code
// yields nothing). A run's pieces are contiguous, so a run is one sliceable span —
// and a section with several `=> … ~ … =>` blocks yields several runs, in order.
const codeRuns = (
  code: ReadonlyArray<SectionBodyWeft>,
): ReadonlyArray<ReadonlyArray<CodePiece>> =>
  Array.isNonEmptyReadonlyArray(code)
    ? pipe(
        code,
        Array.groupWith((_, w) => w.type !== 'ArrowWeft'), // break before each `=>`
        Array.map((block) => Array.filterMap(block, pieceOf)),
        Array.map(trimBlank),
        Array.filter((run) => run.length > 0),
      )
    : []

// walkRun — one run → its `Compose` arguments and the bindings its name anchors
// hoist. The run's anchors, in source order, partition its (contiguous) text:
// anchor `i` opens where the prior anchor ended (the first at the run's start), a
// closing fragment runs to the run's end, and each anchor contributes the
// fragment before it then its `ref` — all a function of its index, no cursor.
const walkRun =
  (bind: (anchor: WarpAnchorToken) => Bound) =>
  (
    pieces: ReadonlyArray<CodePiece>,
  ): {
    readonly args: ReadonlyArray<ComposeArg>
    readonly bindings: ReadonlyArray<Binding>
  } => {
    const { start, end } = spanOf(pieces)
    const text = sourceOf(pieces)
    const slice = (from: Point, to: Point): string =>
      text.slice(from.offset - start.offset, to.offset - start.offset)
    const fragment = (from: Point, to: Point): ReadonlyArray<EmbeddedCode> => {
      const lit = slice(from, to)
      return lit.length === 0
        ? []
        : [
            EmbeddedCodeSchema.make({
              text: escapeTemplate(lit),
              position: between(from, to),
            }),
          ]
    }

    const anchors = pipe(
      pieces,
      Array.flatMap((p) => p.anchors),
      Array.sort(byStart),
    )
    const opensAt = (i: number): Point =>
      pipe(
        Array.get(anchors, i - 1),
        Option.match({ onNone: () => start, onSome: (a) => a.position.end }),
      )

    const walked = Array.map(anchors, (anchor, i) => {
      const { ref, binding } = bind(anchor)
      return {
        chunk: [...fragment(opensAt(i), anchor.position.start), ref],
        binding,
      }
    })

    return {
      args: [
        ...Array.flatMap(walked, (w) => w.chunk),
        ...fragment(opensAt(anchors.length), end),
      ],
      bindings: Array.filterMap(walked, (w) => w.binding),
    }
  }

// Anchors are walked in source order; a name anchored twice hoists one binding.
const byStart: Order.Order<WarpAnchorToken> = Order.mapInput(
  Order.number,
  (a) => a.position.start.offset,
)

const dedupeByName = (
  bindings: ReadonlyArray<Binding>,
): ReadonlyArray<Binding> =>
  [...new Map(bindings.map((b) => [b.name.text, b])).values()]

// =============================================================================
// Anchor binding — two disjoint modes, never conflated; an unresolved anchor is
// NOK *health on the reference*, not a crash and not a silent free name.
//
//   by binding — the anchor is a Warp the section declared; the binding already
//                exists, so reference it: `m.code`. No new binding.
//   by name    — the anchor is a section title (any section, tagged or not);
//                hoist `const _N = yield* N` (aliased, so it can't shadow the
//                class) and reference `_N.code`. (A tag *label* is reachable only
//                through a Warp, so a bare tag anchor is a *name* miss → NOK.)
// =============================================================================

interface Bound {
  readonly ref: CodeRef
  readonly binding: Option.Option<Binding>
}

const bindAnchor =
  (index: NameIndex, warps: ReadonlySet<string>) =>
  (anchor: WarpAnchorToken): Bound => {
    const name = anchor.name.value
    const at = anchor.name.position
    if (warps.has(name)) {
      return { ref: codeRef(name, at), binding: Option.none() }
    }
    return pipe(
      Option.fromNullable(index.get(name)),
      Option.match({
        onSome: (service) => ({
          ref: codeRef(aliasOf(service), at),
          binding: Option.some(nameBinding(service, at)),
        }),
        onNone: () => ({
          ref: codeRef(name, at, unresolved(name, at)),
          binding: Option.none(),
        }),
      }),
    )
  }

// codeRef — `<name>.code`. The `name` token carries the mapping (and, when the
// anchor did not resolve, the NOK health), so the diagnostic lands on the anchor.
const codeRef = (name: string, at: Position, health?: Health): CodeRef =>
  CodeRefSchema.make({ binding: id(name, at, health) })

// aliasOf — a name anchor binds the resolved service under a `_`-prefixed alias,
// so the `const` never shadows the service's own class: `const _Mul = yield* Mul`,
// not `const Mul = yield* Mul` — the latter is a TDZ self-reference, since the
// operand `Mul` resolves to the `const` being declared, not the class.
const aliasOf = (service: string): string => `_${service}`

// nameBinding — `const _Mul = yield* Mul`: the by-name hoist, aliasing the resolved
// service so the binding doesn't shadow its own class; the anchor's `.code` ref
// dereferences the same alias.
const nameBinding = (service: string, at: Position): Binding =>
  BindingSchema.make({ name: id(aliasOf(service), at), tag: id(service, at) })

// warpBinding — `const m = yield* Mul`: a preamble Warp. Both names map to the
// Warp's source.
const warpBinding = (warp: WarpToken): Binding =>
  BindingSchema.make({
    name: id(warp.name.value, warp.name.position),
    tag: id(warp.annotation.value.trim(), warp.annotation.position),
  })

// unresolved — the frame-side `missingClosing`/`errorToHealth`: NOK health plus a
// positioned diagnostic, built at the moment a reference fails to resolve.
const unresolved = (name: string, at: Position): Health => ({
  status: 'error',
  diagnostics: [
    {
      message: `Unresolved anchor: no section named \`${name}\`. A tagged section is reachable only through a Warp.`,
      position: at,
      severity: 'error',
    },
  ],
})

// =============================================================================
// The fold. `appendMember` routes a `Built` into the four `0..n` sequences;
// `finaliseModule` assembles the module and raises the composition root from the
// collected layers and sinks (none → no root, exactly as an empty document
// yields no sections).
// =============================================================================

interface FrameBuilder {
  readonly imports: ReadonlyArray<FrameCode>
  readonly members: ReadonlyArray<ReturnType<typeof MemberItemSchema.make>>
  readonly layers: ReadonlyArray<LayerRef>
  readonly sinks: ReadonlyArray<SinkRef>
}

const emptyFrame: FrameBuilder = {
  imports: [],
  members: [],
  layers: [],
  sinks: [],
}

const appendMember = (b: FrameBuilder, built: Built): FrameBuilder => ({
  imports: [...b.imports, ...built.imports],
  members: [...b.members, MemberItemSchema.make({ value: built.member })],
  layers: [...b.layers, ...Option.toArray(built.layer)],
  sinks: [...b.sinks, ...Option.toArray(built.sink)],
})

const finaliseModule = (b: FrameBuilder): FrameModule =>
  FrameModuleSchema.make({
    imports: b.imports,
    members: b.members,
    root: buildRoot(b.layers, b.sinks),
  })

// buildRoot — `Layer.mergeAll(…)` + `LoomMain`, absent when the file has no
// Service. `head` is required here, and legitimately so: the root exists only
// when there is at least one layer, so `matchLeft` makes presence the guard.
const buildRoot = (
  layers: ReadonlyArray<LayerRef>,
  sinks: ReadonlyArray<SinkRef>,
) =>
  Array.matchLeft(layers, {
    onEmpty: () => undefined,
    onNonEmpty: (head, tail) =>
      RootSchema.make({
        head,
        tail: tail.map((value) => LayerRefItemSchema.make({ value })),
        sinks: sinks.map((value) => SinkItemSchema.make({ value })),
      }),
  })

// =============================================================================
// Leaves and identity.
// =============================================================================

// A section's service-name string — its tag label, or the synthesised hash when
// tagless. The Tokeniser fills `tag` for every heading, so this is total.
const serviceNameOf = (section: LoomSection): string =>
  section.heading.tag?.label.value ?? ''

// The service-name token. Tagged → the `[Tag]` label, an authored token mapped
// to that span. Tagless → the synthesised hash, a FrameSynthToken: pure glue with
// no `.loom` origin, so never mapped (the section is reached through its `name:`
// field and its anchors, not this synthesised name). This is the de-re/de-dicto
// cut at the leaf — the hash is the frame's own, not the author's.
const serviceName = (section: LoomSection): ServiceName => {
  const tag = section.heading.tag
  return isExported(section) && tag !== undefined
    ? id(tag.label.value, tag.label.position)
    : FrameSynthTokenSchema.make({ text: serviceNameOf(section) })
}

// A real `[Tag]` spans source bytes; a synthesised (tagless) tag is zero-width.
// A real tag exports the Service.
const isExported = (section: LoomSection): boolean => {
  const tag = section.heading.tag
  return (
    tag !== undefined &&
    tag.label.position.end.offset > tag.label.position.start.offset
  )
}

const id = (
  text: string,
  position: Position,
  health: Health = okHealth,
): FrameAuthoredToken =>
  FrameAuthoredTokenSchema.make({ text, position, kind: 'name', health })

const prose = (text: string, position: Position): FrameAuthoredToken =>
  FrameAuthoredTokenSchema.make({ text, position, kind: 'prose' })

// The TSDoc preamble (`/** … */`) and the body `name` / `preamble` fields all
// derive from one source span — the section's preamble prose (or a zero-width
// span at the heading end when there is none).
const docPreamble = (section: LoomSection): FrameAuthoredToken =>
  prose(escapeComment(sourceOf(section.preamble)), preamblePos(section))

const preambleField = (section: LoomSection): FrameAuthoredToken =>
  prose(escapeTemplate(sourceOf(section.preamble)), preamblePos(section))

const titleField = (section: LoomSection): FrameAuthoredToken =>
  prose(
    escapeTemplate(section.heading.title?.source ?? ''),
    section.heading.title?.position ?? section.heading.position,
  )

const preamblePos = (section: LoomSection): Position =>
  section.preamble.length > 0 ? spanOf(section.preamble) : endOf(section)

const endOf = (section: LoomSection): Position =>
  between(section.heading.position.end, section.heading.position.end)

// =============================================================================
// Spans, sources, and escaping. Escaping is a `.text`-only transform — the leaf
// keeps its raw `.loom` `position`, so a mapping stays one coarse span.
// =============================================================================

const sourceOf = (nodes: ReadonlyArray<{ readonly source: string }>): string =>
  nodes.map((n) => n.source).join('')

const spanOf = (
  nodes: ReadonlyArray<{ readonly position: Position }>,
): Position => ({
  start: nodes[0]!.position.start,
  end: nodes[nodes.length - 1]!.position.end,
})

const between = (start: Point, end: Point): Position => ({ start, end })

const escapeTemplate = (s: string): string =>
  s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${')

const escapeComment = (s: string): string => s.replace(/\*\//g, '*\\/')

const escapeString = (s: string): string =>
  s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')

const pathOf = (spec: { label: { value: string; position: Position } }) =>
  prose(escapeString(spec.label.value), spec.label.position)
