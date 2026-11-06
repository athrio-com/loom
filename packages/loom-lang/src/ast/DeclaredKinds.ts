import { Array, Match, Option, Order, pipe, Result } from 'effect'
import type { Diagnostic, Position } from '@athrio/loom-ast/LoomNode'
import type { LoomSection } from '@athrio/loom-ast/LoomAst'
import {
  boxKind,
  boxKinds,
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
import { faulty, KeyOutsideTrope, TropeRefused, UnknownKind } from './LoomFault'
import { type BoxKindDeclaration, readManifest, type TropeManifest } from './TropeManifest'

export type TropeRoot = {
  readonly trope: string
  readonly module: Location
  readonly title: string
}

export type DeclaredKind = {
  readonly kind: string
  readonly body: string
  readonly trope: string
  readonly module: Location
}

export type Refusal = { readonly module: Location; readonly reason: string; readonly at: Position }

export type DeclaredKinds = {
  readonly roots: ReadonlyArray<TropeRoot>
  readonly box: ReadonlyArray<DeclaredKind>
  readonly refusals: ReadonlyArray<Refusal>
}

const noKinds: DeclaredKinds = { roots: [], box: [], refusals: [] }

type Root = {
  readonly module: LoomModule
  readonly manifests: Array.NonEmptyReadonlyArray<LoomSection>
}

const tropeOf = (module: LoomModule): string => module.doc.frontmatter?.trope?.value ?? ''

const manifestSectionsOf = (module: LoomModule): ReadonlyArray<LoomSection> =>
  Array.filter(module.doc.sections, (section) =>
    Option.exists(Option.fromNullishOr(section.heading.specifier), isManifest),
  )

const rootsOf = (modules: ReadonlyMap<Location, LoomModule>): ReadonlyArray<Root> =>
  pipe(
    Array.fromIterable(modules.values()),
    Array.filter((module) => module.doc.frontmatter?.trope !== undefined),
    Array.sort(Order.mapInput(Order.String, (module: LoomModule) => module.path)),
    Array.flatMap((module): ReadonlyArray<Root> => {
      const manifests = manifestSectionsOf(module)
      return Array.isReadonlyArrayNonEmpty(manifests) ? [{ module, manifests }] : []
    }),
  )

type Read = { readonly manifest: TropeManifest; readonly at: Position }

const manifestOf = (
  modules: ReadonlyMap<Location, LoomModule>,
  book: Book,
  root: Root,
): Result.Result<Read, Refusal> => {
  const [section, ...others] = root.manifests
  const refusal = (reason: string, at: Position): Refusal => ({
    module: root.module.path,
    reason,
    at,
  })
  return Array.match(others, {
    onNonEmpty: ([second]) =>
      Result.fail(refusal('it holds more than one manifest', second.heading.position)),
    onEmpty: () =>
      pipe(
        Array.findFirst(
          root.module.product.code,
          (code) => code.origin.name === sectionNameOf(section),
        ),
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

const rootOf = (root: Root): TropeRoot => ({
  trope: tropeOf(root.module),
  module: root.module.path,
  title: root.module.doc.frontmatter?.title?.value ?? root.module.path,
})

const tropeLineOf = (module: LoomModule): Position =>
  Option.getOrElse(
    Option.map(Option.fromNullishOr(module.doc.frontmatter?.trope), (line) => line.position),
    () => module.doc.position,
  )

const kindsOf = (root: Root, manifest: TropeManifest): ReadonlyArray<DeclaredKind> =>
  Array.map(manifest.contributes.kinds.box, (declaration): DeclaredKind => ({
    kind: declaration.kind,
    body: declaration.body,
    trope: tropeOf(root.module),
    module: root.module.path,
  }))

const refused = (kinds: DeclaredKinds, refusal: Refusal): DeclaredKinds => ({
  ...kinds,
  refusals: [...kinds.refusals, refusal],
})

const withRoot = (
  modules: ReadonlyMap<Location, LoomModule>,
  book: Book,
  kinds: DeclaredKinds,
  root: Root,
): DeclaredKinds =>
  Result.match(manifestOf(modules, book, root), {
    onFailure: (refusal) => refused(kinds, refusal),
    onSuccess: ({ manifest, at }) =>
      Option.match(clashOf(manifest.contributes.kinds.box, kinds.box), {
        onSome: (reason) => refused(kinds, { module: root.module.path, reason, at }),
        onNone: () => ({ ...kinds, box: [...kinds.box, ...kindsOf(root, manifest)] }),
      }),
  })

export const declaredKindsOf = (
  modules: ReadonlyMap<Location, LoomModule>,
  book: Book,
): DeclaredKinds =>
  Array.reduce(rootsOf(modules), noKinds, (kinds, root): DeclaredKinds =>
    Option.match(
      Array.findFirst(kinds.roots, (other) => other.trope === tropeOf(root.module)),
      {
        onSome: (other) =>
          refused(kinds, {
            module: root.module.path,
            reason: `the trope \`${other.trope}\` already has its root in the chapter \`${other.title}\``,
            at: tropeLineOf(root.module),
          }),
        onNone: () =>
          withRoot(modules, book, { ...kinds, roots: [...kinds.roots, rootOf(root)] }, root),
      },
    ),
  )

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
