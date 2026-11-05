import { Array, Context, Data, Effect, Layer, Match, Option, Order, pipe, Record, Result } from 'effect'
import type {
  LoomDocument,
  LoomFrontmatter,
  LoomHeading,
  LoomSection,
} from '@athrio/loom-ast/LoomAst'
import {
  okHealth,
  type Diagnostic,
  type Health,
  type Point,
  type Position,
} from '@athrio/loom-ast/LoomNode'
import {
  type Book,
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
  referenceKind,
  settleKind,
  type FenceLabelToken,
  type ParameterToken,
  type ParametersToken,
  type SinkToken,
  type SpecifierToken,
  type WarpAnchorTargetToken,
  type WarpAnchorToken,
  type WarpToken,
} from '@athrio/loom-ast/LoomTokens'
import type { SectionBodyWeft } from '@athrio/loom-ast/Weft'
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
  ProductSchema,
  type Provided,
  type SectionId,
} from '@athrio/loom-ast/ProductAst'
import {
  AmbiguousAnchor,
  ChapterWithoutCode,
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
  UnsettledModule,
  UnsettledSection,
  UnknownVariable,
  UnresolvedAnchor,
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
  return pipe(
    doc.sections,
    Array.map(buildSection(index, first, lang, modulePath, pkg, variables, isDiscussion(doc))),
    Array.reduce(emptyProduct, appendSection),
  )
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

const emptyProduct: Product = ProductSchema.make({ code: [], files: [] })

const appendSection = (product: Product, built: Built): Product =>
  ProductSchema.make({
    code: [...product.code, built.code],
    files: [...product.files, ...Option.toArray(built.file)],
  })

type NameEntry = {
  readonly name: string
  readonly pos: Position
  readonly language: string
  readonly written: boolean
}
type NameIndex = ReadonlyMap<string, ReadonlyArray<NameEntry>>

const specifierLanguage = (
  label: string,
  sink: Option.Option<SinkToken>,
  defaultLang: string,
  pkg: Option.Option<string>,
): string => {
  const id = label.toLowerCase()
  if (id === 'tangle')
    return Option.match(pkg, {
      onNone: () => defaultLang,
      onSome: (p) => extensionLanguage(tangleFilePath(p, sink)),
    })
  if (id === 'toc') return 'prose'
  return id
}

export const sectionLanguage = (
  section: LoomSection,
  defaultLang: string,
  pkg: Option.Option<string>,
): string => {
  const { specifier, sink } = section.heading
  if (specifier !== undefined)
    return specifierLanguage(specifier.label.value, Option.fromNullishOr(sink), defaultLang, pkg)
  if (sink === undefined) return defaultLang
  return extensionLanguage(sink.file.value)
}

const nameIndex = (
  sections: ReadonlyArray<LoomSection>,
  defaultLang: string,
  pkg: Option.Option<string>,
): NameIndex =>
  pipe(
    sections,
    Array.map((s) =>
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
])

const extensionLanguage = (path: string): string => {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
  const dot = name.lastIndexOf('.')
  const ext = dot < 0 ? name : name.slice(dot + 1)
  return languageByExtension.get(ext) ?? ext
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
  missing: pipe(
    Array.fromIterable(text.matchAll(variablePattern)),
    Array.map((match) => match[1]!),
    Array.filter((name) => !(name in variables)),
    Array.head,
  ),
})

const valueWarps = (
  warps: ReadonlyArray<WarpToken>,
  variables: Record<string, string>,
): ReadonlyMap<string, ValueWarp> =>
  new Map(
    Array.getSomes(
      Array.map(warps, (w) =>
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
  ) =>
  (section: LoomSection): Built => {
    const values = valueWarps(
      section.preamble.flatMap((w) => w.warps),
      variables,
    )
    const origin: SectionId = { path: modulePath, name: sectionNameOf(section) }
    const languageId = sectionLanguage(section, defaultLang, pkg)
    const health = Array.reduce(
      [
        duplicateHealth(first, section),
        labelHealth(section, languageId),
        discussion ? fileInDiscussion(section) : tangleHealth(section, pkg),
      ],
      okHealth,
      withHealth,
    )
    const code = buildCode(section, values, index, origin, languageId, health)
    const file = discussion ? Option.none<File>() : tangleFile(section, pkg, code)
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

const singleFile = (pkg: Option.Option<string>): Option.Option<string> =>
  Option.filter(pkg, (p) => !p.endsWith('/'))

const isTangle = (specifier: SpecifierToken): boolean =>
  specifier.label.value.toLowerCase() === 'tangle'

const tangleFile = (
  section: LoomSection,
  pkg: Option.Option<string>,
  code: Code,
): Option.Option<File> => {
  const sink = Option.fromNullishOr(section.heading.sink)
  const target = Option.match(Option.fromNullishOr(section.heading.specifier), {
    onNone: () => Option.flatMap(sink, () => filePath(pkg, sink)),
    onSome: (spec) =>
      Match.value({ tangle: isTangle(spec), sunk: Option.isSome(sink) }).pipe(
        Match.when({ tangle: true, sunk: true }, () => filePath(pkg, sink)),
        Match.when({ tangle: true }, () => singleFile(pkg)),
        Match.orElse(() => Option.none<string>()),
      ),
  })
  return Option.map(target, (path) => FileSchema.make({ path, code }))
}

const tangleHealth = (section: LoomSection, pkg: Option.Option<string>): Health =>
  Option.match(Option.filter(Option.fromNullishOr(section.heading.specifier), isTangle), {
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

const fileInDiscussion = (section: LoomSection): Health =>
  Option.match(
    Option.orElse(Option.fromNullishOr(section.heading.sink), () =>
      Option.filter(Option.fromNullishOr(section.heading.specifier), isTangle),
    ),
    {
      onNone: () => okHealth,
      onSome: (mark) => faulty(FileInDiscussion(), mark.position),
    },
  )

const removalOf = (specifier: SpecifierToken, sink: SinkToken): Position =>
  specifier.position.start.offset < sink.position.start.offset
    ? between(specifier.position.start, sink.position.start)
    : between(sink.position.end, specifier.position.end)

const buildCode = (
  section: LoomSection,
  values: ReadonlyMap<string, ValueWarp>,
  index: NameIndex,
  origin: SectionId,
  languageId: string,
  health: Health,
): Code => {
  const bind = bindAnchor(index, values, languageId, origin.path)
  const fragments = pipe(codeRuns(section.code), Array.flatMap(walkRun(bind)))
  return CodeSchema.make({ origin, languageId, fragments, health })
}

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
      Option.map(Option.fromNullishOr(a.code), (code) => ({
        source: a.source.slice(code.position.start.offset - a.position.start.offset),
        position: between(code.position.start, a.position.end),
        anchors: a.anchors,
      })),
    ),
    Match.orElse(() => Option.none<CodePiece>()),
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
  Array.map(runs, (run, i) => (i === runs.length - 1 ? trimBlank(run) : seamTrailing(run)))

const codeRuns = (code: ReadonlyArray<SectionBodyWeft>): ReadonlyArray<ReadonlyArray<CodePiece>> =>
  Array.isReadonlyArrayNonEmpty(code)
    ? pipe(
        code,
        Array.groupWith((a, _b) => a.type !== 'ArrowWeft'),
        Array.map((block) => Array.getSomes(Array.map(block, pieceOf))),
        Array.filter((run) => Array.some(run, (p) => !isBlank(p))),
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
      return lit.length === 0 ? [] : [FragmentSchema.make({ text: lit, origin: between(from, to) })]
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
    return [
      ...Array.flatMap(anchors, (anchor, i) => [
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
    const refersHere = value === undefined && isReference(anchor)
    if (anchor.target !== undefined && !refersHere) {
      return blankFragment(anchor.position, stray(anchor.target))
    }
    const label = settleKindOf(anchor)
    const provides = providesOf(anchor)
    if (value !== undefined) {
      return FragmentSchema.make({ text: value.text, origin: at, health: value.health })
    }
    if (refersHere) return referenceOf(index, modulePath, anchor, label, provides)
    return Array.matchLeft(index.get(name) ?? [], {
      onEmpty: () => openRef(name, at, label, provides),
      onNonEmpty: (entry, rest) =>
        rest.length === 0
          ? NameRefSchema.make({
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

const referenceOf = (
  index: NameIndex,
  modulePath: string,
  anchor: WarpAnchorToken,
  label: Option.Option<Position>,
  provides: ReadonlyArray<Provided>,
): Part => {
  const name = anchor.name.value
  const reference = (target: Option.Option<SectionId>): ModuleRef =>
    ModuleRefSchema.make({
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
    })
  return Array.matchLeft(index.get(name) ?? [], {
    onEmpty: () => reference(Option.none()),
    onNonEmpty: (entry, rest) =>
      rest.length === 0
        ? reference(Option.some({ path: modulePath, name: entry.name }))
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

const isReference = (anchor: WarpAnchorToken): boolean =>
  Match.value(anchor.specifier).pipe(
    Match.when({ type: 'Specifier' }, (specifier) => isKind(referenceKind)(specifier.label.value)),
    Match.when({ type: 'Parameters' }, (specifier) =>
      Array.some(
        specifier.parameters,
        (parameter) =>
          parameter.key.value === 'kind' &&
          Array.some(parameter.values, (kind) => isKind(referenceKind)(kind.value)),
      ),
    ),
    Match.orElse(() => false),
  )

const settleKindOf = (anchor: WarpAnchorToken): Option.Option<Position> =>
  Match.value(anchor.specifier).pipe(
    Match.when({ type: 'Specifier' }, (specifier) =>
      Option.filter(Option.some(specifier.position), () => isSettleKind(specifier.label.value)),
    ),
    Match.when({ type: 'Parameters' }, (specifier) =>
      Option.map(
        Array.findFirstWithIndex(specifier.parameters, isSettleParameter),
        ([own, index]) => parameterSpanOf(specifier, own, index),
      ),
    ),
    Match.orElse(() => Option.none<Position>()),
  )

const isSettleParameter = (parameter: ParameterToken): boolean =>
  parameter.key.value === 'kind' &&
  parameter.values.length === 1 &&
  Array.some(parameter.values, (value) => isSettleKind(value.value))

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
    ? pipe(
        anchor.specifier.parameters,
        Array.filter((parameter) => parameter.key.value === 'provides'),
        Array.flatMap((parameter) => parameter.values),
        Array.map((value): Provided => ({ name: value.value, at: value.position })),
      )
    : []

const localHealth = (
  entry: NameEntry,
  name: string,
  at: Position,
  host: string,
  label: Option.Option<Position>,
): Health =>
  Match.value({ written: entry.written, sameLanguage: entry.language === host }).pipe(
    Match.when({ written: false }, () => faulty(UnsettledSection({ name, declared: true }), at)),
    Match.when({ sameLanguage: false }, () => crossLanguage(name, at, host, entry.language)),
    Match.orElse(() => settledHealth(name, at, label)),
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
  NameRefSchema.make({
    name: title,
    target: Option.none(),
    anchor: at,
    toBeSettled: label,
    provides,
  })

const blankFragment = (at: Position, health: Health = okHealth): Fragment =>
  FragmentSchema.make({ text: '', origin: at, health })

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

export const crossFileFaults = (
  book: Book,
  modules: ReadonlyMap<string, LoomModule>,
  module: LoomModule,
  landing: Landing,
): ReadonlyArray<Diagnostic> =>
  pipe(
    module.product.code,
    Array.flatMap((host) =>
      Array.flatMap(host.fragments, (part) =>
        Match.value(part).pipe(
          Match.when({ type: 'NameRef' }, (ref) =>
            Option.isNone(ref.target) ? nameHealth(book, modules, module, host, ref).diagnostics : [],
          ),
          Match.when(
            { type: 'ModuleRef' },
            (ref) => referenceHealth(book, modules, landing, module, host, ref).diagnostics,
          ),
          Match.orElse((): ReadonlyArray<Diagnostic> => []),
        ),
      ),
    ),
  )

const referenceHealth = (
  book: Book,
  modules: ReadonlyMap<string, LoomModule>,
  landing: Landing,
  module: LoomModule,
  host: Code,
  ref: ModuleRef,
): Health =>
  Referred.$match(referredFileOf(book, modules, landing, module, host, ref), {
    Named: () => okHealth,
    Unsettled: ({ declared }) => faulty(UnsettledModule({ name: ref.name, declared }), ref.anchor),
    Faulted: ({ health }) => health,
  })

const nameHealth = (
  book: Book,
  modules: ReadonlyMap<string, LoomModule>,
  module: LoomModule,
  host: Code,
  ref: NameRef,
): Health => {
  const trails = trailsOf(book, module.path, ref.name)
  return Array.matchLeft(trails, {
    onEmpty: () =>
      isMeant(ref)
        ? faulty(UnsettledSection({ name: ref.name, declared: false }), ref.anchor)
        : unresolvedHealth(module, host, ref.name, ref.anchor),
    onNonEmpty: (trail, rest) =>
      rest.length > 0
        ? ambiguous(ref.name, ref.anchor, trails.length, pathsTo(book, module.path, trails))
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
    Option.flatMap(sectionOf(trail), (reached) => codeOf(modules, reached)),
    {
      onNone: () =>
        Array.lastNonEmpty(trail).place._tag === 'Box'
          ? faulty(UnsettledSection({ name: ref.name, declared: true }), ref.anchor)
          : unresolved(ref.name, ref.anchor),
      onSome: (code) =>
        reachedHealth(
          ref.name,
          ref.anchor,
          host.languageId,
          code,
          Array.lastNonEmpty(trail).place._tag === 'Chapter',
          ref.toBeSettled,
        ),
    },
  )

const reachedHealth = (
  name: string,
  at: Position,
  host: string,
  code: Code,
  whole: boolean,
  label: Option.Option<Position>,
): Health =>
  Match.value({
    written: Array.isReadonlyArrayNonEmpty(code.fragments),
    whole,
    sameLanguage: code.languageId === host,
  }).pipe(
    Match.when({ written: false, whole: true }, () => faulty(ChapterWithoutCode({ name }), at)),
    Match.when({ written: false }, () => faulty(UnsettledSection({ name, declared: true }), at)),
    Match.when({ sameLanguage: false }, () => crossLanguage(name, at, host, code.languageId)),
    Match.orElse(() => settledHealth(name, at, label)),
  )

const settleAt = (module: LoomModule, at: Position): Option.Option<Position> =>
  pipe(
    module.doc.sections,
    Array.flatMap((section) => Array.flatMap(section.code, (weft) => weft.anchors)),
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

export const targetOf = (book: Book, from: Location, ref: NameRef): Option.Option<SectionId> =>
  Option.orElse(ref.target, () =>
    Option.map(resolveName(book, from, ref.name), (reached) => ({
      path: reached.module,
      name: sectionNameOf(reached.section),
    })),
  )

export interface Landed {
  readonly loom: Location
  readonly file: File
}

export type Referred = Data.TaggedEnum<{
  Named: { readonly landed: Landed }
  Unsettled: { readonly declared: boolean }
  Faulted: { readonly health: Health }
}>

export const Referred = Data.taggedEnum<Referred>()

type ReferredNode = Data.TaggedEnum<{
  Chapter: { readonly module: LoomModule }
  Section: { readonly id: SectionId }
}>

const ReferredNode = Data.taggedEnum<ReferredNode>()

export const referredFileOf = (
  book: Book,
  modules: ReadonlyMap<string, LoomModule>,
  landing: Landing,
  module: LoomModule,
  host: Code,
  ref: ModuleRef,
): Referred =>
  Result.match(referredNodeOf(book, module, host, ref), {
    onFailure: (stopped) => stopped,
    onSuccess: (node) =>
      ReferredNode.$match(node, {
        Chapter: ({ module: chapter }) => chapterFile(ref, filesOf(chapter)),
        Section: ({ id }) => sectionFile(modules, landing, host, ref, id),
      }),
  })

const referredNodeOf = (
  book: Book,
  module: LoomModule,
  host: Code,
  ref: ModuleRef,
): Result.Result<ReferredNode, Referred> =>
  Option.match(ref.target, {
    onSome: (id) => Result.succeed(ReferredNode.Section({ id })),
    onNone: () => {
      const trails = trailsOf(book, module.path, ref.name)
      return Array.matchLeft(trails, {
        onEmpty: () =>
          Result.fail(
            isMeant(ref)
              ? Referred.Unsettled({ declared: false })
              : Referred.Faulted({ health: unresolvedHealth(module, host, ref.name, ref.anchor) }),
          ),
        onNonEmpty: (trail, rest) =>
          rest.length > 0
            ? Result.fail(
                Referred.Faulted({
                  health: ambiguous(
                    ref.name,
                    ref.anchor,
                    trails.length,
                    pathsTo(book, module.path, trails),
                  ),
                }),
              )
            : nodeOfPlace(Array.lastNonEmpty(trail).place, ref),
      })
    },
  })

const nodeOfPlace = (place: Place, ref: ModuleRef): Result.Result<ReferredNode, Referred> =>
  Match.value(place).pipe(
    Match.tag('Chapter', ({ chapter }) =>
      Result.succeed(ReferredNode.Chapter({ module: chapter.module })),
    ),
    Match.tag('Section', ({ ref: reached }) =>
      Result.succeed(
        ReferredNode.Section({
          id: { path: reached.module, name: sectionNameOf(reached.section) },
        }),
      ),
    ),
    Match.tag('Box', () => Result.fail(Referred.Unsettled({ declared: true }))),
    Match.tag('Part', () =>
      Result.fail(Referred.Faulted({ health: unresolved(ref.name, ref.anchor) })),
    ),
    Match.exhaustive,
  )

const filesOf = (module: LoomModule): ReadonlyArray<Landed> =>
  Array.map(module.product.files, (file): Landed => ({ loom: module.path, file }))

const isNamed = (path: string, written: string): boolean =>
  path === written || path.endsWith(`/${written}`)

const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

const fileNames = (files: ReadonlyArray<Landed>): ReadonlyArray<string> => {
  const bases = Array.map(files, (landed) => baseName(landed.file.path))
  return Array.map(files, (landed, i) =>
    Array.filter(bases, (base) => base === bases[i]).length > 1
      ? landed.file.path
      : baseName(landed.file.path),
  )
}

const chapterFile = (ref: ModuleRef, files: ReadonlyArray<Landed>): Referred =>
  Array.isReadonlyArrayNonEmpty(files)
    ? fileAmong(ref, files)
    : Referred.Unsettled({ declared: true })

const fileAmong = (ref: ModuleRef, files: Array.NonEmptyReadonlyArray<Landed>): Referred =>
  Option.match(ref.file, {
    onSome: (written) =>
      Option.match(
        Array.findFirst(files, (landed) => isNamed(landed.file.path, written.name)),
        {
          onSome: (landed) => Referred.Named({ landed }),
          onNone: () =>
            Referred.Faulted({
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
        ? Referred.Named({ landed: Array.headNonEmpty(files) })
        : Referred.Faulted({
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
): Referred => {
  const own = pipe(
    Option.match(Option.fromNullishOr(modules.get(id.path)), {
      onNone: (): ReadonlyArray<Landed> => [],
      onSome: filesOf,
    }),
    Array.filter((landed) => landed.file.code.origin.name === id.name),
  )
  if (Array.isReadonlyArrayNonEmpty(own)) return fileAmong(ref, own)
  return Option.match(ref.file, {
    onSome: (written) =>
      Referred.Faulted({
        health: faulty(
          NoSuchFile({ name: ref.name, file: written.name, files: [], at: written.at }),
          ref.anchor,
        ),
      }),
    onNone: () => landedFile(landing, host, ref, id),
  })
}

const landedFile = (landing: Landing, host: Code, ref: ModuleRef, id: SectionId): Referred => {
  const lands = landedIn(landing, id)
  const here = landedIn(landing, host.origin)
  const inHere = (landed: Landed): boolean => Array.some(here, (one) => sameFile(one, landed))
  const sole = lands.length === 1 ? Array.head(lands) : Option.none<Landed>()
  return Option.match(
    Option.filter(sole, (landed) => !inHere(landed)),
    {
      onSome: (landed) => Referred.Named({ landed }),
      onNone: () =>
        Referred.Faulted({
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

export const holdsReferences = (modules: ReadonlyMap<string, LoomModule>): boolean =>
  Array.some(Array.fromIterable(modules.values()), (module) =>
    Array.some(module.product.code, (code) =>
      Array.some(code.fragments, (part) => part.type === 'ModuleRef'),
    ),
  )

const codeAt = (modules: ReadonlyMap<string, LoomModule>, id: SectionId): Option.Option<Code> =>
  pipe(
    Option.fromNullishOr(modules.get(id.path)),
    Option.flatMap((there) => Array.findFirst(there.product.code, (code) => code.origin.name === id.name)),
  )

const reachedFrom = (
  book: Book,
  modules: ReadonlyMap<string, LoomModule>,
  root: Code,
): ReadonlyArray<string> => {
  const walk = (seen: ReadonlySet<string>, code: Code): ReadonlySet<string> =>
    Array.reduce(code.fragments, seen, (reached, part) =>
      part.type !== 'NameRef'
        ? reached
        : pipe(
            targetOf(book, code.origin.path, part),
            Option.filter((target) => !reached.has(keyOf(target))),
            Option.flatMap((target) =>
              Option.map(codeAt(modules, target), (next) =>
                walk(new Set([...reached, keyOf(target)]), next),
              ),
            ),
            Option.getOrElse(() => reached),
          ),
    )
  return Array.fromIterable(walk(new Set([keyOf(root.origin)]), root))
}

export const landingOf = (book: Book, modules: ReadonlyMap<string, LoomModule>): Landing =>
  holdsReferences(modules)
    ? pipe(
        Array.fromIterable(modules.values()),
        Array.flatMap(filesOf),
        Array.flatMap((landed) =>
          Array.map(reachedFrom(book, modules, landed.file.code), (key) => ({ key, landed })),
        ),
        Array.groupBy((entry) => entry.key),
        Record.map((entries) => Array.map(entries, (entry) => entry.landed)),
      )
    : {}

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
    pipe(
      sections,
      Array.filter((section) => section.heading.title !== undefined),
      Array.map((section) => [identityOf(section), section] as const),
      Array.reverse,
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
  Array.flatMap(section.code, (weft) =>
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
