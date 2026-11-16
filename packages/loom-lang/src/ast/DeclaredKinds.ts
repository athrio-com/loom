import { Array, Match, Option, Order, pipe, Result } from 'effect'
import type { Diagnostic, Position } from '@athrio/loom-ast/LoomNode'
import type { LoomSection } from '@athrio/loom-ast/LoomAst'
import {
  boxKind,
  boxKinds,
  type FrontmatterTropeToken,
  headingKeys,
  type Keys,
  keyType,
  type ParameterToken,
  type ParametersToken,
  sectionKinds,
  type SpecifierToken,
  tropeKind,
} from '@athrio/loom-ast/LoomTokens'
import {
  type Catalogue,
  type Location,
  type LoomModule,
  openedBoxesOf,
} from '@athrio/loom-ast/LoomCorpusAst'
import { isManifest, sectionNameOf } from './ProductBuilder'
import type { Code } from '@athrio/loom-ast/ProductAst'
import { fromCode, unfoundIn } from './LoomVirtualCodeBuilder'
import { faulty, KeyOutsideTrope, TropeRefused, UnknownKind } from './LoomFault'
import {
  boxKindsOf,
  readManifest,
  type SectionKindDeclaration,
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
  readonly trope: string
  readonly module: Location
}

export type DeclaredSection = {
  readonly kind: string
  readonly parameters: Keys
  readonly trope: string
  readonly module: Location
}

export type Declarations = {
  readonly box: ReadonlyArray<DeclaredBox>
  readonly section: ReadonlyArray<DeclaredSection>
}

export const noDeclarations: Declarations = { box: [], section: [] }

export type Refusal = { readonly module: Location; readonly reason: string; readonly at: Position }

export type DeclaredKinds = Declarations & { readonly refusals: ReadonlyArray<Refusal> }

const tropeLine = (module: LoomModule): Option.Option<FrontmatterTropeToken> =>
  Option.orElse(Option.fromNullishOr(module.doc.frontmatter?.trope), () =>
    Option.fromNullishOr(module.doc.frontmatter?.rootedIn),
  )

export const tropeOf = (module: LoomModule): Option.Option<string> =>
  Option.map(tropeLine(module), (line) => line.value)

export const tropeLineOf = (module: LoomModule): Position =>
  Option.getOrElse(
    Option.map(tropeLine(module), (line) => line.position),
    () => module.doc.position,
  )

export const rootsTrope = (module: LoomModule): boolean =>
  module.doc.frontmatter?.trope !== undefined

export const tropesOf = (modules: ReadonlyMap<Location, LoomModule>): ReadonlyArray<Trope> => {
  const named = pipe(
    Array.fromIterable(modules.values()),
    Array.filter((module) => Option.isSome(tropeOf(module))),
    Array.sort(Order.mapInput(Order.String, (module: LoomModule) => module.path)),
  )
  return Array.map(Array.dedupe(Array.getSomes(Array.map(named, tropeOf))), (name): Trope => {
    const chapters = Array.filter(named, (module) => Option.contains(tropeOf(module), name))
    return { name, chapters, root: Array.findFirst(chapters, rootsTrope) }
  })
}

const manifestSectionsOf = (module: LoomModule): ReadonlyArray<LoomSection> =>
  Array.filter(module.doc.sections, isManifest)

type Read = { readonly manifest: TropeManifest; readonly at: Position }

const composedOf = (
  modules: ReadonlyMap<Location, LoomModule>,
  catalogue: Catalogue,
  code: Code,
): Result.Result<string, string> =>
  Array.match(unfoundIn(modules, code, catalogue), {
    onEmpty: () => Result.succeed(fromCode(modules, code, catalogue).code),
    onNonEmpty: ([name]) =>
      Result.fail(`its manifest draws on \`${name}\`, which no chapter of a trope holds`),
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

const clashOf = (
  declared: ReadonlyArray<string>,
  core: ReadonlyArray<string>,
  taken: ReadonlyArray<Taken>,
): Option.Option<string> =>
  Array.findFirst(declared, (kind, at) =>
    Match.value({
      core: Array.some(core, (own) => sameKind(own, kind)),
      earlier: Array.findFirst(taken, (other) => sameKind(other.kind, kind)),
      twice: Array.some(Array.take(declared, at), (before) => sameKind(before, kind)),
    }).pipe(
      Match.when({ core: true }, () => Option.some(`\`${kind}\` is one of Loom's own kinds`)),
      Match.when({ earlier: Option.isSome }, ({ earlier }) =>
        Option.map(earlier, (other) => `the \`${other.trope}\` trope declares \`${kind}\` already`),
      ),
      Match.when({ twice: true }, () => Option.some(`it declares \`${kind}\` twice`)),
      Match.orElse(() => Option.none<string>()),
    ),
  )

const parametersOf = (declaration: SectionKindDeclaration): Keys =>
  Option.getOrElse(Option.fromNullishOr(declaration.parameters), (): Keys => ({}))

const ownKeyOf = (declared: ReadonlyArray<SectionKindDeclaration>): Option.Option<string> =>
  pipe(
    Array.flatMap(declared, (declaration) => Object.keys(parametersOf(declaration))),
    Array.findFirst((key) => Option.isSome(keyType(headingKeys, key))),
    Option.map((key) => `\`${key}\` is one of Loom's own keys`),
  )

const kindsIn = (declared: ReadonlyArray<{ readonly kind: string }>): ReadonlyArray<string> =>
  Array.map(declared, (declaration) => declaration.kind)

const refusalIn = (manifest: TropeManifest, taken: Declarations): Option.Option<string> =>
  pipe(
    clashOf(kindsIn(boxKindsOf(manifest)), boxKinds, taken.box),
    Option.orElse(() => clashOf(kindsIn(sectionKindsOf(manifest)), sectionKinds, taken.section)),
    Option.orElse(() => ownKeyOf(sectionKindsOf(manifest))),
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
  Array.map(boxKindsOf(manifest), (declaration): DeclaredBox => ({
    kind: declaration.kind,
    body: declaration.body,
    trope,
    module: root.path,
  }))

const sectionsOf = (
  trope: string,
  root: LoomModule,
  manifest: TropeManifest,
): ReadonlyArray<DeclaredSection> =>
  Array.map(sectionKindsOf(manifest), (declaration): DeclaredSection => ({
    kind: declaration.kind,
    parameters: parametersOf(declaration),
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
            }),
          }),
      }),
  })

const withTrope = (
  modules: ReadonlyMap<Location, LoomModule>,
  catalogue: Catalogue,
  kinds: DeclaredKinds,
  trope: Trope,
): DeclaredKinds => {
  const others = Array.filter(
    trope.chapters,
    (chapter) => !Option.exists(trope.root, (root) => root.path === chapter.path),
  )
  const duplicates = Option.match(trope.root, {
    onNone: (): ReadonlyArray<Refusal> => [],
    onSome: (root) =>
      Array.map(Array.filter(others, rootsTrope), (chapter): Refusal => ({
        module: chapter.path,
        reason: `another trope chapter is called \`${titleOf(root)}\``,
        at: tropeLineOf(chapter),
      })),
  })
  const settled: DeclaredKinds = { ...kinds, refusals: [...kinds.refusals, ...duplicates] }
  return Option.match(trope.root, {
    onNone: () => settled,
    onSome: (root) => withRoot(modules, catalogue, settled, trope.name, root),
  })
}

export const declaredKindsOf = (
  modules: ReadonlyMap<Location, LoomModule>,
  catalogue: Catalogue,
  installed: Declarations = noDeclarations,
): DeclaredKinds => {
  const fromInstalled: DeclaredKinds = { ...installed, refusals: [] }
  return Array.reduce(tropesOf(modules), fromInstalled, (kinds, trope) =>
    withTrope(modules, catalogue, kinds, trope),
  )
}

const writtenKind = (
  specifier: SpecifierToken | ParametersToken,
): Option.Option<{ readonly kind: string; readonly at: Position }> =>
  Match.value(specifier).pipe(
    Match.when({ type: 'Specifier' }, (labelled) =>
      labelled.label.health.status === 'ok'
        ? Option.some({ kind: labelled.label.value, at: labelled.label.position })
        : Option.none(),
    ),
    Match.when({ type: 'Parameters' }, (held) =>
      pipe(
        Array.findFirst(held.parameters, (parameter) => parameter.key.value === 'kind'),
        Option.flatMap((parameter) => Array.head(parameter.values)),
        Option.map((value) => ({ kind: value.value, at: value.position })),
      ),
    ),
    Match.exhaustive,
  )

export const kindFaults = (kinds: DeclaredKinds, module: LoomModule): ReadonlyArray<Diagnostic> => {
  const known = [...boxKinds, ...Array.map(kinds.box, (declared) => declared.kind)]
  const refused = pipe(
    kinds.refusals,
    Array.filter((refusal) => refusal.module === module.path),
    Array.flatMap(
      (refusal) => faulty(TropeRefused({ reason: refusal.reason }), refusal.at).diagnostics,
    ),
  )
  const unknown = pipe(
    openedBoxesOf(module.doc),
    Array.flatMap((opened) => Option.toArray(Option.fromNullishOr(opened.box.specifier))),
    Array.flatMap((specifier) => Option.toArray(writtenKind(specifier))),
    Array.filter(({ kind }) => !Array.some(known, (each) => sameKind(each, kind))),
    Array.flatMap(
      ({ kind, at }) => faulty(UnknownKind({ kind, kinds: known, on: 'box' }), at).diagnostics,
    ),
  )
  return [...refused, ...unknown, ...keysOutsideTrope(module)]
}

const keysOutsideTrope = (module: LoomModule): ReadonlyArray<Diagnostic> =>
  pipe(
    openedBoxesOf(module.doc),
    Array.filter((opened) => boxKind(opened.box) !== tropeKind),
    Array.flatMap((opened) =>
      Option.match(Option.fromNullishOr(opened.box.specifier), {
        onNone: (): ReadonlyArray<ParameterToken> => [],
        onSome: (specifier) => (specifier.type === 'Parameters' ? specifier.parameters : []),
      }),
    ),
    Array.filter((parameter) => ['provides', 'anchors'].includes(parameter.key.value)),
    Array.flatMap(
      (parameter) =>
        faulty(KeyOutsideTrope({ key: parameter.key.value }), parameter.key.position).diagnostics,
    ),
  )
