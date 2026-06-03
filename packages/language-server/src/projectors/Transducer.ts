import { Effect } from 'effect'
import type { LoomDocument, LoomSection } from '#ast/LoomAst'
import type { Point, Position } from '#ast/LoomNode'
import type { WarpAnchorToken, WarpToken } from '#ast/LoomTokens'
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
  LayerRefItemSchema,
  LayerRefSchema,
  MemberItemSchema,
  RootSchema,
  type ServiceBody,
  type ServiceClass,
  ServiceClassSchema,
  SinkItemSchema,
  SinkRefSchema,
  StaticBodySchema,
  TangleBodySchema,
} from '#projectors/FrameAst'

// =============================================================================
// transduce — LoomDocument → FrameModule (the LAST → FAST arrow), complete.
//
// Each section dispatches on its specifier:
//   - `{path}`  → a tangle Service (private, `tangle(path, …)`, a graph sink)
//   - `{Loom}`  → a FrameCode splice + its import lines hoisted to the head
//   - otherwise → a product Service (exported iff `[Tag]`)
//
// A product/tangle Service is static (`succeed`) when it has no Warps or
// anchors, effectful (`Effect.gen`) otherwise: preamble Warps become `yield*`
// bindings, code anchors become `CodeRef`s, and a heading-name anchor also
// hoists an internal `const _Name = yield* Name`. The code block splits at its
// anchors into `compose(…)` of product fragments and refs, byte-faithfully.
// The root merges every Service and runs the tangle sinks. Text is escaped for
// the literal it lands in; `position` stays raw.
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

// Escape mapped text for the literal it sits in — a `.text`-only transform; the
// leaf keeps its raw `.loom` `position`, so the mapping stays one coarse span.
const escapeTemplate = (s: string): string =>
  s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${')

const escapeComment = (s: string): string => s.replace(/\*\//g, '*\\/')

const escapeString = (s: string): string =>
  s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')

const id = (text: string, position: Position): FrameAuthoredToken =>
  FrameAuthoredTokenSchema.make({ text, position, kind: 'identifier' })

const prose = (text: string, position: Position): FrameAuthoredToken =>
  FrameAuthoredTokenSchema.make({ text, position, kind: 'prose' })

// =============================================================================
// Section identity. The Tokeniser fills `tag` for every heading — a real
// `[Tag]` spans source bytes, a synthesised (tagless) tag is zero-width. So a
// real tag exports the Service, and the class name is always `tag.label.value`
// (the label or the hash).
// =============================================================================

const classNameOf = (section: LoomSection): FrameAuthoredToken =>
  id(
    section.heading.tag?.label.value ?? '',
    section.heading.tag?.label.position ?? section.heading.position,
  )

const isExported = (section: LoomSection): boolean => {
  const tag = section.heading.tag
  return (
    tag !== undefined &&
    tag.label.position.end.offset > tag.label.position.start.offset
  )
}

// Heading title → class-name text, for resolving heading-name anchors.
const titleIndex = (doc: LoomDocument): ReadonlyMap<string, string> =>
  new Map(
    doc.sections.flatMap((s) =>
      s.heading.title !== undefined
        ? [[s.heading.title.source, s.heading.tag?.label.value ?? ''] as const]
        : [],
    ),
  )

// The document's default product language — the `{{lang: …}}` preamble Warp,
// lowercased to a languageId. A section's `{specifier}` overrides it; absent it,
// a section falls back to `plaintext`.
const langOf = (doc: LoomDocument): string =>
  doc.preamble
    .flatMap((w) => w.warps)
    .find((w) => w.name.value === 'lang')
    ?.annotation.value.trim()
    .toLowerCase() ?? 'plaintext'

// =============================================================================
// Bindings and anchors.
// =============================================================================

// `{{m: Mul}}` → `const m = yield* Mul`.
const warpBinding = (warp: WarpToken): Binding =>
  BindingSchema.make({
    name: id(warp.name.value, warp.name.position),
    tag: id(warp.annotation.value.trim(), warp.annotation.position),
  })

// A code anchor `{{x}}` → a `CodeRef`, plus (for a heading-name anchor) the
// internal binding to hoist. A single-word anchor matching a preamble Warp name
// resolves to that binding; otherwise it is a heading name → `_Name`.
const resolveAnchor = (
  anchor: WarpAnchorToken,
  warps: ReadonlySet<string>,
  titles: ReadonlyMap<string, string>,
): { readonly ref: CodeRef; readonly internal?: Binding } => {
  const name = anchor.name.value
  // Map to the inner name, not the whole `{{…}}` — like tags (`label`), warps
  // (`name` / `annotation`), and specifiers (`label`), a mapped span hugs the
  // identifier and never includes the delimiters.
  const at = anchor.name.position
  if (warps.has(name)) {
    return { ref: CodeRefSchema.make({ binding: id(name, at) }) }
  }
  const target = titles.get(name)
  if (target === undefined) {
    return { ref: CodeRefSchema.make({ binding: id(name, at) }) } // unresolved
  }
  const local = `_${target}`
  return {
    ref: CodeRefSchema.make({ binding: id(local, at) }),
    internal: BindingSchema.make({ name: id(local, at), tag: id(target, at) }),
  }
}

// =============================================================================
// Code → compose(). The product code (CodeWefts after `=>`) is split at its
// anchors into product fragments (EmbeddedCode) and refs (CodeRef), preserving
// every byte between them. Heading-name anchors also yield internal bindings.
// =============================================================================

const buildCompose = (
  section: LoomSection,
  warps: ReadonlySet<string>,
  titles: ReadonlyMap<string, string>,
): { readonly compose: Compose; readonly internals: ReadonlyArray<Binding> } => {
  const wefts = section.code.filter((w) => w.type === 'CodeWeft')
  if (wefts.length === 0) {
    return { compose: ComposeSchema.make({ tail: [] }), internals: [] }
  }

  const text = sourceOf(wefts)
  const start = wefts[0]!.position.start
  const end = wefts[wefts.length - 1]!.position.end
  const slice = (from: Point, to: Point): string =>
    text.slice(from.offset - start.offset, to.offset - start.offset)

  const anchors = wefts
    .flatMap((w) => w.anchors)
    .slice()
    .sort((a, b) => a.position.start.offset - b.position.start.offset)

  // Fragment of literal product code between two points, if non-empty.
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

  const walked = anchors.reduce(
    (acc, anchor) => {
      const { ref, internal } = resolveAnchor(anchor, warps, titles)
      return {
        args: [...acc.args, ...fragment(acc.cursor, anchor.position.start), ref],
        cursor: anchor.position.end,
        internals: internal ? [...acc.internals, internal] : acc.internals,
      }
    },
    {
      args: [] as ReadonlyArray<EmbeddedCode | CodeRef>,
      cursor: start,
      internals: [] as ReadonlyArray<Binding>,
    },
  )
  const args = [...walked.args, ...fragment(walked.cursor, end)]

  const [head, ...rest] = args
  const compose =
    head === undefined
      ? ComposeSchema.make({ tail: [] })
      : ComposeSchema.make({
          head,
          tail: rest.map((value) => ComposeArgItemSchema.make({ value })),
        })

  // Dedupe internal bindings by name (the same target anchored twice → once).
  const internals = [
    ...new Map(walked.internals.map((b) => [b.name.text, b])).values(),
  ]
  return { compose, internals }
}

// =============================================================================
// Service bodies.
// =============================================================================

const bindingList = (bindings: ReadonlyArray<Binding>) => {
  const [head, ...rest] = bindings
  return { head: head!, tail: rest.map((value) => BindingItemSchema.make({ value })) }
}

// =============================================================================
// Projection of one section.
// =============================================================================

interface Projected {
  readonly member: ServiceClass | FrameCode
  readonly layer?: FrameAuthoredToken // Service name → mergeAll (not for {Loom})
  readonly sink?: FrameAuthoredToken // tangle name → the program's yields
  readonly imports: ReadonlyArray<FrameCode>
}

const projectService = (
  section: LoomSection,
  titles: ReadonlyMap<string, string>,
  languageId: string,
  path?: FrameAuthoredToken, // present ⇒ a tangle sink
): Projected => {
  const warps = section.preamble.flatMap((w) => w.warps)
  const warpNames = new Set(warps.map((w) => w.name.value))
  const { compose, internals } = buildCompose(section, warpNames, titles)
  const bindings = [...warps.map(warpBinding), ...internals]

  const preambleRaw = sourceOf(section.preamble)
  const preamblePosition =
    section.preamble.length > 0
      ? spanOf(section.preamble)
      : between(section.heading.position.end, section.heading.position.end)
  const nameField = prose(
    escapeTemplate(section.heading.title?.source ?? ''),
    section.heading.title?.position ?? section.heading.position,
  )
  const fieldPreamble = prose(escapeTemplate(preambleRaw), preamblePosition)

  const body: ServiceBody =
    path !== undefined
      ? TangleBodySchema.make({ ...bindingList(bindings), path, code: compose })
      : bindings.length > 0
      ? EffectfulBodySchema.make({
          ...bindingList(bindings),
          name: nameField,
          preamble: fieldPreamble,
          code: compose,
        })
      : StaticBodySchema.make({
          name: nameField,
          preamble: fieldPreamble,
          code: compose,
        })

  const name = classNameOf(section)
  const service = ServiceClassSchema.make({
    docPreamble: prose(escapeComment(preambleRaw), preamblePosition),
    modifier: FrameSynthTokenSchema.make({
      text: path === undefined && isExported(section) ? 'export ' : '',
    }),
    name,
    nameType: name,
    nameTag: name,
    body,
    languageId,
  })

  return {
    member: service,
    layer: name,
    sink: path !== undefined ? name : undefined,
    imports: [],
  }
}

const projectLoom = (section: LoomSection): Projected => {
  const wefts = section.code.filter((w) => w.type === 'CodeWeft')
  const isImport = (w: { source: string }) => /^\s*import\s/.test(w.source)
  const importWefts = wefts.filter(isImport)
  const bodyWefts = wefts.filter((w) => !isImport(w))

  const body =
    bodyWefts.length > 0
      ? FrameCodeSchema.make({
          text: sourceOf(bodyWefts),
          position: spanOf(bodyWefts),
        })
      : FrameCodeSchema.make({
          text: '',
          position: between(
            section.heading.position.end,
            section.heading.position.end,
          ),
        })

  return {
    member: body,
    imports: importWefts.map((w) =>
      FrameCodeSchema.make({ text: w.source, position: w.position }),
    ),
  }
}

const projectSection = (
  section: LoomSection,
  titles: ReadonlyMap<string, string>,
  defaultLang: string,
): Projected => {
  const spec = section.heading.specifier
  if (spec?.type === 'Specifier' && spec.label.value === 'Loom') {
    return projectLoom(section)
  }
  // A `{specifier}` (e.g. `{Bash}`) sets the section's product language; a tangle
  // ({path}) or a plain section takes the document default.
  const languageId =
    spec?.type === 'Specifier' ? spec.label.value.toLowerCase() : defaultLang
  const path =
    spec?.type === 'PathSpecifier'
      ? prose(escapeString(spec.label.value), spec.label.position)
      : undefined
  return projectService(section, titles, languageId, path)
}

// =============================================================================
// Document.
// =============================================================================

export const transduce = (doc: LoomDocument): FrameModule => {
  const titles = titleIndex(doc)
  const defaultLang = langOf(doc)
  const projected = doc.sections.map((s) =>
    projectSection(s, titles, defaultLang),
  )

  const members = projected.map((p) => MemberItemSchema.make({ value: p.member }))
  const imports = projected.flatMap((p) => p.imports)
  const layers = projected.flatMap((p) =>
    p.layer ? [LayerRefSchema.make({ name: p.layer })] : [],
  )
  const sinks = projected.flatMap((p) =>
    p.sink
      ? [SinkItemSchema.make({ value: SinkRefSchema.make({ name: p.sink }) })]
      : [],
  )

  const [head, ...rest] = layers
  const root =
    head === undefined
      ? undefined
      : RootSchema.make({
          head,
          tail: rest.map((value) => LayerRefItemSchema.make({ value })),
          sinks,
        })

  return FrameModuleSchema.make({ imports, members, root })
}

// Transducer — the LAST → FAST arrow as an Effect.Service.
export class Transducer extends Effect.Service<Transducer>()('Transducer', {
  succeed: {
    run: (doc: LoomDocument) => Effect.sync(() => transduce(doc)),
  },
}) {}
