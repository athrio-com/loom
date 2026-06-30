import { Array, Effect, Match, Option, Order, pipe } from 'effect'
import type { LoomDocument, LoomSection } from '@athrio/loom-ast/LoomAst'
import { okHealth, type Health, type Point, type Position } from '@athrio/loom-ast/LoomNode'
import type {
  SinkToken,
  WarpAnchorToken,
  WarpToken,
} from '@athrio/loom-ast/LoomTokens'
import type { PreambleWeft, SectionBodyWeft } from '@athrio/loom-ast/Weft'
import type { SectionId } from '@athrio/loom-ast/ProductAst'
import { sinkPathOf } from '@athrio/loom-ast/LoomCorpusAst'
import {
  AmbiguousAnchor,
  CrossLanguageAnchor,
  faulty,
  UnresolvedAnchor,
} from '#ast/LoomFault'
import { normaliseTitle } from '#ast/WeftTokeniser'
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
  WeaveArgItemSchema,
  WeaveSchema,
  type EmbeddedCode,
  EmbeddedCodeSchema,
  type ValueRef,
  ValueRefSchema,
  type FrameAuthoredToken,
  FrameAuthoredTokenSchema,
  type FrameModule,
  FrameModuleSchema,
  FrameSynthTokenSchema,
  EffectfulBodySchema,
  MemberItemSchema,
  RootSchema,
  type ServiceBody,
  type ServiceClass,
  ServiceClassSchema,
  type ServiceName,
  StaticBodySchema,
  TangleBodySchema,
} from '@athrio/loom-ast/FrameAst'

export class FrameAstBuilder extends Effect.Service<FrameAstBuilder>()(
  'FrameAstBuilder',
  {
    succeed: {
      build: (
        doc: LoomDocument,
        path: string,
        packageLanguage?: string,
      ): Effect.Effect<FrameModule> =>
        Effect.sync(() => buildFrame(doc, path, packageLanguage)),
    },
  },
) {}

export const buildFrame = (
  doc: LoomDocument,
  modulePath: string,
  packageLanguage?: string,
): FrameModule => {
  const lang = documentLanguage(doc.preamble) ?? packageLanguage ?? 'plaintext'
  const index = nameIndex(doc.sections, lang)
  return pipe(
    doc.sections,
    Array.map(buildMember(index, lang, modulePath)),
    Array.reduce(emptyFrame, appendMember),
    finaliseModule,
  )
}

type NameEntry = {
  readonly name: string
  readonly pos: Position
  readonly language: string
}
type NameIndex = ReadonlyMap<string, ReadonlyArray<NameEntry>>

const reservedLanguage: Record<string, string> = { config: 'yaml' }

const specifierLanguage = (label: string): string => {
  const id = label.toLowerCase()
  return reservedLanguage[id] ?? id
}

const sectionLanguage = (section: LoomSection, defaultLang: string): string => {
  const { specifier, sink } = section.heading
  if (specifier !== undefined) return specifierLanguage(specifier.label.value)
  if (sink === undefined) return defaultLang
  return sink.file !== undefined ? extensionLanguage(sink.file.value) : 'prose'
}

const nameIndex = (
  sections: ReadonlyArray<LoomSection>,
  defaultLang: string,
): NameIndex =>
  pipe(
    sections,
    Array.filterMap((s) =>
      Option.map(Option.fromNullable(s.heading.title), (title) =>
        [
          title.source,
          {
            name: serviceNameOf(s),
            pos: title.position,
            language: sectionLanguage(s, defaultLang),
          },
        ] as const,
      ),
    ),
    Array.reduce(
      new Map<string, ReadonlyArray<NameEntry>>(),
      (index, [title, entry]) =>
        new Map(index).set(title, [...(index.get(title) ?? []), entry]),
    ),
  )

const documentLanguage = (
  preamble: ReadonlyArray<PreambleWeft>,
): string | undefined =>
  preamble
    .flatMap((w) => w.warps)
    .find((w) => w.name.value === 'lang')
    ?.annotation?.value.trim()
    .toLowerCase()

const languageByExtension: ReadonlyMap<string, string> = new Map([
  ['ts', 'typescript'],
  ['mts', 'typescript'],
  ['cts', 'typescript'],
  ['tsx', 'tsx'],
  ['js', 'javascript'],
  ['mjs', 'javascript'],
  ['cjs', 'javascript'],
  ['jsx', 'jsx'],
  ['json', 'json'],
])

const extensionLanguage = (path: string): string => {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  return languageByExtension.get(ext) ?? ext
}

interface ValueWarp {
  readonly text: string
  readonly pos: Position
}

const valueWarps = (
  warps: ReadonlyArray<WarpToken>,
): ReadonlyMap<string, ValueWarp> =>
  new Map(
    Array.filterMap(warps, (w) =>
      w.default
        ? Option.some([
            w.name.value,
            { text: w.default.value, pos: w.default.position },
          ] as const)
        : Option.none(),
    ),
  )

interface ServiceInfo {
  readonly name: string
  readonly deps: ReadonlyArray<string>
  readonly sink: boolean
}

interface Built {
  readonly member: ServiceClass
  readonly service: Option.Option<ServiceInfo>
}

const buildMember =
  (index: NameIndex, lang: string, modulePath: string) =>
  (section: LoomSection): Built => {
    const tanglePath = pipe(
      Option.fromNullable(section.heading.sink),
      Option.filter((sink) => sink.file !== undefined),
      Option.map(pathOf),
    )
    return buildService(index, lang, section, modulePath, tanglePath)
  }

const buildService = (
  index: NameIndex,
  defaultLang: string,
  section: LoomSection,
  modulePath: string,
  tanglePath: Option.Option<FrameAuthoredToken>,
): Built => {
  const warps = section.preamble.flatMap((w) => w.warps)
  const values = valueWarps(warps)

  const name = serviceNameOf(section)
  const origin: SectionId = { path: modulePath, name }
  const languageId = sectionLanguage(section, defaultLang)

  const { compose, internals } = buildCompose(
    section,
    values,
    index,
    origin,
    languageId,
  )

  const service = ServiceClassSchema.make({
    modifier: FrameSynthTokenSchema.make({
      text: Option.isNone(tanglePath) ? 'export ' : '',
    }),
    name: serviceName(section),
    nameType: FrameSynthTokenSchema.make({ text: name }),
    nameTag: tok(serviceTag(origin)),
    body: bodyOf(section, tanglePath, internals, compose, origin),
    languageId,
  })

  return {
    member: service,
    service: Option.some({
      name,
      deps: internals.map((b) => b.tag.text),
      sink: Option.isSome(tanglePath),
    }),
  }
}

const bodyOf = (
  section: LoomSection,
  tanglePath: Option.Option<FrameAuthoredToken>,
  bindings: ReadonlyArray<Binding>,
  compose: Compose,
  origin: SectionId,
): ServiceBody =>
  Option.match(tanglePath, {
    onSome: (p) =>
      TangleBodySchema.make({ bindings: items(bindings), path: p, code: compose }),
    onNone: () =>
      bindings.length > 0
        ? EffectfulBodySchema.make({
            bindings: items(bindings),
            name: titleField(section),
            prose: proseField(section, origin),
            code: compose,
          })
        : StaticBodySchema.make({
            name: titleField(section),
            prose: proseField(section, origin),
            code: compose,
          }),
  })

const items = (bindings: ReadonlyArray<Binding>) =>
  bindings.map((value) => BindingItemSchema.make({ value }))

const buildCompose = (
  section: LoomSection,
  values: ReadonlyMap<string, ValueWarp>,
  index: NameIndex,
  origin: SectionId,
  languageId: string,
): { readonly compose: Compose; readonly internals: ReadonlyArray<Binding> } => {
  const walked = Array.map(
    codeRuns(section.code),
    walkRun(bindAnchor(index, values, languageId)),
  )
  const args = Array.flatMap(walked, (w) => w.args)
  const internals = dedupeByName(Array.flatMap(walked, (w) => w.bindings))

  const compose = ComposeSchema.make({
    origin: tok(sectionIdLiteral(origin)),
    lang: tok(JSON.stringify(languageId)),
    args: Array.map(args, (value) => ComposeArgItemSchema.make({ value })),
  })
  return { compose, internals }
}

type ComposeArg = EmbeddedCode | CodeRef | ValueRef

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
      const position = between(from, to)
      return lit.length === 0
        ? []
        : [
            EmbeddedCodeSchema.make({
              text: escapeTemplate(lit),
              position,
              origin: tok(posLiteral(position)),
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
  readonly ref: ComposeArg
  readonly binding: Option.Option<Binding>
}

const bindAnchor =
  (index: NameIndex, values: ReadonlyMap<string, ValueWarp>, host: string) =>
  (anchor: WarpAnchorToken): Bound => {
    const name = anchor.name.value
    const at = anchor.name.position
    if (anchor.health.status !== 'ok') {
      return { ref: blankFragment(anchor.position), binding: Option.none() }
    }
    const value = values.get(name)
    if (value !== undefined) {
      return { ref: valueRef(value, at), binding: Option.none() }
    }
    return Array.matchLeft(index.get(name) ?? [], {
      onEmpty: () => ({
        ref: blankFragment(anchor.position, unresolved(name, at)),
        binding: Option.none(),
      }),
      onNonEmpty: (entry, rest) =>
        rest.length === 0
          ? {
              ref: codeRef(
                aliasOf(entry.name),
                at,
                entry.language === host
                  ? okHealth
                  : crossLanguage(name, at, host, entry.language),
              ),
              binding: Option.some(nameBinding(entry.name, entry.pos)),
            }
          : {
              ref: blankFragment(anchor.position, ambiguous(name, at, rest.length + 1)),
              binding: Option.none(),
            },
    })
  }

const codeRef = (
  name: string,
  at: Position,
  health: Health = okHealth,
): CodeRef =>
  CodeRefSchema.make({
    open: tok('dsl.referName('),
    binding: anchorId(name, at, health),
    anchor: tok(posLiteral(at)),
  })

const blankFragment = (at: Position, health: Health = okHealth): EmbeddedCode =>
  EmbeddedCodeSchema.make({
    text: '',
    position: at,
    origin: tok(posLiteral(at)),
    health,
  })

const valueRef = (value: ValueWarp, at: Position): ValueRef =>
  ValueRefSchema.make({
    value: id(value.text, value.pos),
    anchor: tok(posLiteral(at)),
  })

const aliasOf = (service: string): string => `_${service}`

const nameBinding = (service: string, headingPos: Position): Binding =>
  BindingSchema.make({
    name: headingId(aliasOf(service), headingPos),
    tag: FrameSynthTokenSchema.make({ text: service }),
  })

const unresolved = (name: string, at: Position): Health =>
  faulty(UnresolvedAnchor({ name }), at)

const ambiguous = (name: string, at: Position, count: number): Health =>
  faulty(AmbiguousAnchor({ name, count }), at)

const crossLanguage = (
  name: string,
  at: Position,
  host: string,
  found: string,
): Health => faulty(CrossLanguageAnchor({ name, host, found }), at)

interface FrameBuilder {
  readonly members: ReadonlyArray<ReturnType<typeof MemberItemSchema.make>>
  readonly services: ReadonlyArray<ServiceInfo>
}

const emptyFrame: FrameBuilder = {
  members: [],
  services: [],
}

const appendMember = (b: FrameBuilder, built: Built): FrameBuilder => ({
  members: [...b.members, MemberItemSchema.make({ value: built.member })],
  services: [...b.services, ...Option.toArray(built.service)],
})

const finaliseModule = (b: FrameBuilder): FrameModule =>
  FrameModuleSchema.make({
    members: b.members,
    root: buildRoot(b.services),
  })

const buildRoot = (services: ReadonlyArray<ServiceInfo>) =>
  Array.matchLeft(services, {
    onEmpty: () => undefined,
    onNonEmpty: () =>
      RootSchema.make({
        services: FrameSynthTokenSchema.make({ text: servicesLiteral(services) }),
        run: FrameSynthTokenSchema.make({ text: runLiteral(services) }),
      }),
  })

const servicesLiteral = (services: ReadonlyArray<ServiceInfo>): string => {
  const entries = Array.map(
    services,
    (s) =>
      `  ${s.name}: { layer: ${s.name}.Default, self: ${s.name}, deps: [${s.deps.join(', ')}] }`,
  )
  return `{\n${entries.join(',\n')}\n}`
}

const runLiteral = (services: ReadonlyArray<ServiceInfo>): string => {
  const content = Array.filter(services, (s) => !s.sink)
  const sinks = Array.filter(services, (s) => s.sink)
  const codeEntries = Array.map(
    services,
    (s) => `      [${JSON.stringify(s.name)}, (yield* ${s.name}).code]`,
  ).join(',\n')
  const proseEntries = Array.map(
    content,
    (s) => `      [${JSON.stringify(s.name)}, (yield* ${s.name}).prose]`,
  ).join(',\n')
  const fileEntries = Array.map(sinks, (s) => `      yield* ${s.name}`).join(',\n')
  return `Effect.gen(function* () {
  return {
    sections: new Map([
${codeEntries}
    ]),
    prose: new Map([
${proseEntries}
    ]),
    files: [
${fileEntries}
    ],
  }
})`
}

const serviceNameOf = (section: LoomSection): string =>
  normaliseTitle(section.heading.title?.source ?? '')

const serviceName = (section: LoomSection): ServiceName =>
  FrameSynthTokenSchema.make({ text: serviceNameOf(section) })

const tok = (text: string) => FrameSynthTokenSchema.make({ text })

const id = (
  text: string,
  position: Position,
  health: Health = okHealth,
): FrameAuthoredToken =>
  FrameAuthoredTokenSchema.make({ text, position, kind: 'name', health })

const headingId = (text: string, position: Position): FrameAuthoredToken =>
  FrameAuthoredTokenSchema.make({ text, position, kind: 'heading' })

const anchorId = (
  text: string,
  position: Position,
  health: Health = okHealth,
): FrameAuthoredToken =>
  FrameAuthoredTokenSchema.make({ text, position, kind: 'anchor', health })

const prose = (text: string, position: Position): FrameAuthoredToken =>
  FrameAuthoredTokenSchema.make({ text, position, kind: 'prose' })

const proseField = (section: LoomSection, origin: SectionId): Weave => {
  const src = sourceOf(section.preamble)
  const originTok = tok(sectionIdLiteral(origin))
  if (src.length === 0) return WeaveSchema.make({ origin: originTok, args: [] })
  const position = preamblePos(section)
  return WeaveSchema.make({
    origin: originTok,
    args: [
      WeaveArgItemSchema.make({
        value: ProseFragmentSchema.make({
          text: escapeTemplate(src),
          position,
          origin: FrameSynthTokenSchema.make({ text: posLiteral(position) }),
        }),
      }),
    ],
  })
}

const titleField = (section: LoomSection): ServiceName =>
  FrameSynthTokenSchema.make({
    text: escapeTemplate(section.heading.title?.source ?? ''),
  })

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

const sectionIdLiteral = (id: SectionId): string =>
  `{ path: ${JSON.stringify(id.path)}, name: ${JSON.stringify(id.name)} }`

const serviceTag = (id: SectionId): string =>
  escapeString(`${id.path}#${id.name}`)

const pointLiteral = (p: Point): string =>
  p.column === undefined
    ? `{ line: ${p.line}, offset: ${p.offset} }`
    : `{ line: ${p.line}, column: ${p.column}, offset: ${p.offset} }`

const posLiteral = (position: Position): string =>
  `{ start: ${pointLiteral(position.start)}, end: ${pointLiteral(position.end)} }`

const escapeTemplate = (s: string): string =>
  s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${')

const escapeString = (s: string): string =>
  s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')

const pathOf = (sink: SinkToken) =>
  prose(escapeString(sinkPathOf(sink)), sink.position)
