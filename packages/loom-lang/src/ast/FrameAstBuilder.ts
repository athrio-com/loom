import { Array, Effect, Match, Option, Order, pipe } from 'effect'
import type { LoomDocument, LoomSection } from '#ast/LoomAst'
import { okHealth, type Health, type Point, type Position } from '@athrio/loom-core/LoomNode'
import type { WarpAnchorToken, WarpToken } from '#ast/LoomTokens'
import type { PreambleWeft, SectionBodyWeft } from '#ast/Weft'
import type { SectionId } from '@athrio/loom-core/ProductAst'
import {
  AmbiguousAnchor,
  CrossLanguageAnchor,
  faulty,
  UnresolvedAnchor,
} from '#ast/LoomFault'
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
  type FrameCode,
  FrameCodeSchema,
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
} from '#ast/FrameAst'

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
  const known = knownServices(doc.sections)
  return pipe(
    doc.sections,
    Array.map(buildMember(index, known, lang, modulePath)),
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

const sectionLanguage = (section: LoomSection, defaultLang: string): string => {
  const spec = section.heading.specifier
  return spec?.type === 'PathSpecifier'
    ? extensionLanguage(spec.label.value)
    : spec?.type === 'Specifier'
      ? spec.label.value.toLowerCase()
      : defaultLang
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

const isLoomSection = (section: LoomSection): boolean =>
  section.heading.specifier?.type === 'Specifier' &&
  section.heading.specifier.label.value === 'Loom'

const importBindings = (line: string): ReadonlyArray<string> => {
  const brace = /\{([^}]*)\}/.exec(line)
  const named = brace
    ? pipe(
        brace[1].split(','),
        Array.filterMap((part) => {
          const m = /(?:[\w$]+\s+as\s+)?([\w$]+)/.exec(part.trim())
          return m ? Option.some(m[1]) : Option.none()
        }),
      )
    : []
  const namespace = /\*\s+as\s+([\w$]+)/.exec(line)
  const fallback = /import\s+(?:type\s+)?([\w$]+)\s*(?:,|from)/.exec(line)
  return [
    ...(fallback ? [fallback[1]] : []),
    ...(namespace ? [namespace[1]] : []),
    ...named,
  ]
}

const importNamesOf = (section: LoomSection): ReadonlyArray<string> =>
  pipe(
    Array.filterMap(section.code, pieceOf),
    Array.filter((p) => /^\s*import\s/.test(p.source)),
    Array.flatMap((p) => importBindings(p.source)),
  )

const importedSymbols = (
  sections: ReadonlyArray<LoomSection>,
): ReadonlySet<string> =>
  new Set(
    Array.flatMap(sections, (s) => (isLoomSection(s) ? importNamesOf(s) : [])),
  )

const serviceNames = (
  sections: ReadonlyArray<LoomSection>,
): ReadonlyArray<string> => Array.map(sections, serviceNameOf)

const knownServices = (
  sections: ReadonlyArray<LoomSection>,
): ReadonlySet<string> =>
  new Set([...importedSymbols(sections), ...serviceNames(sections)])

interface ValueWarp {
  readonly text: string
  readonly pos: Position
}

interface WarpScope {
  readonly services: ReadonlySet<string>
  readonly values: ReadonlyMap<string, ValueWarp>
}

const isIdentifier = (s: string): boolean => /^[A-Za-z_$][\w$]*$/.test(s)

const scopeOf = (
  warps: ReadonlyArray<WarpToken>,
  known: ReadonlySet<string>,
): WarpScope => {
  const bound = warps.filter((w) => w.default !== undefined)
  const isService = (w: WarpToken): boolean => {
    const value = w.default?.value.trim() ?? ''
    return isIdentifier(value) && known.has(value)
  }
  const [values, services] = Array.partition(bound, isService)
  return {
    services: new Set(services.map((w) => w.name.value)),
    values: new Map(
      Array.filterMap(values, (w) =>
        w.default
          ? Option.some([
              w.name.value,
              { text: w.default.value, pos: w.default.position },
            ] as const)
          : Option.none(),
      ),
    ),
  }
}

interface ServiceInfo {
  readonly name: string
  readonly deps: ReadonlyArray<string>
  readonly sink: boolean
}

interface Built {
  readonly member: ServiceClass | FrameCode
  readonly service: Option.Option<ServiceInfo>
  readonly imports: ReadonlyArray<FrameCode>
}

const buildMember =
  (
    index: NameIndex,
    known: ReadonlySet<string>,
    lang: string,
    modulePath: string,
  ) =>
  (section: LoomSection): Built =>
    pipe(
      Match.value(section.heading.specifier),
      Match.when({ type: 'PathSpecifier' }, (spec) =>
        buildService(
          index,
          known,
          lang,
          section,
          modulePath,
          Option.some(pathOf(spec)),
        ),
      ),
      Match.when({ type: 'Specifier', label: { value: 'Loom' } }, () =>
        buildSplice(section),
      ),
      Match.orElse(() =>
        buildService(index, known, lang, section, modulePath, Option.none()),
      ),
    )

const buildService = (
  index: NameIndex,
  known: ReadonlySet<string>,
  defaultLang: string,
  section: LoomSection,
  modulePath: string,
  tanglePath: Option.Option<FrameAuthoredToken>,
): Built => {
  const warps = section.preamble.flatMap((w) => w.warps)
  const scope = scopeOf(warps, known)

  const name = serviceNameOf(section)
  const origin: SectionId = { path: modulePath, name }
  const languageId = sectionLanguage(section, defaultLang)

  const { compose, internals } = buildCompose(
    section,
    scope,
    index,
    origin,
    languageId,
  )
  const serviceWarps = warps.filter((w) => scope.services.has(w.name.value))
  const bindings = [...serviceWarps.map(warpBinding), ...internals]

  const nameRef = FrameSynthTokenSchema.make({ text: name })
  const service = ServiceClassSchema.make({
    modifier: FrameSynthTokenSchema.make({
      text: Option.isNone(tanglePath) && isExported(section) ? 'export ' : '',
    }),
    name: serviceName(section),
    nameType: nameRef,
    nameTag: tok(serviceTag(origin)),
    body: bodyOf(section, tanglePath, bindings, compose, origin),
    languageId,
  })

  return {
    member: service,
    service: Option.some({
      name,
      deps: bindings.map((b) => b.tag.text),
      sink: Option.isSome(tanglePath),
    }),
    imports: [],
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
    service: Option.none(),
    imports: pipe(
      pieces,
      Array.filter(isImport),
      Array.map((p) => FrameCodeSchema.make({ text: p.source, position: p.position })),
    ),
  }
}

const buildCompose = (
  section: LoomSection,
  scope: WarpScope,
  index: NameIndex,
  origin: SectionId,
  languageId: string,
): { readonly compose: Compose; readonly internals: ReadonlyArray<Binding> } => {
  const walked = Array.map(
    codeRuns(section.code),
    walkRun(bindAnchor(index, scope, languageId)),
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
  (index: NameIndex, scope: WarpScope, host: string) =>
  (anchor: WarpAnchorToken): Bound => {
    const name = anchor.name.value
    const at = anchor.name.position
    if (anchor.health.status !== 'ok') {
      return { ref: blankFragment(anchor.position), binding: Option.none() }
    }
    const value = scope.values.get(name)
    if (value !== undefined) {
      return { ref: valueRef(value, at), binding: Option.none() }
    }
    if (scope.services.has(name)) {
      return { ref: codeRef('referTag', name, at), binding: Option.none() }
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
                'referName',
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
  verb: 'referName' | 'referTag',
  name: string,
  at: Position,
  health: Health = okHealth,
): CodeRef =>
  CodeRefSchema.make({
    open: tok(`core.${verb}(`),
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

const warpBinding = (warp: WarpToken): Binding =>
  BindingSchema.make({
    name: id(warp.name.value, warp.name.position),
    tag: warp.default
      ? id(warp.default.value.trim(), warp.default.position)
      : tok(''),
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
  readonly imports: ReadonlyArray<FrameCode>
  readonly members: ReadonlyArray<ReturnType<typeof MemberItemSchema.make>>
  readonly services: ReadonlyArray<ServiceInfo>
}

const emptyFrame: FrameBuilder = {
  imports: [],
  members: [],
  services: [],
}

const appendMember = (b: FrameBuilder, built: Built): FrameBuilder => ({
  imports: [...b.imports, ...built.imports],
  members: [...b.members, MemberItemSchema.make({ value: built.member })],
  services: [...b.services, ...Option.toArray(built.service)],
})

const finaliseModule = (b: FrameBuilder): FrameModule =>
  FrameModuleSchema.make({
    imports: b.imports,
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
  section.heading.tag?.label.value ?? ''

const serviceName = (section: LoomSection): ServiceName => {
  const tag = section.heading.tag
  return isExported(section) && tag !== undefined
    ? tagId(tag.label.value, tag.label.position)
    : FrameSynthTokenSchema.make({ text: serviceNameOf(section) })
}

const isExported = (section: LoomSection): boolean => {
  const tag = section.heading.tag
  return (
    tag !== undefined &&
    tag.label.position.end.offset > tag.label.position.start.offset
  )
}

const tok = (text: string) => FrameSynthTokenSchema.make({ text })

const tagId = (text: string, position: Position): FrameAuthoredToken =>
  FrameAuthoredTokenSchema.make({ text, position, kind: 'tag' })

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

const pathOf = (spec: { label: { value: string; position: Position } }) =>
  prose(escapeString(spec.label.value), spec.label.position)
