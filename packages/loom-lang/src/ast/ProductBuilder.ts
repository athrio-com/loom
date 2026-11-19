import { Array, Context, Data, Effect, Layer, Match, Option, Order, pipe, Record, Result } from 'effect'
import { memoize } from 'effect/Function'
import type {
  LoomDocument,
  LoomFrontmatter,
  LoomHeading,
  LoomSection,
} from '@athrio/loom-ast/LoomAst'
import {
  nodeOf,
  okHealth,
  type Diagnostic,
  type Health,
  type Point,
  type Position,
  byType,
  byTypeOr,
} from '@athrio/loom-ast/LoomNode'
import {
  type Catalogue,
  catalogueOf,
  conceptsCalled,
  type Location,
  type LoomModule,
  pathsTo,
  type Place,
  resolveName,
  sectionOf,
  type SectionRef,
  type Trail,
  trailsOf,
} from '@athrio/loom-ast/LoomCorpusAst'
import {
  type Codeless,
  conceptKind,
  headingLang,
  manifestKind,
  moduleKind,
  settleKind,
  tangleKind,
  type FenceLabelToken,
  type ParameterToken,
  type ParametersToken,
  type SinkToken,
  type WarpAnchorTargetToken,
  type WarpAnchorToken,
  type WarpToken,
} from '@athrio/loom-ast/LoomTokens'
import type { ArrowWeft, SectionBodyWeft } from '@athrio/loom-ast/Weft'
import {
  type Code,
  CodeSchema,
  type File,
  FileSchema,
  type Fragment,
  FragmentSchema,
  isMeant,
  keyOf,
  type ModuleRef,
  ModuleRefSchema,
  type NameRef,
  NameRefSchema,
  type Part,
  type Product,
  type Provided,
  type SectionId,
} from '@athrio/loom-ast/ProductAst'
import {
  AmbiguousAnchor,
  ChapterWithoutCode,
  CodeInConcept,
  CodeInKind,
  CodeInProse,
  CompositionCycle,
  ConceptWithoutCode,
  KindWithoutCode,
  type LoomFault,
  CrossLanguageAnchor,
  type Declaration,
  DuplicateName,
  faulty,
  FenceLabelAgainstLanguage,
  NoSuchFile,
  SectionWithoutFile,
  SettledLabel,
  SeveralFiles,
  StrayTarget,
  TangleBesideSink,
  TangleWithoutFile,
  FileInDiscussion,
  FileInKind,
  ManifestOutsideTrope,
  UnsettledModule,
  UnsettledSection,
  UnknownVariable,
  UnresolvedAnchor,
  UnusedSection,
} from '#ast/LoomFault'
import { normaliseTitle } from '#ast/WeftTokeniser'

export class ProductBuilder extends Context.Service<ProductBuilder>()('ProductBuilder', {
  make: Effect.succeed({
    build: (
      doc: LoomDocument,
      path: string,
      packageLanguage?: string,
      variables: Record<string, string> = {},
    ): Effect.Effect<Product> =>
      Effect.sync(() => buildProduct(doc, path, packageLanguage, variables)),
  }),
}) {
  static readonly layer = Layer.effect(this, this.make)
}

export const buildProduct = (
  doc: LoomDocument,
  modulePath: string,
  packageLanguage?: string,
  variables: Record<string, string> = {},
): Product => {
  const pkg = documentPackage(doc)
  const lang = documentLanguage(doc, packageLanguage)
  const index = nameIndex(doc.sections, lang, pkg)
  const first = firstHolders(doc.sections)
  return doc.sections
    .map(
      buildSection(index, first, lang, modulePath, pkg, variables, isDiscussion(doc), isTrope(doc)),
    )
    .reduce(appendSection, emptyProduct)
}

const documentPackage = (doc: LoomDocument): Option.Option<string> =>
  pipe(
    Option.fromNullishOr(doc.frontmatter),
    Option.flatMapNullishOr((f) => f.package),
    Option.map((p) => p.value),
  )

const documentLanguage = (doc: LoomDocument, packageLanguage?: string): string =>
  pipe(
    frontmatterLanguage(Option.fromNullishOr(doc.frontmatter)),
    Option.orElse(() => Option.fromNullishOr(packageLanguage)),
    Option.getOrElse(() => 'plaintext'),
  )

const emptyProduct: Product = { code: [], files: [] }

const appendSection = (product: Product, built: Built): Product => ({
  code: [...product.code, built.code],
  files: [...product.files, ...Option.toArray(built.file)],
})

type NameEntry = {
  readonly name: string
  readonly pos: Position
  readonly language: string
  readonly written: boolean
  readonly codeless: Option.Option<Codeless>
}
type NameIndex = ReadonlyMap<string, ReadonlyArray<NameEntry>>

const kindLanguage = Match.fn(
  (
    kind: string,
    _sink: Option.Option<SinkToken>,
    _defaultLang: string,
    _pkg: Option.Option<string>,
  ) => kind,
).pipe(
  Match.withReturnType<Option.Option<string>>(),
  Match.when(tangleKind, (_matched, _kind, sink, defaultLang, pkg) =>
    Option.some(
      Option.match(pkg, {
        onNone: () => defaultLang,
        onSome: (p) => extensionLanguage(tangleFilePath(p, sink)),
      }),
    ),
  ),
  Match.when(manifestKind, () => Option.some('json')),
  Match.orElse(() => Option.none()),
)

const unmarkedLanguage = (sink: Option.Option<SinkToken>, defaultLang: string): string =>
  Option.match(sink, {
    onNone: () => defaultLang,
    onSome: (written) => extensionLanguage(written.file.value),
  })

export const sectionLanguage = (
  section: LoomSection,
  defaultLang: string,
  pkg: Option.Option<string>,
): string => {
  const sink = Option.fromNullishOr(section.heading.sink)
  return pipe(
    Option.flatMap(Option.fromNullishOr(section.heading.specifier), headingLang),
    Option.map((lang) => lang.toLowerCase()),
    Option.orElse(() =>
      Option.flatMap(Option.fromNullishOr(section.kind), (kind) =>
        kindLanguage(kind, sink, defaultLang, pkg),
      ),
    ),
    Option.getOrElse(() => unmarkedLanguage(sink, defaultLang)),
  )
}

const nameIndex = (
  sections: ReadonlyArray<LoomSection>,
  defaultLang: string,
  pkg: Option.Option<string>,
): NameIndex =>
  pipe(
    sections.map((s) =>
      Option.map(
        Option.fromNullishOr(s.heading.title),
        (title) =>
          [
            title.source,
            {
              name: sectionNameOf(s),
              pos: title.position,
              language: sectionLanguage(s, defaultLang, pkg),
              written: Array.isReadonlyArrayNonEmpty(codeRuns(s.code)),
              codeless: codelessKind(s),
            },
          ] as const,
      ),
    ),
    Array.getSomes,
    Array.reduce(new Map<string, ReadonlyArray<NameEntry>>(), (index, [title, entry]) =>
      new Map(index).set(title, [...(index.get(title) ?? []), entry]),
    ),
  )

const frontmatterLanguage = (frontmatter: Option.Option<LoomFrontmatter>): Option.Option<string> =>
  pipe(
    frontmatter,
    Option.flatMapNullishOr((f) => f.language),
    Option.map((l) => l.value.trim().toLowerCase()),
  )

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
  ['md', 'markdown'],
  ['yml', 'yaml'],
  ['txt', 'plaintext'],
  ['license', 'plaintext'],
  ['licence', 'plaintext'],
  ['gitignore', 'ignore'],
])

const isIgnoreFile = (name: string): boolean => name.startsWith('.') && name.endsWith('ignore')

export const extensionLanguage = (path: string): string => {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
  const dot = name.lastIndexOf('.')
  const ext = dot < 0 ? name : name.slice(dot + 1)
  return languageByExtension.get(ext) ?? (isIgnoreFile(name) ? 'ignore' : ext)
}

interface ValueWarp {
  readonly text: string
  readonly pos: Position
  readonly health: Health
}

const decodeLiteral = (text: string): string => {
  const s = text.trim()
  const quoted = /^"(?:\\.|[^"\\])*"$/.test(s) || /^'(?:\\.|[^'\\])*'$/.test(s)
  return quoted ? s.slice(1, -1).replace(/\\(.)/g, (_, c) => c) : text
}

const variablePattern = /[$][{]([A-Za-z_][A-Za-z0-9_]*)[}]/g

const interpolate = (
  text: string,
  variables: Record<string, string>,
): { readonly text: string; readonly missing: Option.Option<string> } => ({
  text: text.replace(variablePattern, (whole, name: string) =>
    name in variables ? variables[name]! : whole,
  ),
  missing: Array.head(
    Array.fromIterable(text.matchAll(variablePattern))
      .map((match) => match[1]!)
      .filter((name) => !(name in variables)),
  ),
})

const valueWarps = (
  warps: ReadonlyArray<WarpToken>,
  variables: Record<string, string>,
): ReadonlyMap<string, ValueWarp> =>
  new Map(
    Array.getSomes(
      warps.map((w) =>
        Option.map(Option.fromNullishOr(w.default), (def) => {
          const { text, missing } = interpolate(decodeLiteral(def.value), variables)
          return [
            w.name.value,
            {
              text,
              pos: def.position,
              health: Option.match(missing, {
                onNone: () => okHealth,
                onSome: (name) => faulty(UnknownVariable({ name }), def.position),
              }),
            },
          ] as const
        }),
      ),
    ),
  )

interface Built {
  readonly code: Code
  readonly file: Option.Option<File>
}

const buildSection =
  (
    index: NameIndex,
    first: ReadonlyMap<string, LoomSection>,
    defaultLang: string,
    modulePath: string,
    pkg: Option.Option<string>,
    variables: Record<string, string>,
    discussion: boolean,
    trope: boolean,
  ) =>
  (section: LoomSection): Built => {
    const values = valueWarps(
      section.preamble.flatMap((w) => w.warps),
      variables,
    )
    const origin: SectionId = { path: modulePath, name: sectionNameOf(section) }
    const languageId = sectionLanguage(section, defaultLang, pkg)
    const health = [
      duplicateHealth(first, section),
      labelHealth(section, languageId),
      fileHealth(section, pkg, discussion),
      trope ? okHealth : manifestOutsideTrope(section),
      codeInProse(section, languageId),
      codeInCodeless(section),
    ].reduce(withHealth, okHealth)
    const code = buildCode(section, values, index, origin, languageId, health)
    const file =
      discussion || writesNoFile(section) ? Option.none<File>() : tangleFile(section, pkg, code)
    return { code, file }
  }

const tangleFilePath = (pkg: string, sink: Option.Option<SinkToken>): string =>
  pkg.endsWith('/')
    ? pkg +
      Option.getOrElse(
        Option.map(sink, (s) => s.file.value),
        () => '',
      )
    : pkg

const filePath = (
  pkg: Option.Option<string>,
  sink: Option.Option<SinkToken>,
): Option.Option<string> =>
  Option.match(pkg, {
    onSome: (p) => Option.some(tangleFilePath(p, sink)),
    onNone: () => Option.map(sink, (s) => s.file.value),
  })

export const singleFile = (pkg: Option.Option<string>): Option.Option<string> =>
  Option.filter(pkg, (p) => !p.endsWith('/'))

const isTangle = (section: LoomSection): boolean => section.kind === tangleKind

const tangleMark = (section: LoomSection): Option.Option<ParametersToken> =>
  Option.filter(Option.fromNullishOr(section.heading.specifier), () => isTangle(section))

const markedPath = Match.fn(
  (
    _within: {
      readonly pkg: Option.Option<string>
      readonly sink: Option.Option<SinkToken>
    },
    marks: { readonly tangle: boolean; readonly sunk: boolean },
  ) => marks,
).pipe(
  Match.withReturnType<Option.Option<string>>(),
  Match.when({ tangle: true, sunk: true }, (_marks, { pkg, sink }) => filePath(pkg, sink)),
  Match.when({ tangle: true }, (_marks, { pkg }) => singleFile(pkg)),
  Match.orElse(() => Option.none<string>()),
)

const tangleFile = (
  section: LoomSection,
  pkg: Option.Option<string>,
  code: Code,
): Option.Option<File> => {
  const sink = Option.fromNullishOr(section.heading.sink)
  const target = Option.match(Option.fromNullishOr(section.heading.specifier), {
    onNone: () => Option.flatMap(sink, () => filePath(pkg, sink)),
    onSome: () =>
      markedPath({ pkg, sink }, { tangle: isTangle(section), sunk: Option.isSome(sink) }),
  })
  return Option.map(target, (path) => nodeOf(FileSchema, { path, code, health: okHealth }))
}

const tangleHealth = (section: LoomSection, pkg: Option.Option<string>): Health =>
  Option.match(tangleMark(section), {
    onNone: () => okHealth,
    onSome: (specifier) =>
      Option.match(Option.fromNullishOr(section.heading.sink), {
        onSome: (sink) =>
          faulty(
            TangleBesideSink({ sink: sink.source, specifier: removalOf(specifier, sink) }),
            specifier.position,
          ),
        onNone: () =>
          Option.match(singleFile(pkg), {
            onSome: () => okHealth,
            onNone: () =>
              faulty(
                TangleWithoutFile(
                  Option.match(pkg, { onNone: () => ({}), onSome: (folder) => ({ folder }) }),
                ),
                specifier.position,
              ),
          }),
      }),
  })

const isDiscussion = (doc: LoomDocument): boolean => doc.frontmatter?.discussion !== undefined

const fileWhereNone = (section: LoomSection, fault: LoomFault): Health =>
  Option.match(
    Option.orElse(Option.fromNullishOr(section.heading.sink), () => tangleMark(section)),
    {
      onNone: () => okHealth,
      onSome: (mark) => faulty(fault, mark.position),
    },
  )

const fileInDiscussion = (section: LoomSection): Health =>
  fileWhereNone(section, FileInDiscussion())

const fileHealth = Match.fn(
  (
    section: LoomSection,
    _pkg: Option.Option<string>,
    discussion: boolean,
  ) => ({ discussion, codeless: writesNoFile(section) }),
).pipe(
  Match.withReturnType<Health>(),
  Match.when({ discussion: true }, (_facts, section) => fileInDiscussion(section)),
  Match.when({ codeless: true }, (_facts, section) => fileInCodeless(section)),
  Match.orElse((_facts, section, pkg) => tangleHealth(section, pkg)),
)

const removalOf = (specifier: ParametersToken, sink: SinkToken): Position =>
  Option.getOrElse(kindParameterSpan(specifier), () =>
    specifier.position.start.offset < sink.position.start.offset
      ? between(specifier.position.start, sink.position.start)
      : between(sink.position.end, specifier.position.end),
  )

const kindParameterSpan = (held: ParametersToken): Option.Option<Position> =>
  pipe(
    Array.findFirstWithIndex(held.parameters, (parameter) => parameter.key.value === 'kind'),
    Option.filter(() => held.parameters.length > 1),
    Option.map(([own, index]) => parameterSpanOf(held, own, index)),
  )

export const isManifest = (section: LoomSection): boolean => section.kind === manifestKind

const isTrope = (doc: LoomDocument): boolean => doc.frontmatter?.trope !== undefined

const manifestOutsideTrope = (section: LoomSection): Health =>
  Option.match(
    Option.filter(Option.fromNullishOr(section.heading.specifier), () => isManifest(section)),
    {
      onNone: () => okHealth,
      onSome: (specifier) => faulty(ManifestOutsideTrope(), specifier.position),
    },
  )

const isArrow = (weft: SectionBodyWeft): weft is ArrowWeft => weft.type === 'ArrowWeft'

const codelessKind = (section: LoomSection): Option.Option<Codeless> =>
  Option.fromNullishOr(section.codeless)

const isConcept = (codeless: Codeless): boolean =>
  codeless.of === 'section' && codeless.kind === conceptKind

const withoutCode = (name: string, codeless: Option.Option<Codeless>): LoomFault =>
  Option.match(
    Option.filter(codeless, (held) => !isConcept(held)),
    {
      onNone: () => ConceptWithoutCode({ name }),
      onSome: (held) => KindWithoutCode({ name, ...held }),
    },
  )

const codeInCodeless = (section: LoomSection): Health =>
  Option.match(codelessKind(section), {
    onNone: () => okHealth,
    onSome: (codeless) =>
      section.code
        .filter(isArrow)
        .map((weft) =>
          faulty(isConcept(codeless) ? CodeInConcept() : CodeInKind(codeless), weft.arrow.position),
        )
        .reduce(withHealth, okHealth),
  })

const writesNoFile = (section: LoomSection): boolean =>
  Option.exists(codelessKind(section), (codeless) => codeless.of === 'loom')

const fileInCodeless = (section: LoomSection): Health =>
  Option.match(codelessKind(section), {
    onNone: () => okHealth,
    onSome: (codeless) => fileWhereNone(section, FileInKind({ kind: codeless.kind })),
  })

const codeInProse = (section: LoomSection, languageId: string): Health =>
  languageId === 'prose'
    ? section.code
        .filter(isArrow)
        .map((weft) => faulty(CodeInProse(), weft.arrow.position))
        .reduce(withHealth, okHealth)
    : okHealth

const buildCode = (
  section: LoomSection,
  values: ReadonlyMap<string, ValueWarp>,
  index: NameIndex,
  origin: SectionId,
  languageId: string,
  health: Health,
): Code => {
  const bind = bindAnchor(index, values, languageId, origin.path)
  const fragments = codeRuns(section.code).flatMap(walkRun(bind))
  return nodeOf(CodeSchema, { origin, languageId, fragments, health })
}

interface CodePiece {
  readonly source: string
  readonly position: Position
  readonly anchors: ReadonlyArray<WarpAnchorToken>
}

const pieceOf: (weft: SectionBodyWeft) => Option.Option<CodePiece> =
  byTypeOr<SectionBodyWeft>()(
    {
      CodeWeft: (c) =>
        Option.some<CodePiece>({ source: c.source, position: c.position, anchors: c.anchors }),
      ArrowWeft: (a) =>
        Option.map(
          Option.fromNullishOr(a.code),
          (code): CodePiece => ({
            source: a.source.slice(code.position.start.offset - a.position.start.offset),
            position: between(code.position.start, a.position.end),
            anchors: a.anchors,
          }),
        ),
    },
    () => Option.none<CodePiece>(),
  )

const isBlank = (p: CodePiece): boolean => p.source.trim().length === 0

const dropLeadingBlank = (run: ReadonlyArray<CodePiece>): ReadonlyArray<CodePiece> =>
  Array.dropWhile(run, isBlank)

const dropTrailingBlank = (run: ReadonlyArray<CodePiece>): ReadonlyArray<CodePiece> =>
  pipe(run, Array.reverse, Array.dropWhile(isBlank), Array.reverse)

const trimBlank = (run: ReadonlyArray<CodePiece>): ReadonlyArray<CodePiece> =>
  dropTrailingBlank(dropLeadingBlank(run))

const seamTrailing = (run: ReadonlyArray<CodePiece>): ReadonlyArray<CodePiece> => {
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
  runs.map((run, i) => (i === runs.length - 1 ? trimBlank(run) : seamTrailing(run)))

const codeRuns = (code: ReadonlyArray<SectionBodyWeft>): ReadonlyArray<ReadonlyArray<CodePiece>> =>
  Array.isReadonlyArrayNonEmpty(code)
    ? pipe(
        code,
        Array.groupWith((a, _b) => a.type !== 'ArrowWeft'),
        Array.map((block) => Array.getSomes(block.map(pieceOf))),
        Array.filter((run) => run.some((p) => !isBlank(p))),
        sealRuns,
      )
    : []

const walkRun =
  (bind: (anchor: WarpAnchorToken) => Part) =>
  (pieces: ReadonlyArray<CodePiece>): ReadonlyArray<Part> => {
    const { start, end } = spanOf(pieces)
    const text = sourceOf(pieces)
    const slice = (from: Point, to: Point): string =>
      text.slice(from.offset - start.offset, to.offset - start.offset)
    const fragment = (from: Point, to: Point): ReadonlyArray<Fragment> => {
      const lit = slice(from, to)
      return lit.length === 0
        ? []
        : [nodeOf(FragmentSchema, { text: lit, origin: between(from, to), health: okHealth })]
    }
    const anchors = Array.sort(
      pieces.flatMap((p) => p.anchors),
      byStart,
    )
    const opensAt = (i: number): Point =>
      pipe(
        Array.get(anchors, i - 1),
        Option.match({ onNone: () => start, onSome: (a) => a.position.end }),
      )
    return [
      ...anchors.flatMap((anchor, i) => [
        ...fragment(opensAt(i), anchor.position.start),
        bind(anchor),
      ]),
      ...fragment(opensAt(anchors.length), end),
    ]
  }

const byStart: Order.Order<WarpAnchorToken> = Order.mapInput(
  Order.Number,
  (a) => a.position.start.offset,
)

const bindAnchor =
  (
    index: NameIndex,
    values: ReadonlyMap<string, ValueWarp>,
    host: string,
    modulePath: string,
  ) =>
  (anchor: WarpAnchorToken): Part => {
    const name = anchor.name.value
    const at = anchor.name.position
    if (anchor.health.status !== 'ok') return blankFragment(anchor.position)
    const value = values.get(name)
    const namesModule = value === undefined && isModuleAnchor(anchor)
    if (anchor.target !== undefined && !namesModule) {
      return blankFragment(anchor.position, stray(anchor.target))
    }
    const label = settleKindOf(anchor)
    const provides = providesOf(anchor)
    if (value !== undefined) {
      return nodeOf(FragmentSchema, { text: value.text, origin: at, health: value.health })
    }
    if (namesModule) return moduleRefOf(index, modulePath, anchor, label, provides)
    return Array.matchLeft(index.get(name) ?? [], {
      onEmpty: () => openRef(name, at, label, provides),
      onNonEmpty: (entry, rest) =>
        rest.length === 0
          ? nodeOf(NameRefSchema, {
              name,
              target: Option.some<SectionId>({
                path: modulePath,
                name: entry.name,
              }),
              anchor: at,
              toBeSettled: label,
              provides,
              health: localHealth(entry, name, at, host, label),
            })
          : blankFragment(anchor.position, ambiguous(name, at, rest.length + 1, [])),
    })
  }

const moduleRefOf = (
  index: NameIndex,
  modulePath: string,
  anchor: WarpAnchorToken,
  label: Option.Option<Position>,
  provides: ReadonlyArray<Provided>,
): Part => {
  const name = anchor.name.value
  const refTo = (target: Option.Option<SectionId>): ModuleRef =>
    nodeOf(ModuleRefSchema, {
      name,
      target,
      file: Option.map(Option.fromNullishOr(anchor.target), (written) => ({
        name: written.value,
        at: written.position,
      })),
      anchor: anchor.name.position,
      slot: between(anchor.close.position.end, anchor.close.position.end),
      toBeSettled: label,
      provides,
      health: okHealth,
    })
  return Array.matchLeft(index.get(name) ?? [], {
    onEmpty: () => refTo(Option.none()),
    onNonEmpty: (entry, rest) =>
      rest.length === 0
        ? refTo(Option.some({ path: modulePath, name: entry.name }))
        : blankFragment(
            anchor.position,
            ambiguous(name, anchor.name.position, rest.length + 1, []),
          ),
  })
}

const isKind =
  (kind: string) =>
  (value: string): boolean =>
    value.toLowerCase() === kind.toLowerCase()

const isSettleKind = isKind(settleKind)

type Braces = NonNullable<WarpAnchorToken['specifier']>

const namesModuleKind = byType<Braces>()<boolean>({
  Specifier: (specifier) => isKind(moduleKind)(specifier.label.value),
  Parameters: (specifier) =>
    specifier.parameters.some(
      (parameter) =>
        parameter.key.value === 'kind' &&
        parameter.values.some((kind) => isKind(moduleKind)(kind.value)),
    ),
})

const isModuleAnchor = (anchor: WarpAnchorToken): boolean =>
  Option.exists(Option.fromNullishOr(anchor.specifier), namesModuleKind)

const settleKindIn = byType<Braces>()<Option.Option<Position>>({
  Specifier: (specifier) =>
    Option.filter(Option.some(specifier.position), () => isSettleKind(specifier.label.value)),
  Parameters: (specifier) =>
    Option.map(
      Array.findFirstWithIndex(specifier.parameters, isSettleParameter),
      ([own, index]) => parameterSpanOf(specifier, own, index),
    ),
})

const settleKindOf = (anchor: WarpAnchorToken): Option.Option<Position> =>
  Option.flatMap(Option.fromNullishOr(anchor.specifier), settleKindIn)

const isSettleParameter = (parameter: ParameterToken): boolean =>
  parameter.key.value === 'kind' &&
  parameter.values.length === 1 &&
  parameter.values.some((value) => isSettleKind(value.value))

const parameterSpanOf = (
  specifier: ParametersToken,
  own: ParameterToken,
  index: number,
): Position =>
  pipe(
    Array.get(specifier.parameters, index + 1),
    Option.map((next) => between(own.position.start, next.position.start)),
    Option.orElse(() =>
      Option.map(Array.get(specifier.parameters, index - 1), (previous) =>
        between(previous.position.end, own.position.end),
      ),
    ),
    Option.getOrElse(() => specifier.position),
  )

const providesOf = (anchor: WarpAnchorToken): ReadonlyArray<Provided> =>
  anchor.specifier?.type === 'Parameters'
    ? anchor.specifier.parameters
        .filter((parameter) => parameter.key.value === 'provides')
        .flatMap((parameter) => parameter.values)
        .map((value): Provided => ({ name: value.value, at: value.position }))
    : []

const localHealth = Match.fn(
  (
    entry: NameEntry,
    _name: string,
    _at: Position,
    host: string,
    _label: Option.Option<Position>,
  ) => ({
    codeless: Option.isSome(entry.codeless),
    written: entry.written,
    sameLanguage: entry.language === host,
  }),
).pipe(
  Match.withReturnType<Health>(),
  Match.when({ codeless: true }, (_facts, entry, name, at) =>
    faulty(withoutCode(name, entry.codeless), at),
  ),
  Match.when({ written: false }, (_facts, _entry, name, at) =>
    faulty(UnsettledSection({ name, declared: true }), at),
  ),
  Match.when({ sameLanguage: false }, (_facts, entry, name, at, host) =>
    crossLanguage(name, at, host, entry.language),
  ),
  Match.orElse((_facts, _entry, name, at, _host, label) => settledHealth(name, at, label)),
)

const settledHealth = (name: string, at: Position, label: Option.Option<Position>): Health =>
  Option.match(label, {
    onNone: () => okHealth,
    onSome: (span) => faulty(SettledLabel({ name, label: span }), at),
  })

const openRef = (
  title: string,
  at: Position,
  label: Option.Option<Position>,
  provides: ReadonlyArray<Provided>,
): NameRef =>
  nodeOf(NameRefSchema, {
    name: title,
    target: Option.none(),
    anchor: at,
    toBeSettled: label,
    provides,
    health: okHealth,
  })

const blankFragment = (at: Position, health: Health = okHealth): Fragment =>
  nodeOf(FragmentSchema, { text: '', origin: at, health })

const unresolved = (name: string, at: Position): Health => faulty(UnresolvedAnchor({ name }), at)

const ambiguous = (
  name: string,
  at: Position,
  count: number,
  paths: ReadonlyArray<string>,
): Health => faulty(AmbiguousAnchor({ name, count, paths }), at)

const crossLanguage = (name: string, at: Position, host: string, found: string): Health =>
  faulty(CrossLanguageAnchor({ name, host, found }), at)

const stray = (target: WarpAnchorTargetToken): Health =>
  faulty(StrayTarget({ target: target.source, at: target.position }), target.position)

const partFaults = byTypeOr<
  Part,
  [
    within: {
      readonly catalogue: Catalogue
      readonly modules: ReadonlyMap<string, LoomModule>
      readonly module: LoomModule
      readonly landing: Landing
      readonly host: Code
    },
  ]
>()<ReadonlyArray<Diagnostic>>(
  {
    NameRef: (ref, { catalogue, modules, module, host }) =>
      Option.isNone(ref.target)
        ? nameHealth(catalogue, modules, module, host, ref).diagnostics
        : [],
    ModuleRef: (ref, { catalogue, modules, module, landing, host }) =>
      moduleRefHealth(catalogue, modules, landing, module, host, ref).diagnostics,
  },
  (): ReadonlyArray<Diagnostic> => [],
)

export const crossFileFaults = (
  catalogue: Catalogue,
  modules: ReadonlyMap<string, LoomModule>,
  module: LoomModule,
  landing: Landing,
): ReadonlyArray<Diagnostic> =>
  module.product.code.flatMap((host) =>
    host.fragments.flatMap((part) =>
      partFaults(part, { catalogue, modules, module, landing, host }),
    ),
  )

const moduleRefHealth = (
  catalogue: Catalogue,
  modules: ReadonlyMap<string, LoomModule>,
  landing: Landing,
  module: LoomModule,
  host: Code,
  ref: ModuleRef,
): Health =>
  ModuleFile.$match(moduleFileOf(catalogue, modules, landing, module, host, ref), {
    Named: () => okHealth,
    Unsettled: ({ declared }) => faulty(UnsettledModule({ name: ref.name, declared }), ref.anchor),
    Faulted: ({ health }) => health,
  })

const nameHealth = (
  catalogue: Catalogue,
  modules: ReadonlyMap<string, LoomModule>,
  module: LoomModule,
  host: Code,
  ref: NameRef,
): Health => {
  const trails = trailsOf(catalogue, module.path, ref.name)
  return Array.matchLeft(trails, {
    onEmpty: () =>
      Option.match(Array.head(conceptsCalled(catalogue, ref.name)), {
        onSome: (concept) => faulty(ConceptWithoutCode({ name: concept.name.source }), ref.anchor),
        onNone: () =>
          isMeant(ref)
            ? faulty(UnsettledSection({ name: ref.name, declared: false }), ref.anchor)
            : unresolvedHealth(module, host, ref.name, ref.anchor),
      }),
    onNonEmpty: (trail, rest) =>
      rest.length > 0
        ? ambiguous(ref.name, ref.anchor, trails.length, pathsTo(catalogue, module.path, trails))
        : trailHealth(modules, host, ref, trail),
  })
}

const unresolvedHealth = (
  module: LoomModule,
  host: Code,
  name: string,
  at: Position,
): Health =>
  faulty(
    UnresolvedAnchor({
      name,
      ...Option.match(declarationBelow(module, host, name), {
        onNone: () => ({}),
        onSome: (declaration) => ({ declaration }),
      }),
      ...Option.match(settleAt(module, at), {
        onNone: () => ({}),
        onSome: (point) => ({ settleAt: point }),
      }),
    }),
    at,
  )

const trailHealth = (
  modules: ReadonlyMap<string, LoomModule>,
  host: Code,
  ref: NameRef,
  trail: Trail,
): Health =>
  Option.match(
    Option.flatMap(sectionOf(trail), (reached) =>
      Option.map(codeOf(modules, reached), (code) => ({
        code,
        codeless: codelessKind(reached.section),
      })),
    ),
    {
      onNone: () =>
        Array.lastNonEmpty(trail).place._tag === 'Box'
          ? faulty(UnsettledSection({ name: ref.name, declared: true }), ref.anchor)
          : unresolved(ref.name, ref.anchor),
      onSome: ({ code, codeless }) =>
        reachedHealth(
          ref.name,
          ref.anchor,
          host.languageId,
          code,
          codeless,
          Array.lastNonEmpty(trail).place._tag === 'Chapter',
          ref.toBeSettled,
        ),
    },
  )

const reachedHealth = Match.fn(
  (
    _name: string,
    _at: Position,
    host: string,
    code: Code,
    codeless: Option.Option<Codeless>,
    whole: boolean,
    _label: Option.Option<Position>,
  ) => ({
    codeless: Option.isSome(codeless),
    written: Array.isReadonlyArrayNonEmpty(code.fragments),
    whole,
    sameLanguage: code.languageId === host,
  }),
).pipe(
  Match.withReturnType<Health>(),
  Match.when({ codeless: true }, (_facts, name, at, _host, _code, codeless) =>
    faulty(withoutCode(name, codeless), at),
  ),
  Match.when({ written: false, whole: true }, (_facts, name, at) =>
    faulty(ChapterWithoutCode({ name }), at),
  ),
  Match.when({ written: false }, (_facts, name, at) =>
    faulty(UnsettledSection({ name, declared: true }), at),
  ),
  Match.when({ sameLanguage: false }, (_facts, name, at, host, code) =>
    crossLanguage(name, at, host, code.languageId),
  ),
  Match.orElse((_facts, name, at, _host, _code, _codeless, _whole, label) =>
    settledHealth(name, at, label),
  ),
)

const settleAt = (module: LoomModule, at: Position): Option.Option<Position> =>
  pipe(
    module.doc.sections.flatMap((section) => section.code.flatMap((weft) => weft.anchors)),
    Array.findFirst((anchor) => anchor.name.position.start.offset === at.start.offset),
    Option.filter((anchor) => anchor.specifier === undefined),
    Option.map((anchor) => between(anchor.position.end, anchor.position.end)),
  )

const pointAtEnd = (text: string): Point => {
  const lines = text.split('\n')
  return { line: lines.length, column: lines[lines.length - 1]!.length + 1, offset: text.length }
}

const headingMarkOf = (heading: LoomHeading): string =>
  heading.marker.type === 'HeadingStart' ? heading.marker.source.trim() : '##'

const declarationBelow = (
  module: LoomModule,
  host: Code,
  name: string,
): Option.Option<Declaration> =>
  Option.map(
    Array.findFirstIndex(
      module.doc.sections,
      (section) => sectionNameOf(section) === host.origin.name,
    ),
    (index): Declaration => {
      const heading = `${headingMarkOf(module.doc.sections[index]!.heading)} ${name}\n`
      return Option.match(Array.get(module.doc.sections, index + 1), {
        onSome: (next) => ({
          at: between(next.heading.position.start, next.heading.position.start),
          text: `${heading}\n`,
        }),
        onNone: () => ({
          at: between(pointAtEnd(module.text), pointAtEnd(module.text)),
          text: `${module.text.endsWith('\n') ? '\n' : '\n\n'}${heading}`,
        }),
      })
    },
  )

const codeOf = (
  modules: ReadonlyMap<string, LoomModule>,
  reached: SectionRef,
): Option.Option<Code> =>
  pipe(
    Option.fromNullishOr(modules.get(reached.module)),
    Option.flatMap((there) =>
      Array.findFirst(
        there.product.code,
        (code) => code.origin.name === sectionNameOf(reached.section),
      ),
    ),
  )

export const targetOf = (
  catalogue: Catalogue,
  from: Location,
  ref: NameRef,
): Option.Option<SectionId> =>
  Option.orElse(ref.target, () =>
    Option.map(resolveName(catalogue, from, ref.name), (reached) => ({
      path: reached.module,
      name: sectionNameOf(reached.section),
    })),
  )

export interface Landed {
  readonly loom: Location
  readonly file: File
}

export type ModuleFile = Data.TaggedEnum<{
  Named: { readonly landed: Landed }
  Unsettled: { readonly declared: boolean }
  Faulted: { readonly health: Health }
}>

export const ModuleFile = Data.taggedEnum<ModuleFile>()

type ModuleNode = Data.TaggedEnum<{
  Chapter: { readonly module: LoomModule }
  Section: { readonly id: SectionId }
}>

const ModuleNode = Data.taggedEnum<ModuleNode>()

export const moduleFileOf = (
  catalogue: Catalogue,
  modules: ReadonlyMap<string, LoomModule>,
  landing: Landing,
  module: LoomModule,
  host: Code,
  ref: ModuleRef,
): ModuleFile =>
  Result.match(referredNodeOf(catalogue, module, host, ref), {
    onFailure: (stopped) => stopped,
    onSuccess: (node) =>
      ModuleNode.$match(node, {
        Chapter: ({ module: chapter }) => chapterFile(ref, filesOf(chapter)),
        Section: ({ id }) => sectionFile(modules, landing, host, ref, id),
      }),
  })

const referredNodeOf = (
  catalogue: Catalogue,
  module: LoomModule,
  host: Code,
  ref: ModuleRef,
): Result.Result<ModuleNode, ModuleFile> =>
  Option.match(ref.target, {
    onSome: (id) => Result.succeed(ModuleNode.Section({ id })),
    onNone: () => {
      const trails = trailsOf(catalogue, module.path, ref.name)
      return Array.matchLeft(trails, {
        onEmpty: () =>
          Result.fail(
            isMeant(ref)
              ? ModuleFile.Unsettled({ declared: false })
              : ModuleFile.Faulted({ health: unresolvedHealth(module, host, ref.name, ref.anchor) }),
          ),
        onNonEmpty: (trail, rest) =>
          rest.length > 0
            ? Result.fail(
                ModuleFile.Faulted({
                  health: ambiguous(
                    ref.name,
                    ref.anchor,
                    trails.length,
                    pathsTo(catalogue, module.path, trails),
                  ),
                }),
              )
            : nodeOfPlace(Array.lastNonEmpty(trail).place, ref),
      })
    },
  })

const nodeOfPlace = Match.fn((place: Place, _ref: ModuleRef) => place).pipe(
  Match.withReturnType<Result.Result<ModuleNode, ModuleFile>>(),
  Match.tag('Chapter', ({ chapter }) =>
    Result.succeed(ModuleNode.Chapter({ module: chapter.module })),
  ),
  Match.tag('Section', ({ ref: reached }) =>
    Result.succeed(
      ModuleNode.Section({
        id: { path: reached.module, name: sectionNameOf(reached.section) },
      }),
    ),
  ),
  Match.tag('Box', () => Result.fail(ModuleFile.Unsettled({ declared: true }))),
  Match.tag('Book', (_matched, _place, ref) =>
    Result.fail(ModuleFile.Faulted({ health: unresolved(ref.name, ref.anchor) })),
  ),
  Match.tag('Part', (_matched, _place, ref) =>
    Result.fail(ModuleFile.Faulted({ health: unresolved(ref.name, ref.anchor) })),
  ),
  Match.exhaustive,
)

const filesOf = (module: LoomModule): ReadonlyArray<Landed> =>
  module.product.files.map((file): Landed => ({ loom: module.path, file }))

const isNamed = (path: string, written: string): boolean =>
  path === written || path.endsWith(`/${written}`)

const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

const fileNames = (files: ReadonlyArray<Landed>): ReadonlyArray<string> => {
  const bases = files.map((landed) => baseName(landed.file.path))
  return files.map((landed, i) =>
    bases.filter((base) => base === bases[i]).length > 1
      ? landed.file.path
      : baseName(landed.file.path),
  )
}

const chapterFile = (ref: ModuleRef, files: ReadonlyArray<Landed>): ModuleFile =>
  Array.isReadonlyArrayNonEmpty(files)
    ? fileAmong(ref, files)
    : ModuleFile.Unsettled({ declared: true })

const fileAmong = (ref: ModuleRef, files: Array.NonEmptyReadonlyArray<Landed>): ModuleFile =>
  Option.match(ref.file, {
    onSome: (written) =>
      Option.match(
        Array.findFirst(files, (landed) => isNamed(landed.file.path, written.name)),
        {
          onSome: (landed) => ModuleFile.Named({ landed }),
          onNone: () =>
            ModuleFile.Faulted({
              health: faulty(
                NoSuchFile({
                  name: ref.name,
                  file: written.name,
                  files: fileNames(files),
                  at: written.at,
                }),
                ref.anchor,
              ),
            }),
        },
      ),
    onNone: () =>
      files.length === 1
        ? ModuleFile.Named({ landed: Array.headNonEmpty(files) })
        : ModuleFile.Faulted({
            health: faulty(
              SeveralFiles({ name: ref.name, files: fileNames(files), at: ref.slot }),
              ref.anchor,
            ),
          }),
  })

export type Landing = Readonly<Record<string, ReadonlyArray<Landed>>>

const landedIn = (landing: Landing, id: SectionId): ReadonlyArray<Landed> =>
  Option.getOrElse(Option.fromNullishOr(landing[keyOf(id)]), () => [])

const sameFile = (one: Landed, other: Landed): boolean =>
  one.loom === other.loom && one.file.path === other.file.path

const sectionFile = (
  modules: ReadonlyMap<string, LoomModule>,
  landing: Landing,
  host: Code,
  ref: ModuleRef,
  id: SectionId,
): ModuleFile => {
  const own = Option.match(Option.fromNullishOr(modules.get(id.path)), {
    onNone: (): ReadonlyArray<Landed> => [],
    onSome: filesOf,
  }).filter((landed) => landed.file.code.origin.name === id.name)
  if (Array.isReadonlyArrayNonEmpty(own)) return fileAmong(ref, own)
  return Option.match(ref.file, {
    onSome: (written) =>
      ModuleFile.Faulted({
        health: faulty(
          NoSuchFile({ name: ref.name, file: written.name, files: [], at: written.at }),
          ref.anchor,
        ),
      }),
    onNone: () => landedFile(landing, host, ref, id),
  })
}

const landedFile = (landing: Landing, host: Code, ref: ModuleRef, id: SectionId): ModuleFile => {
  const lands = landedIn(landing, id)
  const here = landedIn(landing, host.origin)
  const inHere = (landed: Landed): boolean => here.some((one) => sameFile(one, landed))
  const sole = lands.length === 1 ? Array.head(lands) : Option.none<Landed>()
  return Option.match(
    Option.filter(sole, (landed) => !inHere(landed)),
    {
      onSome: (landed) => ModuleFile.Named({ landed }),
      onNone: () =>
        ModuleFile.Faulted({
          health: faulty(
            SectionWithoutFile({
              name: ref.name,
              files: fileNames(lands),
              here: Option.exists(sole, inHere),
            }),
            ref.anchor,
          ),
        }),
    },
  )
}

export const holdsModuleRefs: (modules: ReadonlyMap<string, LoomModule>) => boolean = memoize(
  (modules: ReadonlyMap<string, LoomModule>) =>
    Array.fromIterable(modules.values()).some((module) =>
      module.product.code.some((code) => code.fragments.some((part) => part.type === 'ModuleRef')),
    ),
)

const codeAt = (modules: ReadonlyMap<string, LoomModule>, id: SectionId): Option.Option<Code> =>
  pipe(
    Option.fromNullishOr(modules.get(id.path)),
    Option.flatMap((there) => Array.findFirst(there.product.code, (code) => code.origin.name === id.name)),
  )

const reachedFrom = (
  catalogue: Catalogue,
  modules: ReadonlyMap<string, LoomModule>,
  root: Code,
): ReadonlyArray<string> => {
  const walk = (seen: ReadonlySet<string>, code: Code): ReadonlySet<string> =>
    code.fragments.reduce(
      (reached, part) =>
        part.type !== 'NameRef'
          ? reached
          : pipe(
              targetOf(catalogue, code.origin.path, part),
              Option.filter((target) => !reached.has(keyOf(target))),
              Option.flatMap((target) =>
                Option.map(codeAt(modules, target), (next) =>
                  walk(new Set([...reached, keyOf(target)]), next),
                ),
              ),
              Option.getOrElse(() => reached),
            ),
      seen,
    )
  return Array.fromIterable(walk(new Set([keyOf(root.origin)]), root))
}

export const landingOf: (modules: ReadonlyMap<string, LoomModule>) => Landing = memoize(
  (modules: ReadonlyMap<string, LoomModule>): Landing =>
    holdsModuleRefs(modules)
      ? pipe(
          Array.fromIterable(modules.values())
            .flatMap(filesOf)
            .flatMap((landed) =>
              reachedFrom(catalogueOf(modules), modules, landed.file.code).map((key) => ({
                key,
                landed,
              })),
            ),
          Array.groupBy((entry) => entry.key),
          Record.map((entries) => entries.map((entry) => entry.landed)),
        )
      : {},
)

type Walked = {
  readonly visited: ReadonlySet<string>
  readonly path: Option.Option<ReadonlyArray<SectionId>>
}

const composedTargetsOf = (catalogue: Catalogue, code: Code): ReadonlyArray<SectionId> =>
  Array.getSomes(
    code.fragments.map((part) =>
      part.type === 'NameRef' ? targetOf(catalogue, code.origin.path, part) : Option.none(),
    ),
  )

const nextFrom = (
  catalogue: Catalogue,
  modules: ReadonlyMap<string, LoomModule>,
  at: SectionId,
): ReadonlyArray<SectionId> =>
  Option.match(codeAt(modules, at), {
    onNone: (): ReadonlyArray<SectionId> => [],
    onSome: (code) => composedTargetsOf(catalogue, code),
  })

const unwalked = (visited: ReadonlySet<string>): Walked => ({ visited, path: Option.none() })

const prefixed = (at: SectionId, walked: Walked): Walked => ({
  ...walked,
  path: Option.map(walked.path, (rest) => [at, ...rest]),
})

const pathBack = (
  catalogue: Catalogue,
  modules: ReadonlyMap<string, LoomModule>,
  goal: SectionId,
) => {
  const walk = (visited: ReadonlySet<string>, at: SectionId): Walked =>
    keyOf(at) === keyOf(goal)
      ? { visited, path: Option.some([at]) }
      : nextFrom(catalogue, modules, at).reduce(
          (walked, next) =>
            Option.isSome(walked.path) || walked.visited.has(keyOf(next))
              ? walked
              : prefixed(at, walk(new Set([...walked.visited, keyOf(next)]), next)),
          unwalked(visited),
        )
  return walk
}

const loopThrough = (
  catalogue: Catalogue,
  modules: ReadonlyMap<string, LoomModule>,
  host: Code,
  ref: NameRef,
): Option.Option<ReadonlyArray<SectionId>> =>
  Option.flatMap(targetOf(catalogue, host.origin.path, ref), (target) =>
    Option.map(
      pathBack(catalogue, modules, host.origin)(new Set([keyOf(target)]), target).path,
      (path) => [host.origin, ...path],
    ),
  )

const titleAt = (modules: ReadonlyMap<string, LoomModule>, id: SectionId): string =>
  pipe(
    Option.fromNullishOr(modules.get(id.path)),
    Option.flatMap((there) =>
      Array.findFirst(there.doc.sections, (section) => sectionNameOf(section) === id.name),
    ),
    Option.flatMap((section) => Option.fromNullishOr(section.heading.title)),
    Option.map((title) => title.source),
    Option.getOrElse(() => id.name),
  )

export const compositionCycles = (
  catalogue: Catalogue,
  modules: ReadonlyMap<string, LoomModule>,
  module: LoomModule,
): ReadonlyArray<Diagnostic> =>
  module.product.code.flatMap((host) =>
    host.fragments.flatMap((part) =>
      part.type === 'NameRef'
        ? Option.match(loopThrough(catalogue, modules, host, part), {
            onNone: (): ReadonlyArray<Diagnostic> => [],
            onSome: (loop) =>
              faulty(
                CompositionCycle({ loop: loop.map((id) => titleAt(modules, id)) }),
                part.anchor,
              ).diagnostics,
          })
        : [],
    ),
  )

export type Usage = { readonly writes: boolean; readonly used: ReadonlySet<string> }

export const usedSections: (modules: ReadonlyMap<string, LoomModule>) => Usage = memoize(
  (modules: ReadonlyMap<string, LoomModule>): Usage => {
    const catalogue = catalogueOf(modules)
    const all = Array.fromIterable(modules.values())
    const files = all.flatMap((module) => module.product.files)
    return {
      writes: Array.isReadonlyArrayNonEmpty(files),
      used: new Set([
        ...files.map((file) => keyOf(file.code.origin)),
        ...all.flatMap((module) =>
          module.product.code.flatMap((code) => composedTargetsOf(catalogue, code).map(keyOf)),
        ),
      ]),
    }
  },
)

const unfinished = (module: LoomModule): boolean =>
  Option.exists(
    Option.fromNullishOr(module.doc.frontmatter?.status),
    (status) => status.value === 'Planned',
  )

const holdsCode = (code: Code): boolean =>
  code.fragments.some((part) => part.type !== 'Fragment' || part.text.trim() !== '')

const isProse = (code: Code): boolean => code.languageId === 'prose'

export const unusedSections = (usage: Usage, module: LoomModule): ReadonlyArray<Diagnostic> =>
  !usage.writes || module.doc.frontmatter?.discussion !== undefined || unfinished(module)
    ? []
    : module.product.code
        .filter((code) => holdsCode(code) && !isProse(code) && !usage.used.has(keyOf(code.origin)))
        .flatMap((code) =>
          Option.toArray(
            Array.findFirst(
              module.doc.sections,
              (section) => sectionNameOf(section) === code.origin.name,
            ),
          ),
        )
        .filter((section) => !isManifest(section))
        .flatMap((section) =>
          Option.match(Option.fromNullishOr(section.heading.title), {
            onNone: (): ReadonlyArray<Diagnostic> => [],
            onSome: (title) =>
              faulty(UnusedSection({ name: title.source }), title.position).diagnostics,
          }),
        )

export const sectionNameOf = (section: LoomSection): string =>
  normaliseTitle(section.heading.title?.source ?? '')

const sourceOf = (nodes: ReadonlyArray<{ readonly source: string }>): string =>
  nodes.map((n) => n.source).join('')

const spanOf = (nodes: ReadonlyArray<{ readonly position: Position }>): Position => ({
  start: nodes[0]!.position.start,
  end: nodes[nodes.length - 1]!.position.end,
})

const between = (start: Point, end: Point): Position => ({ start, end })

const identityOf = (section: LoomSection): string => sectionNameOf(section).toLowerCase()

const firstHolders = (sections: ReadonlyArray<LoomSection>): ReadonlyMap<string, LoomSection> =>
  new Map(
    Array.reverse(
      sections
        .filter((section) => section.heading.title !== undefined)
        .map((section) => [identityOf(section), section] as const),
    ),
  )

const duplicateHealth = (first: ReadonlyMap<string, LoomSection>, section: LoomSection): Health =>
  pipe(
    Option.all([
      Option.fromNullishOr(section.heading.title),
      pipe(
        Option.fromNullishOr(first.get(identityOf(section))),
        Option.filter((holder) => holder !== section),
      ),
    ]),
    Option.map(([title, holder]) =>
      faulty(
        DuplicateName({
          name: title.source,
          sibling: 'section',
          where: String(holder.heading.position.start.line),
        }),
        title.position,
      ),
    ),
    Option.getOrElse(() => okHealth),
  )

const labelsOf = (section: LoomSection): ReadonlyArray<FenceLabelToken> =>
  section.code.flatMap((weft) =>
    weft.type === 'FenceWeft' && weft.label !== undefined ? [weft.label] : [],
  )

const labelHealth = (section: LoomSection, languageId: string): Health =>
  Option.match(
    Array.findFirst(labelsOf(section), (label) => extensionLanguage(label.source) !== languageId),
    {
      onNone: () => okHealth,
      onSome: (label) =>
        faulty(
          FenceLabelAgainstLanguage({ label: label.source, language: languageId }),
          label.position,
        ),
    },
  )

const withHealth = (first: Health, second: Health): Health => ({
  status: first.status === 'ok' ? second.status : first.status,
  diagnostics: [...first.diagnostics, ...second.diagnostics],
})
