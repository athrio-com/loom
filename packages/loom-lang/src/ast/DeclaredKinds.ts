import { Array, Match, Option, Order, pipe, Result, Schema, SchemaIssue } from 'effect'
import { type Document, isNode, parseDocument } from 'yaml'
import {
  type Diagnostic,
  type Point,
  type Position,
  shifted,
  byType,
} from '@athrio/loom-ast/LoomNode'
import type { LoomSection, ParsedDocument } from '@athrio/loom-ast/LoomAst'
import type { LoomWeft } from '@athrio/loom-ast/Weft'
import {
  anchorKeys,
  anchorKinds,
  boxKeys,
  boxKind,
  boxKinds,
  closesFence,
  type DataFormat,
  frontmatterKeys,
  type FrontmatterTropeToken,
  headingKeys,
  identityWords,
  type Keys,
  keyType,
  loomKinds,
  openingFence,
  type ParameterToken,
  type ParametersToken,
  sectionKinds,
  type SpecifierToken,
  type Standing,
  tropeKind,
  type ValueType,
  type Zone,
} from '@athrio/loom-ast/LoomTokens'
import {
  type Catalogue,
  catalogueOf,
  type Location,
  type LoomModule,
  type OpenedBox,
  openedBoxesOf,
} from '@athrio/loom-ast/LoomCorpusAst'
import { isManifest, sectionNameOf } from './ProductBuilder'
import type { Code } from '@athrio/loom-ast/ProductAst'
import { fromCode, unfoundIn } from './LoomVirtualCodeBuilder'
import {
  faulty,
  KeyOutsideTrope,
  type LoomFault,
  MissingField,
  TropeRefused,
  UnknownField,
  UnknownKind,
  UnreadBody,
  WrongField,
} from './LoomFault'
import {
  anchorKindsOf,
  boxKindsOf,
  type DataBody,
  dataOf,
  headingKeysOf,
  heldBy,
  loomKindsOf,
  parametersOf,
  parsedJson,
  readManifest,
  sectionKindsOf,
  type TropeManifest,
} from './TropeManifest'

export type Trope = {
  readonly name: string
  readonly chapters: ReadonlyArray<LoomModule>
  readonly root: Option.Option<LoomModule>
}

export type DeclaredBox = {
  readonly kind: string
  readonly body: string
  readonly data: Option.Option<DataBody>
  readonly parameters: Keys
  readonly trope: string
  readonly module: Location
}

export type DeclaredSection = {
  readonly kind: string
  readonly parameters: Keys
  readonly codeless: boolean
  readonly trope: string
  readonly module: Location
}

export type DeclaredAnchor = {
  readonly kind: string
  readonly parameters: Keys
  readonly standsIn: Option.Option<Standing>
  readonly trope: string
  readonly module: Location
}

export type DeclaredLoom = {
  readonly kind: string
  readonly numbered: boolean
  readonly zone: Zone
  readonly codeless: boolean
  readonly holds: ReadonlyArray<string>
  readonly trope: string
  readonly module: Location
}

export type DeclaredKey = {
  readonly key: string
  readonly type: ValueType
  readonly trope: string
  readonly module: Location
}

export type Declarations = {
  readonly box: ReadonlyArray<DeclaredBox>
  readonly section: ReadonlyArray<DeclaredSection>
  readonly anchor: ReadonlyArray<DeclaredAnchor>
  readonly loom: ReadonlyArray<DeclaredLoom>
  readonly headings: ReadonlyArray<DeclaredKey>
}

export const noDeclarations: Declarations = {
  box: [],
  section: [],
  anchor: [],
  loom: [],
  headings: [],
}

export type Refusal = { readonly module: Location; readonly reason: string; readonly at: Position }

export type DeclaredKinds = Declarations & { readonly refusals: ReadonlyArray<Refusal> }

export const declarationsOf = (kinds: DeclaredKinds): Declarations => ({
  box: kinds.box,
  section: kinds.section,
  anchor: kinds.anchor,
  loom: kinds.loom,
  headings: kinds.headings,
})

const tropeLine = (doc: ParsedDocument): Option.Option<FrontmatterTropeToken> =>
  Option.orElse(Option.fromNullishOr(doc.frontmatter?.trope), () =>
    Option.fromNullishOr(doc.frontmatter?.rootedIn),
  )

export const tropeIn = (doc: ParsedDocument): Option.Option<string> =>
  Option.map(tropeLine(doc), (line) => line.value)

export const tropeOf = (module: LoomModule): Option.Option<string> => tropeIn(module.doc)

export const tropeLineOf = (module: LoomModule): Position =>
  Option.getOrElse(
    Option.map(tropeLine(module.doc), (line) => line.position),
    () => module.doc.position,
  )

export const rootsTrope = (module: LoomModule): boolean =>
  module.doc.frontmatter?.trope !== undefined

export const tropesOf = (modules: ReadonlyMap<Location, LoomModule>): ReadonlyArray<Trope> => {
  const named = Array.sort(
    Array.fromIterable(modules.values()).filter((module) => Option.isSome(tropeOf(module))),
    Order.mapInput(Order.String, (module: LoomModule) => module.path),
  )
  return Array.dedupe(Array.getSomes(named.map(tropeOf))).map((name): Trope => {
    const chapters = named.filter((module) => Option.contains(tropeOf(module), name))
    return { name, chapters, root: Array.findFirst(chapters, rootsTrope) }
  })
}

const manifestSectionsOf = (module: LoomModule): ReadonlyArray<LoomSection> =>
  module.doc.sections.filter(isManifest)

type Read = { readonly manifest: TropeManifest; readonly at: Position }

const composedOf = (
  modules: ReadonlyMap<Location, LoomModule>,
  catalogue: Catalogue,
  code: Code,
): Result.Result<string, string> =>
  Array.match(unfoundIn(modules, code, catalogue), {
    onEmpty: () => Result.succeed(fromCode(modules, code, catalogue).code),
    onNonEmpty: ([name]) =>
      Result.fail(
        `an anchor in its manifest names \`${name}\`, and no chapter of the trope holds a section called that`,
      ),
  })

const manifestOf = (
  modules: ReadonlyMap<Location, LoomModule>,
  catalogue: Catalogue,
  root: LoomModule,
  manifests: Array.NonEmptyReadonlyArray<LoomSection>,
): Result.Result<Read, Refusal> => {
  const [section, ...others] = manifests
  const refusal = (reason: string, at: Position): Refusal => ({ module: root.path, reason, at })
  return Array.match(others, {
    onNonEmpty: ([second]) =>
      Result.fail(refusal('it holds more than one manifest', second.heading.position)),
    onEmpty: () =>
      pipe(
        Array.findFirst(root.product.code, (code) => code.origin.name === sectionNameOf(section)),
        Option.match({
          onNone: (): Result.Result<string, string> => Result.succeed(''),
          onSome: (code) => composedOf(modules, catalogue, code),
        }),
        Result.flatMap(readManifest),
        Result.map((manifest): Read => ({ manifest, at: section.heading.position })),
        Result.mapError((reason) => refusal(reason, section.heading.position)),
      ),
  })
}

const sameKind = (one: string, other: string): boolean => one.toLowerCase() === other.toLowerCase()

type Taken = { readonly kind: string; readonly trope: string }

const clashReason = Match.fn(
  (
    _within: {
      readonly kind: string
    },
    found: {
      readonly core: boolean
      readonly earlier: Option.Option<Taken>
      readonly twice: boolean
    },
  ) => found,
).pipe(
  Match.withReturnType<Option.Option<string>>(),
  Match.when({ core: true }, (_found, { kind }) =>
    Option.some(`\`${kind}\` is one of Loom's own kinds`),
  ),
  Match.when({ earlier: Option.isSome }, ({ earlier }, { kind }) =>
    Option.map(earlier, (other) => `the \`${other.trope}\` trope declares \`${kind}\` already`),
  ),
  Match.when({ twice: true }, (_found, { kind }) => Option.some(`it declares \`${kind}\` twice`)),
  Match.orElse(() => Option.none<string>()),
)

const clashOf = (
  declared: ReadonlyArray<string>,
  core: ReadonlyArray<string>,
  taken: ReadonlyArray<Taken>,
): Option.Option<string> =>
  Array.findFirst(declared, (kind, at) =>
    clashReason(
      { kind },
      {
        core: core.some((own) => sameKind(own, kind)),
        earlier: Array.findFirst(taken, (other) => sameKind(other.kind, kind)),
        twice: Array.take(declared, at).some((before) => sameKind(before, kind)),
      },
    ),
  )

const ownKeyOf = (declared: ReadonlyArray<Keys>, own: Keys): Option.Option<string> =>
  pipe(
    declared.flatMap((parameters) => Object.keys(parameters)),
    Array.findFirst((key) => Option.isSome(keyType(own, key))),
    Option.map((key) => `\`${key}\` is one of Loom's own keys`),
  )

const kindsIn = (declared: ReadonlyArray<{ readonly kind: string }>): ReadonlyArray<string> =>
  declared.map((declaration) => declaration.kind)

type KindWithKeys = { readonly kind: string; readonly parameters: Keys }

const headingClash = (manifest: TropeManifest, taken: Declarations): Option.Option<string> => {
  const forHeadings = Object.keys(headingKeysOf(manifest))
  const ownSections = sectionKindsOf(manifest).map((declaration): KindWithKeys => ({
    kind: declaration.kind,
    parameters: parametersOf(declaration),
  }))
  const sections: ReadonlyArray<KindWithKeys> = [...taken.section, ...ownSections]
  const onHeadings = [
    ...forHeadings,
    ...ownSections.flatMap((section) => Object.keys(section.parameters)),
  ]
  return pipe(
    Array.findFirst(onHeadings, (key) =>
      Array.findFirst(taken.headings, (other) => other.key === key),
    ),
    Option.map(
      (other) => `the \`${other.trope}\` trope lets any heading carry \`${other.key}\` already`,
    ),
    Option.orElse(() =>
      Array.findFirst(forHeadings, (key) =>
        Option.map(
          Array.findFirst(sections, (section) => Option.isSome(keyType(section.parameters, key))),
          (section) => `\`${key}\` is a parameter of the \`${section.kind}\` kind of section already`,
        ),
      ),
    ),
  )
}

const lineClash = (manifest: TropeManifest): Option.Option<string> =>
  Array.findFirst(kindsIn(loomKindsOf(manifest)), (kind) =>
    pipe(
      Array.findFirst(kind.split(' '), (word) => identityWords.some((own) => sameKind(own, word))),
      Option.map((word) => `\`${kind}\` holds \`${word}\`, a word of Loom's own identity lines`),
      Option.orElse(() =>
        frontmatterKeys.some((key) => sameKind(key, kind))
          ? Option.some(`\`${kind}\` is a line of the frontmatter already`)
          : Option.none(),
      ),
    ),
  )

const unheldIn = (manifest: TropeManifest): Option.Option<string> =>
  Array.findFirst(loomKindsOf(manifest), (loom) =>
    Option.map(
      Array.findFirst(
        heldBy(loom),
        (held) => !sectionKindsOf(manifest).some((section) => sameKind(section.kind, held)),
      ),
      (held) =>
        `its \`${loom.kind}\` kind of loom holds \`${held}\`, and its manifest declares no kind of section called that`,
    ),
  )

const refusalIn = (manifest: TropeManifest, taken: Declarations): Option.Option<string> =>
  pipe(
    clashOf(kindsIn(boxKindsOf(manifest)), boxKinds, taken.box),
    Option.orElse(() => clashOf(kindsIn(sectionKindsOf(manifest)), sectionKinds, taken.section)),
    Option.orElse(() => clashOf(kindsIn(anchorKindsOf(manifest)), anchorKinds, taken.anchor)),
    Option.orElse(() => clashOf(kindsIn(loomKindsOf(manifest)), loomKinds, taken.loom)),
    Option.orElse(() => lineClash(manifest)),
    Option.orElse(() => unheldIn(manifest)),
    Option.orElse(() => ownKeyOf(boxKindsOf(manifest).map(parametersOf), boxKeys)),
    Option.orElse(() =>
      ownKeyOf(
        [...sectionKindsOf(manifest).map(parametersOf), headingKeysOf(manifest)],
        headingKeys,
      ),
    ),
    Option.orElse(() => ownKeyOf(anchorKindsOf(manifest).map(parametersOf), anchorKeys)),
    Option.orElse(() => headingClash(manifest, taken)),
  )

export const titleOf = (module: LoomModule): string =>
  Option.getOrElse(
    Option.map(Option.fromNullishOr(module.doc.frontmatter?.title), (title) => title.value),
    () => module.path,
  )

const boxesOf = (
  trope: string,
  root: LoomModule,
  manifest: TropeManifest,
): ReadonlyArray<DeclaredBox> =>
  boxKindsOf(manifest).map((declaration): DeclaredBox => ({
    kind: declaration.kind,
    body: declaration.body,
    data: dataOf(declaration),
    parameters: parametersOf(declaration),
    trope,
    module: root.path,
  }))

const sectionsOf = (
  trope: string,
  root: LoomModule,
  manifest: TropeManifest,
): ReadonlyArray<DeclaredSection> =>
  sectionKindsOf(manifest).map((declaration): DeclaredSection => ({
    kind: declaration.kind,
    parameters: parametersOf(declaration),
    codeless: declaration.code === 'none',
    trope,
    module: root.path,
  }))

const anchorsOf = (
  trope: string,
  root: LoomModule,
  manifest: TropeManifest,
): ReadonlyArray<DeclaredAnchor> =>
  anchorKindsOf(manifest).map((declaration): DeclaredAnchor => ({
    kind: declaration.kind,
    parameters: parametersOf(declaration),
    standsIn: Option.fromNullishOr(declaration.standsIn),
    trope,
    module: root.path,
  }))

const loomsOf = (
  trope: string,
  root: LoomModule,
  manifest: TropeManifest,
): ReadonlyArray<DeclaredLoom> =>
  loomKindsOf(manifest).map((declaration): DeclaredLoom => ({
    kind: declaration.kind,
    numbered: declaration.numbered === true,
    zone: Option.getOrElse(Option.fromNullishOr(declaration.zone), (): Zone => 'body'),
    codeless: declaration.code === 'none',
    holds: heldBy(declaration),
    trope,
    module: root.path,
  }))

const headingsOf = (
  trope: string,
  root: LoomModule,
  manifest: TropeManifest,
): ReadonlyArray<DeclaredKey> =>
  Object.entries(headingKeysOf(manifest)).map(([key, type]): DeclaredKey => ({
    key,
    type,
    trope,
    module: root.path,
  }))

const refused = (kinds: DeclaredKinds, refusal: Refusal): DeclaredKinds => ({
  ...kinds,
  refusals: [...kinds.refusals, refusal],
})

const withRoot = (
  modules: ReadonlyMap<Location, LoomModule>,
  catalogue: Catalogue,
  kinds: DeclaredKinds,
  trope: string,
  root: LoomModule,
): DeclaredKinds =>
  Array.match(manifestSectionsOf(root), {
    onEmpty: () => kinds,
    onNonEmpty: (manifests) =>
      Result.match(manifestOf(modules, catalogue, root, manifests), {
        onFailure: (refusal) => refused(kinds, refusal),
        onSuccess: ({ manifest, at }) =>
          Option.match(refusalIn(manifest, kinds), {
            onSome: (reason) => refused(kinds, { module: root.path, reason, at }),
            onNone: () => ({
              ...kinds,
              box: [...kinds.box, ...boxesOf(trope, root, manifest)],
              section: [...kinds.section, ...sectionsOf(trope, root, manifest)],
              anchor: [...kinds.anchor, ...anchorsOf(trope, root, manifest)],
              loom: [...kinds.loom, ...loomsOf(trope, root, manifest)],
              headings: [...kinds.headings, ...headingsOf(trope, root, manifest)],
            }),
          }),
      }),
  })

const chaptersOf = (trope: Trope): ReadonlyMap<Location, LoomModule> =>
  new Map(trope.chapters.map((chapter) => [chapter.path, chapter] as const))

const withTrope = (kinds: DeclaredKinds, trope: Trope): DeclaredKinds => {
  const others = trope.chapters.filter(
    (chapter) => !Option.exists(trope.root, (root) => root.path === chapter.path),
  )
  const duplicates = Option.match(trope.root, {
    onNone: (): ReadonlyArray<Refusal> => [],
    onSome: (root) =>
      others.filter(rootsTrope).map((chapter): Refusal => ({
        module: chapter.path,
        reason: `another trope chapter is called \`${titleOf(root)}\``,
        at: tropeLineOf(chapter),
      })),
  })
  const settled: DeclaredKinds = { ...kinds, refusals: [...kinds.refusals, ...duplicates] }
  return Option.match(trope.root, {
    onNone: () => settled,
    onSome: (root) => {
      const own = chaptersOf(trope)
      return withRoot(own, catalogueOf(own), settled, trope.name, root)
    },
  })
}

export const declaredKindsOf = (
  modules: ReadonlyMap<Location, LoomModule>,
  installed: Declarations = noDeclarations,
): DeclaredKinds => {
  const fromInstalled: DeclaredKinds = { ...installed, refusals: [] }
  return tropesOf(modules).reduce(withTrope, fromInstalled)
}

const writtenKind: (
  specifier: SpecifierToken | ParametersToken,
) => Option.Option<{ readonly kind: string; readonly at: Position }> =
  byType<SpecifierToken | ParametersToken>()({
    Specifier: (labelled) =>
      labelled.label.health.status === 'ok'
        ? Option.some({ kind: labelled.label.value, at: labelled.label.position })
        : Option.none(),
    Parameters: (held) =>
      pipe(
        Array.findFirst(held.parameters, (parameter) => parameter.key.value === 'kind'),
        Option.flatMap((parameter) => Array.head(parameter.values)),
        Option.map((value) => ({ kind: value.value, at: value.position })),
      ),
  })

export const kindFaults = (kinds: DeclaredKinds, module: LoomModule): ReadonlyArray<Diagnostic> => {
  const known = [...boxKinds, ...kinds.box.map((declared) => declared.kind)]
  const refused = kinds.refusals
    .filter((refusal) => refusal.module === module.path)
    .flatMap((refusal) => faulty(TropeRefused({ reason: refusal.reason }), refusal.at).diagnostics)
  const unknown = openedBoxesOf(module.doc)
    .flatMap((opened) => Option.toArray(Option.fromNullishOr(opened.box.specifier)))
    .flatMap((specifier) => Option.toArray(writtenKind(specifier)))
    .filter(({ kind }) => !known.some((each) => sameKind(each, kind)))
    .flatMap(
      ({ kind, at }) => faulty(UnknownKind({ kind, kinds: known, on: 'box' }), at).diagnostics,
    )
  return [...refused, ...unknown, ...keysOutsideTrope(module), ...bodyFaults(kinds, module)]
}

const keysOutsideTrope = (module: LoomModule): ReadonlyArray<Diagnostic> =>
  openedBoxesOf(module.doc)
    .filter((opened) => boxKind(opened.box) !== tropeKind)
    .flatMap((opened) =>
      Option.match(Option.fromNullishOr(opened.box.specifier), {
        onNone: (): ReadonlyArray<ParameterToken> => [],
        onSome: (specifier) => (specifier.type === 'Parameters' ? specifier.parameters : []),
      }),
    )
    .filter((parameter) => ['provides', 'anchors'].includes(parameter.key.value))
    .flatMap(
      (parameter) =>
        faulty(KeyOutsideTrope({ key: parameter.key.value }), parameter.key.position).diagnostics,
    )

const dataLines = (body: ReadonlyArray<LoomWeft>): ReadonlyArray<LoomWeft> =>
  pipe(
    Option.all({ first: Array.head(body), last: Array.last(body) }),
    Option.filter(
      ({ first, last }) =>
        body.length > 1 &&
        Option.exists(openingFence(first.source), (fence) => closesFence(fence)(last.source)),
    ),
    Option.match({
      onNone: () => body,
      onSome: () => pipe(body, Array.drop(1), Array.dropRight(1)),
    }),
  )

type Span = readonly [start: number, end: number]

const wholeOf = (opened: OpenedBox, lines: ReadonlyArray<LoomWeft>): Position =>
  Option.match(Option.all({ first: Array.head(lines), last: Array.last(lines) }), {
    onNone: () => opened.opener.position,
    onSome: ({ first, last }) => ({ start: first.position.start, end: last.position.end }),
  })

const pointIn =
  (lines: ReadonlyArray<LoomWeft>, whole: Position) =>
  (offset: number): Point =>
    Option.match(
      Array.findLast(lines, (line) => line.position.start.offset <= whole.start.offset + offset),
      {
        onNone: () => whole.start,
        onSome: (line) =>
          shifted(line.position.start, whole.start.offset + offset - line.position.start.offset),
      },
    )

type Path = ReadonlyArray<PropertyKey>

const spanAt = (document: Document, path: Path): Option.Option<Span> =>
  pipe(
    Option.liftPredicate(document.getIn(path, true), isNode),
    Option.flatMap((node) => Option.fromNullishOr(node.range)),
    Option.map(([start, end]): Span => [start, end]),
    Option.orElse(() =>
      Array.match(path, {
        onEmpty: () => Option.none(),
        onNonEmpty: (steps) => spanAt(document, Array.initNonEmpty(steps)),
      }),
    ),
  )

const valueOf: Record<
  DataFormat,
  (text: string, document: Document) => Result.Result<unknown, Option.Option<string>>
> = {
  yaml: (_text, document) =>
    Option.match(Array.head(document.errors), {
      onNone: () => Result.succeed(document.toJS()),
      onSome: (error) => Result.fail(Option.some(error.message)),
    }),
  json: (text) => Result.mapError(parsedJson(text), () => Option.none()),
}

type Misfit = { readonly path: Path; readonly fault: LoomFault }

const stepOf = (step: PropertyKey): string =>
  typeof step === 'number' ? `[${step}]` : `.${String(step)}`

const fieldOf = (path: Path): string => path.map(stepOf).join('').replace(/^\./, '')

const worded = SchemaIssue.makeFormatterStandardSchemaV1()

const wordsOf = (issue: SchemaIssue.Issue): string =>
  worded(issue)
    .issues.map((each) => each.message)
    .join(', ')

const misfitsIn: (
  kind: string,
  issue: SchemaIssue.Issue,
  path: Path,
) => ReadonlyArray<Misfit> = Match.fn(
  (_kind: string, issue: SchemaIssue.Issue, _path: Path) => issue,
).pipe(
  Match.tag('Pointer', (pointer, kind, _issue, path) =>
    misfitsIn(kind, pointer.issue, [...path, ...pointer.path]),
  ),
  Match.tag('Composite', (composite, kind, _issue, path) =>
    composite.issues.flatMap((each) => misfitsIn(kind, each, path)),
  ),
  Match.tag('Encoding', (encoding, kind, _issue, path) => misfitsIn(kind, encoding.issue, path)),
  Match.tag('AnyOf', (anyOf, kind, _issue, path) =>
    Array.match(anyOf.issues, {
      onEmpty: (): ReadonlyArray<Misfit> => [
        { path, fault: WrongField({ kind, field: fieldOf(path), reason: wordsOf(anyOf) }) },
      ],
      onNonEmpty: (issues) => issues.flatMap((each) => misfitsIn(kind, each, path)),
    }),
  ),
  Match.tag('MissingKey', (_matched, kind, _issue, path): ReadonlyArray<Misfit> => [
    { path, fault: MissingField({ kind, field: fieldOf(path) }) },
  ]),
  Match.tag('UnexpectedKey', (_matched, kind, _issue, path): ReadonlyArray<Misfit> => [
    { path, fault: UnknownField({ kind, field: fieldOf(path) }) },
  ]),
  Match.tag(
    'Filter',
    'InvalidType',
    'InvalidValue',
    'Forbidden',
    'OneOf',
    (unfit, kind, _issue, path): ReadonlyArray<Misfit> => [
      { path, fault: WrongField({ kind, field: fieldOf(path), reason: wordsOf(unfit) }) },
    ],
  ),
  Match.exhaustive,
)

const bodyFaultsOf = (kind: string, data: DataBody, opened: OpenedBox): ReadonlyArray<Diagnostic> => {
  const lines = dataLines(opened.body)
  const whole = wholeOf(opened, lines)
  const pointAt = pointIn(lines, whole)
  const text = lines.map((line) => line.source).join('')
  const document = parseDocument(text, { prettyErrors: false })
  const positionOf = (span: Option.Option<Span>): Position =>
    Option.match(span, {
      onNone: () => whole,
      onSome: ([start, end]) => ({ start: pointAt(start), end: pointAt(end) }),
    })
  return Result.match(valueOf[data.format](text, document), {
    onFailure: (reason) =>
      faulty(
        UnreadBody({ kind, format: data.format, reason: Option.getOrUndefined(reason) }),
        positionOf(Option.map(Array.head(document.errors), (error): Span => error.pos)),
      ).diagnostics,
    onSuccess: (value) =>
      Result.match(
        Schema.decodeUnknownResult(data.codec)(value, { errors: 'all', onExcessProperty: 'error' }),
        {
          onSuccess: (): ReadonlyArray<Diagnostic> => [],
          onFailure: (error) =>
            misfitsIn(kind, error.issue, []).flatMap(
              ({ path, fault }) => faulty(fault, positionOf(spanAt(document, path))).diagnostics,
            ),
        },
      ),
  })
}

const bodyFaults = (kinds: DeclaredKinds, module: LoomModule): ReadonlyArray<Diagnostic> =>
  openedBoxesOf(module.doc).flatMap((opened) =>
    pipe(
      Array.findFirst(kinds.box, (declared) => sameKind(declared.kind, boxKind(opened.box))),
      Option.flatMap((declared) =>
        Option.map(declared.data, (data) => bodyFaultsOf(declared.kind, data, opened)),
      ),
      Option.getOrElse((): ReadonlyArray<Diagnostic> => []),
    ),
  )
