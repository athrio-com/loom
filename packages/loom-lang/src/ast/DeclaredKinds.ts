import { Array, Match, Option, Order, pipe, Result } from 'effect'
import type { Diagnostic, Position } from '@athrio/loom-ast/LoomNode'
import type { LoomSection } from '@athrio/loom-ast/LoomAst'
import {
  boxKind,
  boxKinds,
  type FrontmatterTropeToken,
  type ParameterToken,
  type ParametersToken,
  type SpecifierToken,
  tropeKind,
} from '@athrio/loom-ast/LoomTokens'
import {
  type Book,
  type Location,
  type LoomModule,
  openedBoxesOf,
} from '@athrio/loom-ast/LoomCorpusAst'
import { isManifest, sectionNameOf } from './ProductBuilder'
import { fromCode } from './LoomVirtualCodeBuilder'
import { faulty, KeyOutsideTrope, ManifestOffRoot, TropeRefused, UnknownKind } from './LoomFault'
import { type BoxKindDeclaration, readManifest, type TropeManifest } from './TropeManifest'

export type Trope = {
  readonly name: string
  readonly chapters: ReadonlyArray<LoomModule>
  readonly root: Option.Option<LoomModule>
}

export type DeclaredKind = {
  readonly kind: string
  readonly body: string
  readonly trope: string
  readonly module: Location
}

export type Refusal = { readonly module: Location; readonly reason: string; readonly at: Position }

export type Misplaced = { readonly module: Location; readonly trope: string; readonly at: Position }

export type DeclaredKinds = {
  readonly tropes: ReadonlyArray<Trope>
  readonly box: ReadonlyArray<DeclaredKind>
  readonly refusals: ReadonlyArray<Refusal>
  readonly misplaced: ReadonlyArray<Misplaced>
}

const noKinds: DeclaredKinds = { tropes: [], box: [], refusals: [], misplaced: [] }

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
  Array.filter(module.doc.sections, (section) =>
    Option.exists(Option.fromNullishOr(section.heading.specifier), isManifest),
  )

type Read = { readonly manifest: TropeManifest; readonly at: Position }

const manifestOf = (
  modules: ReadonlyMap<Location, LoomModule>,
  book: Book,
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
        Option.map((code) => fromCode(modules, code, book).code),
        Option.getOrElse(() => ''),
        readManifest,
        Result.map((manifest): Read => ({ manifest, at: section.heading.position })),
        Result.mapError((reason) => refusal(reason, section.heading.position)),
      ),
  })
}

const sameKind = (one: string, other: string): boolean => one.toLowerCase() === other.toLowerCase()

const clashOf = (
  declared: ReadonlyArray<BoxKindDeclaration>,
  taken: ReadonlyArray<DeclaredKind>,
): Option.Option<string> =>
  Array.findFirst(declared, (declaration, at) => {
    const kind = declaration.kind
    return Match.value({
      core: Array.some(boxKinds, (core) => sameKind(core, kind)),
      earlier: Array.findFirst(taken, (other) => sameKind(other.kind, kind)),
      twice: Array.some(Array.take(declared, at), (before) => sameKind(before.kind, kind)),
    }).pipe(
      Match.when({ core: true }, () =>
        Option.some(`it declares the box kind \`${kind}\`, which the core keeps for itself`),
      ),
      Match.when({ earlier: Option.isSome }, ({ earlier }) =>
        Option.map(
          earlier,
          (other) =>
            `it declares the box kind \`${kind}\`, which the trope \`${other.trope}\` declares already`,
        ),
      ),
      Match.when({ twice: true }, () => Option.some(`it declares the box kind \`${kind}\` twice`)),
      Match.orElse(() => Option.none<string>()),
    )
  })

export const titleOf = (module: LoomModule): string =>
  Option.getOrElse(
    Option.map(Option.fromNullishOr(module.doc.frontmatter?.title), (title) => title.value),
    () => module.path,
  )

const kindsOf = (
  trope: string,
  root: LoomModule,
  manifest: TropeManifest,
): ReadonlyArray<DeclaredKind> =>
  Array.map(manifest.contributes.kinds.box, (declaration): DeclaredKind => ({
    kind: declaration.kind,
    body: declaration.body,
    trope,
    module: root.path,
  }))

const refused = (kinds: DeclaredKinds, refusal: Refusal): DeclaredKinds => ({
  ...kinds,
  refusals: [...kinds.refusals, refusal],
})

const withRoot = (
  modules: ReadonlyMap<Location, LoomModule>,
  book: Book,
  kinds: DeclaredKinds,
  trope: string,
  root: LoomModule,
): DeclaredKinds =>
  Array.match(manifestSectionsOf(root), {
    onEmpty: () => kinds,
    onNonEmpty: (manifests) =>
      Result.match(manifestOf(modules, book, root, manifests), {
        onFailure: (refusal) => refused(kinds, refusal),
        onSuccess: ({ manifest, at }) =>
          Option.match(clashOf(manifest.contributes.kinds.box, kinds.box), {
            onSome: (reason) => refused(kinds, { module: root.path, reason, at }),
            onNone: () => ({ ...kinds, box: [...kinds.box, ...kindsOf(trope, root, manifest)] }),
          }),
      }),
  })

const withTrope = (
  modules: ReadonlyMap<Location, LoomModule>,
  book: Book,
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
        reason: `the trope \`${trope.name}\` already has its root in the chapter \`${titleOf(root)}\``,
        at: tropeLineOf(chapter),
      })),
  })
  const misplaced = pipe(
    others,
    Array.filter((chapter) => !rootsTrope(chapter)),
    Array.flatMap((member) =>
      Array.map(manifestSectionsOf(member), (section): Misplaced => ({
        module: member.path,
        trope: trope.name,
        at: section.heading.position,
      })),
    ),
  )
  const settled: DeclaredKinds = {
    ...kinds,
    refusals: [...kinds.refusals, ...duplicates],
    misplaced: [...kinds.misplaced, ...misplaced],
  }
  return Option.match(trope.root, {
    onNone: () => settled,
    onSome: (root) => withRoot(modules, book, settled, trope.name, root),
  })
}

export const declaredKindsOf = (
  modules: ReadonlyMap<Location, LoomModule>,
  book: Book,
): DeclaredKinds => {
  const tropes = tropesOf(modules)
  return Array.reduce(tropes, { ...noKinds, tropes }, (kinds, trope) =>
    withTrope(modules, book, kinds, trope),
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
  const misplaced = pipe(
    kinds.misplaced,
    Array.filter((manifest) => manifest.module === module.path),
    Array.flatMap(
      (manifest) => faulty(ManifestOffRoot({ trope: manifest.trope }), manifest.at).diagnostics,
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
  return [...refused, ...misplaced, ...unknown, ...keysOutsideTrope(module)]
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
