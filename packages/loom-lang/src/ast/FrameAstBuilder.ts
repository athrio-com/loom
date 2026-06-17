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
  ProseFragmentSchema,
  type Weave,
  WeaveSchema,
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

export class FrameAstBuilder extends Effect.Service<FrameAstBuilder>()(
  'FrameAstBuilder',
  {
    succeed: {
      build: (doc: LoomDocument): Effect.Effect<FrameModule> =>
        Effect.sync(() => buildFrame(doc)),
    },
  },
) {}

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

type NameIndex = ReadonlyMap<string, ReadonlyArray<string>>

const nameIndex = (sections: ReadonlyArray<LoomSection>): NameIndex =>
  pipe(
    sections,
    Array.filterMap((s) =>
      Option.map(Option.fromNullable(s.heading.title), (title) =>
        [title.source, serviceNameOf(s)] as const,
      ),
    ),
    Array.reduce(
      new Map<string, ReadonlyArray<string>>(),
      (index, [title, name]) =>
        new Map(index).set(title, [...(index.get(title) ?? []), name]),
    ),
  )

const primaryLanguage = (preamble: ReadonlyArray<PreambleWeft>): string =>
  preamble
    .flatMap((w) => w.warps)
    .find((w) => w.name.value === 'lang')
    ?.annotation.value.trim()
    .toLowerCase() ?? 'plaintext'

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
            prose: proseField(section),
            code: compose,
          })
        : StaticBodySchema.make({
            name: titleField(section),
            prose: proseField(section),
            code: compose,
          }),
  })

const items = (bindings: ReadonlyArray<Binding>) =>
  bindings.map((value) => BindingItemSchema.make({ value }))

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

const isBlank = (p: CodePiece): boolean => p.source.trim().length === 0

const dropLeadingBlank = (
  run: ReadonlyArray<CodePiece>,
): ReadonlyArray<CodePiece> => Array.dropWhile(run, isBlank)

const dropTrailingBlank = (
  run: ReadonlyArray<CodePiece>,
): ReadonlyArray<CodePiece> =>
  pipe(run, Array.reverse, Array.dropWhile(isBlank), Array.reverse)

const trimBlank = (
  run: ReadonlyArray<CodePiece>,
): ReadonlyArray<CodePiece> => dropTrailingBlank(dropLeadingBlank(run))

const seamTrailing = (
  run: ReadonlyArray<CodePiece>,
): ReadonlyArray<CodePiece> => {
  const lead = dropLeadingBlank(run)
  const body = dropTrailingBlank(lead)
  return Option.match(Array.get(lead, body.length), {
    onNone: () => body,
    onSome: (blank) => [...body, blank],
  })
}

const sealRuns = (
  runs: ReadonlyArray<ReadonlyArray<CodePiece>>,
): ReadonlyArray<ReadonlyArray<CodePiece>> =>
  Array.map(runs, (run, i) =>
    i === runs.length - 1 ? trimBlank(run) : seamTrailing(run),
  )

const codeRuns = (
  code: ReadonlyArray<SectionBodyWeft>,
): ReadonlyArray<ReadonlyArray<CodePiece>> =>
  Array.isNonEmptyReadonlyArray(code)
    ? pipe(
        code,
        Array.groupWith((a, _b) => a.type !== 'ArrowWeft'),
        Array.map((block) => Array.filterMap(block, pieceOf)),
        Array.filter((run) => Array.some(run, (p) => !isBlank(p))),
        sealRuns,
      )
    : []

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

const byStart: Order.Order<WarpAnchorToken> = Order.mapInput(
  Order.number,
  (a) => a.position.start.offset,
)

const dedupeByName = (
  bindings: ReadonlyArray<Binding>,
): ReadonlyArray<Binding> =>
  [...new Map(bindings.map((b) => [b.name.text, b])).values()]

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
    return Array.matchLeft(index.get(name) ?? [], {
      onEmpty: () => ({
        ref: codeRef(name, at, unresolved(name, at)),
        binding: Option.none(),
      }),
      onNonEmpty: (service, rest) =>
        rest.length === 0
          ? {
              ref: codeRef(aliasOf(service), at),
              binding: Option.some(nameBinding(service, at)),
            }
          : {
              ref: codeRef(name, at, ambiguous(name, at, rest.length + 1)),
              binding: Option.none(),
            },
    })
  }

const codeRef = (name: string, at: Position, health?: Health): CodeRef =>
  CodeRefSchema.make({ binding: id(name, at, health) })

const aliasOf = (service: string): string => `_${service}`

const nameBinding = (service: string, at: Position): Binding =>
  BindingSchema.make({ name: id(aliasOf(service), at), tag: id(service, at) })

const warpBinding = (warp: WarpToken): Binding =>
  BindingSchema.make({
    name: id(warp.name.value, warp.name.position),
    tag: id(warp.annotation.value.trim(), warp.annotation.position),
  })

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

const ambiguous = (name: string, at: Position, count: number): Health => ({
  status: 'error',
  diagnostics: [
    {
      message: `Ambiguous anchor: ${count} sections are named \`${name}\`. A name anchor resolves one local section; rename to disambiguate.`,
      position: at,
      severity: 'error',
    },
  ],
})

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

const serviceNameOf = (section: LoomSection): string =>
  section.heading.tag?.label.value ?? ''

const serviceName = (section: LoomSection): ServiceName => {
  const tag = section.heading.tag
  return isExported(section) && tag !== undefined
    ? id(tag.label.value, tag.label.position)
    : FrameSynthTokenSchema.make({ text: serviceNameOf(section) })
}

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

const docPreamble = (section: LoomSection): FrameAuthoredToken =>
  prose(escapeComment(sourceOf(section.preamble)), preamblePos(section))

const proseField = (section: LoomSection): Weave => {
  const src = sourceOf(section.preamble)
  return src.length === 0
    ? WeaveSchema.make({ tail: [] })
    : WeaveSchema.make({
        head: ProseFragmentSchema.make({
          text: escapeTemplate(src),
          position: preamblePos(section),
        }),
        tail: [],
      })
}

const titleField = (section: LoomSection): FrameAuthoredToken =>
  prose(
    escapeTemplate(section.heading.title?.source ?? ''),
    section.heading.title?.position ?? section.heading.position,
  )

const preamblePos = (section: LoomSection): Position =>
  section.preamble.length > 0 ? spanOf(section.preamble) : endOf(section)

const endOf = (section: LoomSection): Position =>
  between(section.heading.position.end, section.heading.position.end)

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
