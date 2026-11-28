import type { CodeMapping, VirtualCode } from '@volar/language-core'
import { Array, Context, Data, Effect, Layer, Match, Option, pipe, Record, Ref } from 'effect'
import { memoize } from 'effect/Function'
import { isAbsolute, join, sep } from 'node:path'
import type * as ts from 'typescript'
import { type Diagnostic, type Health, type Position, byType } from '@athrio/loom-ast/LoomNode'
import type { LoomFrontmatter, LoomSection } from '@athrio/loom-ast/LoomAst'
import { type LoomWeft } from '@athrio/loom-ast/Weft'
import {
  LoomCorpusAstBuilder,
  type ParsedLoom,
  type ReadError,
  type Source,
} from '#ast/LoomCorpusAstBuilder'
import {
  catalogueOf,
  type Catalogue,
  anchorTrails,
  bookTwinsOf,
  BoxNotice,
  boxNoticesIn,
  captionOf,
  openedBoxesOf,
  type OpenedBox,
  corpusErrors,
  definitionAt,
  dependentsOf,
  conceptRenameAt,
  conceptSymbolsIn,
  hintsAt,
  hoverAt,
  type CorpusHover,
  isTropeEntry,
  bearerAt,
  keyAt,
  linksOf,
  moduleDiagnostics,
  namesakesOf,
  reachable,
  referencesAt,
  referencesOf,
  referenceTrails,
  renameAt,
  renameRangeAt,
  navigationRangeAt,
  pathsTo,
  refreshedSummaries,
  syncedSummaries,
  transitiveDependents,
  unopenedBookOf,
  type CorpusLocation,
  type LoomModule,
  type Location,
} from '@athrio/loom-ast/LoomCorpusAst'
import {
  AmbiguousAnchor,
  DuplicateName,
  faultAt,
  faulty,
  MissingSymbol,
  SpecifierUnknown,
  StaleSummary,
  UnopenedBook,
  UnresolvedReference,
  UnservedLanguage,
  UnresolvedLink,
  UnwrittenLoom,
  UnsettledTrope,
  UnsettledModule,
  UnsettledSection,
} from '#ast/LoomFault'
import { broke, describe, lineOf } from '#ast/LoomFailure'
import {
  compositionCycles,
  crossFileFaults,
  extensionLanguage,
  holdsModuleRefs,
  type Landing,
  landingOf,
  ModuleFile,
  moduleFileOf,
  singleFile,
  unusedSections,
  usedSections,
} from '#ast/ProductBuilder'
import {
  eachType,
  headingLangToken,
  type Keys,
  keyType,
  type ScalarType,
} from '@athrio/loom-ast/LoomTokens'
import { type Code, keyOf, type Part } from '@athrio/loom-ast/ProductAst'
import {
  type ComposedFile,
  type FrameCompletion,
  type FrameContract,
  type FrameBox,
  type FrameEdit,
  type FrameApproval,
  type FrameFix,
  type FrameHint,
  type FrameHover,
  type FrameLocation,
  type FrameMove,
  type FrameSymbol,
  type FrameToken,
  type PromisedName,
  type ServiceError,
  type SpecifierRequest,
} from '@athrio/loom-lang-services/LanguageService'
import { type BraceSlot, normaliseTitle, slotAt, type Wanted } from '#ast/WeftTokeniser'
import {
  type Declarations,
  type DeclaredKinds,
  declaredKindsOf,
  keyCard,
  kindFaults,
  noDeclarations,
  tropeIn,
  tropeOf,
  tropesOf,
} from '#ast/DeclaredKinds'
import {
  type Declared,
  type KeyedKind,
  namedKind,
  nothingDeclared,
  type Taken,
  takenBy,
} from '#ast/LoomDocumentBuilder'
import {
  type Approval,
  approvalsAt,
  approvedRelations,
  chosenRelations,
  driftFaults,
  type KeptRelation,
  type Relation,
  relationsOf,
} from '#ast/Relations'
import { TropePackages } from './TropePackages'
import { boundariesOf, boundaryFaults } from '#ast/TropeBoundaries'
import {
  type ConceptFix,
  conceptReferencesAt,
  linksAt,
  movesAt,
  recognisedDefinitionAt,
  recognisedHoverAt,
  recognisedRangeAt,
  vocabulariesIn,
} from '#ast/ConceptScope'
import {
  contractsIn,
  fromCode,
  fromProduct,
  noSpecifiers,
  type HeldModuleRef,
  moduleRefsIn,
  type Specifiers,
  type Unsettled,
  unsettledIn,
  fromProse,
  rootNamesAt,
  rootVirtualCode,
  symbolMappings,
} from '#ast/LoomVirtualCodeBuilder'
import { type LoomVirtualCode, type Mapping } from '@athrio/loom-ast/LoomVirtualCode'
import { profileOf, symbolsOf } from '@athrio/loom-ast/LoomSymbol'
import { LoomMemo } from './LoomMemo'
import { type Built, declaredKey, LoomDiskCache } from './LoomDiskCache'
import { type BuildSettings, WorkspaceSettings } from './WorkspaceSettings'
import {
  type PlaceOf,
  type RelationsNotKept,
  type StorageTakesNoWrite,
  WorkspaceSource,
} from './WorkspaceSource'
import { LanguagePackages } from './LanguagePackages'
import { buildContents, type TableOfContents } from './weave/TableOfContentsBuilder'
import { WeaveBuilder } from './weave/WeaveBuilder'
import { type WovenCorpus } from './weave/WovenCorpus'

type Modules = ReadonlyMap<Location, LoomModule>

const scopedTo = (modules: Modules, paths: ReadonlyArray<Location>): Modules => {
  const keep = new Set(paths)
  return new Map(Array.fromIterable(modules).filter(([p]) => keep.has(p)))
}

type Corpus = { readonly modules: Modules; readonly kinds: DeclaredKinds }

type KeptCorpus = {
  readonly held: Modules
  readonly installed: Declarations
  readonly corpus: Corpus
}

const sameModules = (one: Modules, other: Modules): boolean =>
  one.size === other.size &&
  Array.zip(Array.fromIterable(one), Array.fromIterable(other)).every(
    ([[path, module], [otherPath, otherModule]]) => path === otherPath && module === otherModule,
  )

const without = (modules: Modules, paths: ReadonlyArray<Location>): Modules => {
  const drop = new Set(paths)
  return new Map(Array.fromIterable(modules).filter(([p]) => !drop.has(p)))
}

const inTrope = (module: LoomModule): boolean => Option.isSome(tropeOf(module))

type Waiting = { readonly loom: ParsedLoom; readonly settings: BuildSettings }

const wasBuiltWith =
  (wanted: Option.Option<Declared>) =>
  (kept: Built): boolean =>
    Option.match(wanted, {
      onNone: () => true,
      onSome: (declared) => kept.builtAs === declaredKey(declared),
    })

const keyedKind = (declared: {
  readonly kind: string
  readonly parameters: Keys
}): KeyedKind => ({ kind: declared.kind, parameters: declared.parameters })

const declaredIn = (kinds: DeclaredKinds): Declared => ({
  section: kinds.section.map((each) => ({ ...keyedKind(each), codeless: each.codeless })),
  anchor: kinds.anchor.map((each) => ({ ...keyedKind(each), standsIn: each.standsIn })),
  box: kinds.box.map(keyedKind),
  loom: kinds.loom.map((each) => ({
    kind: each.kind,
    numbered: each.numbered,
    zone: each.zone,
    codeless: each.codeless,
    holds: each.holds,
  })),
  headings: Object.fromEntries(kinds.headings.map((each) => [each.key, each.type] as const)),
})

const entryOf = (
  modules: Modules,
  path: Location,
): Effect.Effect<{ readonly modules: Modules; readonly entry: LoomModule }> =>
  Effect.fromNullishOr(modules.get(path)).pipe(
    Effect.orDie,
    Effect.map((entry) => ({ modules, entry })),
  )

const loomName = (loom: Location): string => loom.slice(loom.lastIndexOf('/') + 1)

const namesakeFaults = (catalogue: Catalogue, module: LoomModule): ReadonlyArray<Diagnostic> =>
  Option.match(namesakesOf(catalogue, module), {
    onNone: (): ReadonlyArray<Diagnostic> => [],
    onSome: ({ title, looms }) =>
      faulty(
        DuplicateName({
          name: title.source,
          sibling: 'chapter',
          where: looms.map(loomName).join(', '),
        }),
        title.position,
      ).diagnostics,
  })

const linkFaults = (catalogue: Catalogue, module: LoomModule): ReadonlyArray<Diagnostic> =>
  linksOf(module).flatMap((link) => {
    const trails = anchorTrails(catalogue, module.path, link)
    return Array.match(trails, {
      onEmpty: () =>
        faulty(UnresolvedLink({ name: link.name.value }), link.name.position).diagnostics,
      onNonEmpty: (all) =>
        all.length === 1
          ? []
          : faulty(
              AmbiguousAnchor({
                name: link.name.value,
                count: all.length,
                paths: pathsTo(catalogue, module.path, all),
              }),
              link.name.position,
            ).diagnostics,
    })
  })

const referenceFaults = (catalogue: Catalogue, module: LoomModule): ReadonlyArray<Diagnostic> =>
  referencesOf(module)
    .filter((held) => !isTropeEntry(held))
    .flatMap((held) =>
      Array.match(referenceTrails(catalogue, module.path, held), {
        onEmpty: () =>
          faulty(
            UnresolvedReference({ key: held.key, name: held.value.value }),
            held.value.position,
          ).diagnostics,
        onNonEmpty: (all) =>
          all.length === 1
            ? []
            : faulty(
                AmbiguousAnchor({
                  name: held.value.value,
                  count: all.length,
                  paths: pathsTo(catalogue, module.path, all),
                }),
                held.value.position,
              ).diagnostics,
      }),
    )

const bookFaults = (catalogue: Catalogue, module: LoomModule): ReadonlyArray<Diagnostic> => [
  ...Option.match(bookTwinsOf(catalogue, module), {
    onNone: (): ReadonlyArray<Diagnostic> => [],
    onSome: ({ title, looms }) =>
      faulty(
        DuplicateName({
          name: title.source,
          sibling: 'book',
          where: looms.map(loomName).join(', '),
        }),
        title.position,
      ).diagnostics,
  }),
  ...Option.match(unopenedBookOf(catalogue, module), {
    onNone: (): ReadonlyArray<Diagnostic> => [],
    onSome: (line) => faulty(UnopenedBook({ name: line.value }), line.position).diagnostics,
  }),
]

type NamedLanguage = { readonly language: string; readonly position: Position }

type Wording = { readonly value: string; readonly position: Position }

const ownLanguages: ReadonlyArray<string> = ['loom', 'prose', 'plaintext']

const namedLanguage = (written: Wording): NamedLanguage => ({
  language: written.value.trim().toLowerCase(),
  position: written.position,
})

const fileLanguage = (file: Wording): NamedLanguage => ({
  language: extensionLanguage(file.value),
  position: file.position,
})

const sectionLanguageAt = (section: LoomSection): Option.Option<NamedLanguage> =>
  pipe(
    Option.fromNullishOr(section.heading.specifier),
    Option.flatMap(headingLangToken),
    Option.map(namedLanguage),
    Option.orElse(() =>
      Option.map(Option.fromNullishOr(section.heading.sink), (sink) => fileLanguage(sink.file)),
    ),
  )

const namedLanguages = (module: LoomModule): ReadonlyArray<NamedLanguage> =>
  pipe(
    [
      Option.map(Option.fromNullishOr(module.doc.frontmatter?.language), namedLanguage),
      Option.flatMap(Option.fromNullishOr(module.doc.frontmatter?.package), (named) =>
        Option.map(singleFile(Option.some(named.value)), () => fileLanguage(named)),
      ),
      ...module.doc.sections.map(sectionLanguageAt),
    ],
    Array.getSomes,
    Array.dedupeWith((one, other) => one.language === other.language),
  )

const languageFaults = (
  served: Option.Option<ReadonlyArray<string>>,
  module: LoomModule,
): ReadonlyArray<Diagnostic> =>
  Option.match(served, {
    onNone: (): ReadonlyArray<Diagnostic> => [],
    onSome: (languages) => {
      const servedHere = [...ownLanguages, ...languages]
      return namedLanguages(module)
        .filter(({ language }) => !Array.contains(servedHere, language))
        .flatMap(
          ({ language, position }) => faulty(UnservedLanguage({ language }), position).diagnostics,
        )
    },
  })

const boxNoticeHealth = (notice: BoxNotice): Health =>
  BoxNotice.$match(notice, {
    Unwritten: ({ name, kind, opening }) =>
      faulty(UnwrittenLoom({ kind, name: name.value, opening }), name.position),
    Unsettled: ({ name, target }) =>
      faulty(
        UnsettledTrope({
          name: name.value,
          ...Option.match(target, { onNone: () => ({}), onSome: (named) => ({ target: named }) }),
        }),
        name.position,
      ),
    Stale: ({ name, of, title, summary, body }) =>
      faulty(StaleSummary({ of, name: title, summary, at: body }), name.position),
  })

const corpusDiagnostics = (
  modules: Modules,
  kinds: DeclaredKinds,
  relations: ReadonlyArray<KeptRelation>,
  served: Option.Option<ReadonlyArray<string>>,
) => {
  const catalogue = catalogueOf(modules)
  const landing = landingOf(modules)
  const boundaries = boundariesOf(modules, catalogue, tropesOf(modules))
  const used = usedSections(modules)
  return (module: LoomModule): ReadonlyArray<Diagnostic> => [
    ...moduleDiagnostics(module),
    ...crossFileFaults(catalogue, modules, module, landing),
    ...compositionCycles(catalogue, modules, module),
    ...unusedSections(used, module),
    ...namesakeFaults(catalogue, module),
    ...bookFaults(catalogue, module),
    ...linkFaults(catalogue, module),
    ...referenceFaults(catalogue, module),
    ...kindFaults(kinds, module),
    ...driftFaults(catalogue, module, relations),
    ...languageFaults(served, module),
    ...boundaryFaults(boundaries, catalogue, modules, module),
    ...boxNoticesIn({ modules }, module).flatMap((notice) => boxNoticeHealth(notice).diagnostics),
  ]
}

const tangleFaults: (corpus: Corpus) => (module: LoomModule) => ReadonlyArray<Diagnostic> = memoize(
  (corpus: Corpus) => memoize(corpusDiagnostics(corpus.modules, corpus.kinds, [], Option.none())),
)

export interface TangledFile {
  readonly section: string
  readonly path: Location
  readonly content: string
}

interface Resolved {
  readonly files: ReadonlyArray<TangledFile>
  readonly unwritten: ReadonlyArray<Unwritten>
}

const resolveSinks = (
  modules: Modules,
  entry: Location,
  placesOf: (looms: ReadonlyArray<Location>) => Effect.Effect<PlaceOf>,
  written: WrittenFor,
): Effect.Effect<Resolved> =>
  pipe(
    Option.fromNullishOr(modules.get(entry)),
    Option.match({
      onNone: () => Effect.succeed<Resolved>({ files: [], unwritten: [] }),
      onSome: (module) => {
        const catalogue = catalogueOf(modules)
        const landing = landingOf(modules)
        return placesOf([entry]).pipe(
          Effect.flatMap((placeOf) =>
            Effect.forEach(module.product.files, (file) => {
              const path = placeOf(entry, file.path)
              return written(modules, catalogue, landing, file.code, path).pipe(
                Effect.map((paths) => ({
                  file: {
                    section: file.code.origin.name,
                    path,
                    content: fromCode(modules, file.code, catalogue, specifiersOf(paths)).code,
                  },
                  unwritten: paths.unwritten,
                })),
              )
            }),
          ),
        ).pipe(
          Effect.map((each) => ({
            files: each.map((one) => one.file),
            unwritten: each.flatMap((one) => one.unwritten),
          })),
        )
      },
    }),
  )

const unsettledFailures = (
  modules: Modules,
  entry: Location,
): ReadonlyArray<{ readonly path: Location; readonly diagnostics: ReadonlyArray<Diagnostic> }> => {
  const catalogue = catalogueOf(modules)
  return pipe(
    Option.fromNullishOr(modules.get(entry)),
    Option.match({
      onNone: (): ReadonlyArray<Unsettled> => [],
      onSome: (module) =>
        module.product.files.flatMap((file) => unsettledIn(modules, file.code, catalogue)),
    }),
    Array.dedupeWith(
      (one, other) =>
        one.path === other.path && one.anchor.start.offset === other.anchor.start.offset,
    ),
    Array.groupBy((unsettled) => unsettled.path),
    Record.toEntries,
    Array.map(([path, unsettled]) => ({
      path,
      diagnostics: unsettled.flatMap(
        (one) =>
          faulty(
            one.moduleAnchor
              ? UnsettledModule({ name: one.name, declared: one.declared })
              : UnsettledSection({ name: one.name, declared: one.declared }),
            one.anchor,
          ).diagnostics,
      ),
    })),
  )
}

export class TangleError extends Data.TaggedError('TangleError')<{
  readonly entry: Location
  readonly failures: ReadonlyArray<{
    readonly path: Location
    readonly diagnostics: ReadonlyArray<Diagnostic>
  }>
}> {}

interface Unwritten {
  readonly path: Location
  readonly diagnostic: Diagnostic
}

interface Written {
  readonly specifiers: ReadonlyMap<string, string>
  readonly unwritten: ReadonlyArray<Unwritten>
}

type WrittenFor = (
  modules: Modules,
  catalogue: Catalogue,
  landing: Landing,
  root: Code,
  from: Location,
) => Effect.Effect<Written>

const nothingWritten: Written = { specifiers: new Map(), unwritten: [] }

const specifierKey = (owner: Location, at: Position): string => `${owner}#${at.start.offset}`

const writtenOf = (held: HeldModuleRef, text: string): Written => ({
  specifiers: new Map([[specifierKey(held.owner, held.ref.anchor), text]]),
  unwritten: [],
})

const unwrittenOf = (held: HeldModuleRef, reason: string): Written => ({
  specifiers: new Map(),
  unwritten: [
    {
      path: held.owner,
      diagnostic: faultAt(
        SpecifierUnknown({ name: held.ref.name, language: held.host.languageId, reason }),
        held.ref.anchor,
      ),
    },
  ],
})

const mergeWritten = (one: Written, other: Written): Written => ({
  specifiers: new Map([...one.specifiers, ...other.specifiers]),
  unwritten: [...one.unwritten, ...other.unwritten],
})

const specifiersOf =
  (written: Written): Specifiers =>
  (owner, ref) =>
    Option.fromNullishOr(written.specifiers.get(specifierKey(owner, ref.anchor)))

const byLoom = (
  unwritten: ReadonlyArray<Unwritten>,
): ReadonlyArray<{ readonly path: Location; readonly diagnostics: ReadonlyArray<Diagnostic> }> =>
  pipe(
    unwritten,
    Array.groupBy((one) => one.path),
    Record.toEntries,
    Array.map(([path, each]) => ({ path, diagnostics: each.map((one) => one.diagnostic) })),
  )

export type SummaryEdit = {
  readonly path: Location
  readonly range: FrameLocation['range']
  readonly text: string
}

const lastLineOf = (opened: OpenedBox): LoomWeft =>
  Option.getOrElse(
    Option.orElse(opened.closer, () => Array.last(opened.body)),
    () => opened.opener,
  )

const lineStartsOf: (module: LoomModule) => ReadonlyArray<number> = memoize(
  (module: LoomModule) => [
    0,
    ...[...module.text.matchAll(/\n/g)].map((newline) => newline.index + 1),
  ],
)

const lineHolding = (
  starts: ReadonlyArray<number>,
  offset: number,
  first: number,
  last: number,
): number => {
  if (first >= last) return first
  const middle = Math.ceil((first + last) / 2)
  return (starts[middle] ?? Infinity) <= offset
    ? lineHolding(starts, offset, middle, last)
    : lineHolding(starts, offset, first, middle - 1)
}

const lineCharAt = (
  module: LoomModule,
  offset: number,
): { readonly line: number; readonly character: number } => {
  const starts = lineStartsOf(module)
  const line = lineHolding(starts, offset, 0, starts.length - 1)
  return { line, character: offset - (starts[line] ?? 0) }
}

const approvalTitle = (relation: Relation): string =>
  relation.status === 'drifted'
    ? `Approve \`${relation.to}\` as it stands now`
    : `Track changes to \`${relation.to}\``

const frameLocationOf = (
  modules: Modules,
  location: CorpusLocation,
): Option.Option<FrameLocation> =>
  Option.map(Option.fromNullishOr(modules.get(location.path)), (module) => ({
    path: location.path,
    range: {
      start: lineCharAt(module, location.position.start.offset),
      end: lineCharAt(module, location.position.end.offset),
    },
  }))

const frameFixOf = (modules: Modules, fix: ConceptFix): FrameFix => ({
  title: fix.title,
  edits: Array.getSomes(
    fix.edits.map((edit) =>
      Option.map(
        frameLocationOf(modules, { path: edit.path, position: edit.at }),
        (location): FrameEdit => ({ ...location, text: edit.text }),
      ),
    ),
  ),
})

const headingLocationOf = (modules: Modules, module: LoomModule, name: string): FrameLocation =>
  pipe(
    Array.findFirst(
      module.doc.sections,
      (section) => normaliseTitle(section.heading.title?.source ?? '') === name,
    ),
    Option.flatMapNullishOr((section) => section.heading.title),
    Option.flatMap((title) =>
      frameLocationOf(modules, { path: module.path, position: title.position }),
    ),
    Option.getOrElse((): FrameLocation => ({
      path: module.path,
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
    })),
  )

export const within = (dir: Location, path: Location): boolean =>
  path.startsWith(isAbsolute(dir) ? join(dir, sep) : `${dir.replace(/\/+$/, '')}/`)

const tokenValue = (token: { readonly value: string } | undefined): string =>
  Option.getOrElse(
    Option.map(Option.fromNullishOr(token), (present) => present.value),
    () => '',
  )

const kindFaceOf = (frontmatter: LoomFrontmatter): { readonly value: string } | undefined =>
  Option.getOrUndefined(
    Option.map(Option.fromNullishOr(frontmatter.kind), (named) => ({
      value: `${named.value} ${named.number}`,
    })),
  )

const partFaceOf: (part: Part) => string = byType<Part>()({
  Fragment: (fragment) => fragment.text,
  NameRef: (ref) =>
    Option.match(ref.target, { onNone: () => ref.name, onSome: keyOf }),
  ModuleRef: (ref) =>
    `module ${Option.match(ref.target, { onNone: () => ref.name, onSome: keyOf })} ${Option.match(
      ref.file,
      { onNone: () => '', onSome: (file) => file.name },
    )}`,
})

const faceOf = (module: LoomModule): string =>
  JSON.stringify({
    frontmatter: Option.match(Option.fromNullishOr(module.doc.frontmatter), {
      onNone: () => [],
      onSome: (frontmatter) =>
        [
          frontmatter.part,
          frontmatter.partName,
          frontmatter.chapter,
          frontmatter.discussion,
          kindFaceOf(frontmatter),
          frontmatter.title,
          frontmatter.package,
          frontmatter.language,
        ].map(tokenValue),
    }),
    titles: module.doc.sections.map((section) =>
      Option.getOrElse(
        Option.map(Option.fromNullishOr(section.heading.title), (title) => title.source),
        () => '',
      ),
    ),
    code: module.product.code.map((code) => [
      code.origin.name,
      code.languageId,
      code.fragments.map(partFaceOf),
    ]),
    files: module.product.files.map((file) => [file.path, file.code.origin.name]),
  })

interface Composition {
  readonly modules: Modules
  readonly placed: ReadonlyMap<Location, ReadonlyArray<Location>>
  readonly files: ReadonlyMap<Location, ReadonlyArray<ComposedFile>>
}

const noComposition: Composition = { modules: new Map(), placed: new Map(), files: new Map() }

const composedFilesOf = (
  modules: Modules,
  catalogue: Catalogue,
  landing: Landing,
  module: LoomModule,
  paths: ReadonlyArray<Location>,
  written: WrittenFor,
): Effect.Effect<ReadonlyArray<ComposedFile>> =>
  Effect.forEach(Array.zip(module.product.files, paths), ([file, path]) =>
    written(modules, catalogue, landing, file.code, path).pipe(
      Effect.map((specifiers): ComposedFile => ({
        path,
        content: fromCode(modules, file.code, catalogue, specifiersOf(specifiers)).code,
        loomPath: module.path,
        rootId: file.code.origin.name.toLowerCase(),
        heading: headingLocationOf(modules, module, file.code.origin.name),
      })),
    ),
  )

const samePlaces = (
  before: ReadonlyArray<Location> | undefined,
  after: ReadonlyArray<Location> | undefined,
): boolean =>
  Option.match(Option.all([Option.fromNullishOr(before), Option.fromNullishOr(after)]), {
    onNone: () => before === after,
    onSome: ([was, now]) => was.length === now.length && was.every((path, i) => path === now[i]),
  })

const changedSince = (
  previous: Composition,
  modules: Modules,
  placed: ReadonlyMap<Location, ReadonlyArray<Location>>,
): ReadonlyArray<Location> =>
  [
    ...previous.modules.keys(),
    ...Array.fromIterable(modules.keys()).filter((path) => !previous.modules.has(path)),
  ].filter(
    (path) =>
      previous.modules.get(path) !== modules.get(path) ||
      !samePlaces(previous.placed.get(path), placed.get(path)),
  )

const staleSince = (
  previous: Composition,
  modules: Modules,
  placed: ReadonlyMap<Location, ReadonlyArray<Location>>,
): ReadonlySet<Location> => {
  const changed = changedSince(previous, modules, placed)
  return changed.length === 0
    ? new Set()
    : new Set([
        ...changed,
        ...dependentsOf(previous.modules, changed),
        ...dependentsOf(modules, changed),
      ])
}

const recompose = (
  previous: Composition,
  modules: Modules,
  placed: ReadonlyMap<Location, ReadonlyArray<Location>>,
  written: WrittenFor,
): Effect.Effect<Composition> => {
  const stale = staleSince(previous, modules, placed)
  if (stale.size === 0) return Effect.succeed({ ...previous, modules, placed })
  const catalogue = catalogueOf(modules)
  const landing = landingOf(modules)
  return Effect.forEach(Array.fromIterable(modules.values()), (module) =>
    pipe(
      Option.fromNullishOr(previous.files.get(module.path)),
      Option.filter(() => !stale.has(module.path)),
      Option.match({
        onSome: (kept) => Effect.succeed([module.path, kept] as const),
        onNone: () =>
          composedFilesOf(
            modules,
            catalogue,
            landing,
            module,
            placed.get(module.path) ?? [],
            written,
          ).pipe(Effect.map((files) => [module.path, files] as const)),
      }),
    ),
  ).pipe(Effect.map((pairs) => ({ modules, placed, files: new Map(pairs) })))
}

const composedFiles = (composition: Composition): ReadonlyArray<ComposedFile> =>
  Array.fromIterable(composition.files.values()).flat()

const promisedNamesIn = (
  modules: Modules,
  path: Location,
  rootId: string,
): ReadonlyArray<PromisedName> =>
  pipe(
    Option.fromNullishOr(modules.get(path)),
    Option.flatMap((module) =>
      Array.findFirst(module.product.code, (code) => code.origin.name.toLowerCase() === rootId),
    ),
    Option.match({
      onNone: (): ReadonlyArray<PromisedName> => [],
      onSome: (root) =>
        Array.dedupeWith(
          unsettledIn(modules, root).flatMap((unsettled) =>
            unsettled.provides.map((provided): PromisedName => ({
              name: provided.name,
              section: unsettled.name,
            })),
          ),
          (one, other) => one.name === other.name && one.section === other.section,
        ),
    }),
  )

type Offer = { readonly label: string; readonly text: string }

const choicesOf: (type: ScalarType) => ReadonlyArray<string> = Match.type<ScalarType>().pipe(
  Match.withReturnType<ReadonlyArray<string>>(),
  Match.when({ choice: Match.any }, ({ choice }) => choice),
  Match.when('boolean', () => ['true', 'false']),
  Match.orElse(() => []),
)

const wordsUnder = (taken: Taken, key: string): ReadonlyArray<string> =>
  key === 'kind'
    ? taken.kinds
    : Option.match(keyType(taken.keys, key), {
        onNone: (): ReadonlyArray<string> => [],
        onSome: (type) => choicesOf(eachType(type)),
      })

const keyOffer = (key: string): Offer => ({ label: key, text: `${key}=` })

const standsBare = (word: string): boolean => /^[A-Za-z0-9_.-]+$/.test(word)

const offersIn = byType<Wanted, [taken: Taken, slot: BraceSlot]>()<ReadonlyArray<Offer>>({
  label: (_wanted, taken, slot) => [
    ...taken.kinds.map((kind): Offer => ({ label: kind, text: slot.closed ? kind : `${kind}}` })),
    ...Object.keys(taken.keys).map(keyOffer),
  ],
  key: ({ written }, taken) =>
    Object.keys(taken.keys)
      .filter((key) => !written.includes(key))
      .map(keyOffer),
  value: ({ key, quoted }, taken) =>
    wordsUnder(taken, key).map((word): Offer => ({
      label: word,
      text: quoted || standsBare(word) ? word : `"${word}"`,
    })),
})

const keyHoverAt = (
  { modules, kinds }: Corpus,
  path: Location,
  offset: number,
): Option.Option<CorpusHover> =>
  Option.flatMap(Option.fromNullishOr(modules.get(path)), (module) =>
    Option.flatMap(keyAt({ modules }, path, offset), ({ bearer, key }) =>
      Option.map(
        keyType(
          takenBy({ declared: declaredIn(kinds), document: module.doc }, bearer).keys,
          key.value,
        ),
        (type): CorpusHover => ({
          position: key.position,
          markdown: keyCard(kinds, bearer.on, namedKind(bearer), key.value, type),
        }),
      ),
    ),
  )

const namesAt = (modules: Modules, path: Location): ReadonlyArray<string> =>
  pipe(
    Option.fromNullishOr(modules.get(path)),
    Option.match({
      onNone: () => [],
      onSome: (module) => module.product.code.map((c) => c.origin.name),
    }),
  )

const rootsAt = (modules: Modules, path: Location): ReadonlyArray<string> => {
  const roots = rootNamesAt(modules, path)
  return namesAt(modules, path).filter((name) => roots.has(name.toLowerCase()))
}

const projectTree = (
  modules: Modules,
  entry: LoomModule,
  specifiers: ReadonlyMap<string, Specifiers>,
): LoomVirtualCode => {
  const catalogue = catalogueOf(modules)
  return rootVirtualCode(
    entry.text,
    [
      fromProse(modules, entry.path),
      ...rootsAt(modules, entry.path).map((name) =>
        fromProduct(
          modules,
          { path: entry.path, name },
          catalogue,
          Option.getOrElse(Option.fromNullishOr(specifiers.get(name)), () => noSpecifiers),
        ),
      ),
    ],
    symbolMappings(entry.doc),
  )
}

export const stringSnapshot = (text: string): ts.IScriptSnapshot => ({
  getText: (start, end) => text.slice(start, end),
  getLength: () => text.length,
  getChangeRange: () => undefined,
})

const productFeatures: CodeMapping['data'] = {
  verification: true,
  completion: true,
  semantic: true,
  navigation: true,
  structure: true,
}

const featuresOf: (kind: Mapping['kind']) => CodeMapping['data'] = Match.type<
  Mapping['kind']
>().pipe(
  Match.when('source', () => ({
    verification: true,
    format: true,
    semantic: { shouldHighlight: () => false },
    completion: true,
    structure: true,
  })),
  Match.when('product', () => productFeatures),
  Match.when(Match.defined, (symbol) => profileOf(symbol).features),
  Match.orElse(() => productFeatures),
)

const toCodeMapping = (m: Mapping): CodeMapping => ({
  sourceOffsets: [m.source.start.offset],
  generatedOffsets: [m.genStart],
  lengths: [m.source.end.offset - m.source.start.offset],
  generatedLengths: [m.genLength],
  data: featuresOf(m.kind),
})

export const toVolar = (vc: LoomVirtualCode): VirtualCode => ({
  id: vc.id,
  languageId: vc.languageId,
  snapshot: stringSnapshot(vc.code),
  mappings: vc.mappings.map(toCodeMapping),
  embeddedCodes: vc.embeddedCodes.map(toVolar),
})

export class DocumentSource extends Context.Service<DocumentSource>()('DocumentSource', {
  make: Effect.gen(function* () {
    const source = yield* WorkspaceSource
    const held = yield* Ref.make<ReadonlyMap<Location, string>>(new Map())
    return {
      read: (path: Location): Effect.Effect<string, ReadError> =>
        Ref.get(held).pipe(
          Effect.flatMap((texts) =>
            Option.match(Option.fromNullishOr(texts.get(path)), {
              onNone: () => source.read(path),
              onSome: (text) => Effect.succeed(text),
            }),
          ),
        ),
      hold: (looms: ReadonlyMap<Location, string>): Effect.Effect<void> =>
        Ref.update(held, (texts) => new Map([...texts, ...looms])),
      forget: (loom: Location): Effect.Effect<void> =>
        Ref.update(held, (texts) => new Map([...texts].filter(([path]) => path !== loom))),
      list: Option.some((loom: Location): Effect.Effect<ReadonlyArray<Location>> => source.corpusOf(loom)),
    }
  }),
}) {
  static readonly layer = Layer.effect(this, this.make)
}

export type RangedEdit = {
  readonly path: Location
  readonly range: FrameLocation['range']
  readonly text: string
}

export type EditAnswer = {
  readonly made: ReadonlyArray<MadeLoom>
  readonly edits: ReadonlyArray<RangedEdit>
  readonly removed: ReadonlyArray<Location>
  readonly configuration: Option.Option<string>
}

const noCorpus: Corpus = { modules: new Map(), kinds: { ...noDeclarations, refusals: [] } }

const answerOf = (
  modules: Modules,
  edit: LoomEdit,
  configuration: Option.Option<string>,
): EditAnswer => ({
  made: edit.made,
  edits: Array.getSomes(
    edit.splices.map((splice) =>
      Option.map(Option.fromNullishOr(modules.get(splice.path)), (module) => ({
        path: splice.path,
        range: { start: lineCharAt(module, splice.start), end: lineCharAt(module, splice.end) },
        text: splice.text,
      })),
    ),
  ),
  removed: edit.gone,
  configuration,
})

const editedTexts = (modules: Modules, edit: LoomEdit): ReadonlyMap<Location, string> =>
  new Map([
    ...edit.made.map((made) => [made.path, made.text] as const),
    ...Object.entries(Array.groupBy(edit.splices, (splice) => splice.path)).map(
      ([path, splices]) =>
        [
          path,
          splicedText(
            Option.getOrElse(
              Option.map(Option.fromNullishOr(modules.get(path)), (module) => module.text),
              () => '',
            ),
            splices,
          ),
        ] as const,
    ),
  ])

const errorsOf = (
  judged: (module: LoomModule) => ReadonlyArray<Diagnostic>,
  module: LoomModule,
): ReadonlyArray<string> =>
  judged(module)
    .filter((diagnostic) => diagnostic.severity === 'error')
    .map((diagnostic) => diagnostic.message)

const brokenBy = (
  corpus: Corpus,
  edit: LoomEdit,
  rebuilt: ReadonlyArray<LoomModule>,
): Option.Option<EditBreaksLoom> => {
  const after: Modules = new Map([
    ...Array.fromIterable(corpus.modules).filter(([path]) => !Array.contains(edit.gone, path)),
    ...rebuilt.map((module) => [module.path, module] as const),
  ])
  const before = corpusDiagnostics(corpus.modules, corpus.kinds, [], Option.none())
  const now = corpusDiagnostics(after, corpus.kinds, [], Option.none())
  return Array.head(
    Array.getSomes(
      rebuilt.map((module) => {
        const added = problemsAdded(
          Option.match(Option.fromNullishOr(corpus.modules.get(module.path)), {
            onNone: (): ReadonlyArray<string> => [],
            onSome: (was) => errorsOf(before, was),
          }),
          errorsOf(now, module),
        )
        return added.length === 0
          ? Option.none()
          : Option.some(new EditBreaksLoom({ path: module.path, problems: added }))
      }),
    ),
  )
}

import {
  editedSettings,
  manifestFileOf,
  manifestText,
  type WorkspaceManifest,
} from '@athrio/loom-config/LoomConfig'

import {
  buildConcepts,
  buildOutline,
  buildTypes,
  type Concepts,
  NoSuchLoom,
  type Outline,
  type Types,
} from './OutlineBuilder'
import {
  buildEdit,
  EditBreaksLoom,
  type EditRefusal,
  type LoomEdit,
  type LoomIntent,
  type MadeLoom,
  problemsAdded,
  type Setting,
  splicedText,
} from './EditBuilder'

export class LoomCompiler extends Context.Service<LoomCompiler>()('LoomCompiler', {
  make: Effect.gen(function* () {
    const documents = yield* DocumentSource
    const workspaces = yield* WorkspaceSource
    const builder = yield* LoomCorpusAstBuilder
    const memo = yield* LoomMemo
    const disk = yield* LoomDiskCache
    const config = yield* WorkspaceSettings
    const weaver = yield* WeaveBuilder
    const composed = yield* Ref.make<Composition>(noComposition)
    const packages = yield* Effect.serviceOption(LanguagePackages)
    const tropes = yield* Effect.serviceOption(TropePackages)
    const coreChapters = yield* Ref.make<Modules>(new Map())
    const declaredFor = yield* Ref.make<ReadonlyMap<Location, Declared>>(new Map())
    const builtAs = yield* Ref.make<ReadonlyMap<Location, string>>(new Map())
    const keptCorpora = yield* Ref.make<ReadonlyMap<Location, KeptCorpus>>(new Map())
    const replaced = yield* Ref.make<ReadonlyMap<Location, Built>>(new Map())

    const installedKinds = (loom: Location): Effect.Effect<Declarations> =>
      Option.match(tropes, {
        onNone: () => Effect.succeed(noDeclarations),
        onSome: (installed) => installed.kindsFor(loom),
      })

    const servedFor = (loom: Location): Effect.Effect<Option.Option<ReadonlyArray<string>>> =>
      Option.match(packages, {
        onNone: () => Effect.succeed(Option.none<ReadonlyArray<string>>()),
        onSome: (held) => held.languagesFor(loom),
      })

    const specifierOf = (request: SpecifierRequest): Effect.Effect<Option.Option<string>, ServiceError> =>
      Option.match(packages, {
        onNone: () => Effect.succeed(Option.none<string>()),
        onSome: (held) => held.moduleSpecifier(request),
      })

    const writtenFor: WrittenFor = (modules, catalogue, landing, root, from) =>
      Effect.forEach(moduleRefsIn(modules, root, catalogue), (held) =>
        pipe(
          Option.fromNullishOr(modules.get(held.owner)),
          Option.map((module) =>
            moduleFileOf(catalogue, modules, landing, module, held.host, held.ref),
          ),
          Option.filter(ModuleFile.$is('Named')),
          Option.match({
            onNone: () => Effect.succeed(nothingWritten),
            onSome: ({ landed }) =>
              workspaces.placesOf([landed.loom]).pipe(
                Effect.flatMap((placeOf) =>
                  specifierOf({
                    language: held.host.languageId,
                    loom: held.owner,
                    from,
                    to: placeOf(landed.loom, landed.file.path),
                  }),
                ),
                Effect.map(
                  Option.match({
                    onNone: () => unwrittenOf(held, 'No package writes its paths.'),
                    onSome: (text) => writtenOf(held, text),
                  }),
                ),
                Effect.catchTag('ServiceError', (error) =>
                  Effect.succeed(unwrittenOf(held, error.reason)),
                ),
              ),
          }),
        ),
      ).pipe(Effect.map(Array.reduce(nothingWritten, mergeWritten)))

    const fileOfRoot = (entry: LoomModule, root: Code): Effect.Effect<Location> =>
      Option.match(
        Array.findFirst(entry.product.files, (file) => file.code.origin.name === root.origin.name),
        {
          onNone: () => Effect.succeed(`${entry.path}.${root.origin.name.toLowerCase()}`),
          onSome: (file) =>
            workspaces
              .placesOf([entry.path])
              .pipe(Effect.map((placeOf) => placeOf(entry.path, file.path))),
        },
      )

    const rootSpecifiers = (
      modules: Modules,
      entry: LoomModule,
    ): Effect.Effect<ReadonlyMap<string, Specifiers>> => {
      if (!holdsModuleRefs(modules)) return Effect.succeed(new Map())
      const catalogue = catalogueOf(modules)
      const landing = landingOf(modules)
      return Effect.forEach(entry.product.code, (root) =>
        fileOfRoot(entry, root).pipe(
          Effect.flatMap((from) => writtenFor(modules, catalogue, landing, root, from)),
          Effect.map((written) => [root.origin.name, specifiersOf(written)] as const),
        ),
      ).pipe(Effect.map((pairs) => new Map(pairs)))
    }

    const declaredOf = (path: Location): Effect.Effect<Declared> =>
      Ref.get(declaredFor).pipe(
        Effect.map((kept) =>
          Option.getOrElse(Option.fromNullishOr(kept.get(path)), () => nothingDeclared),
        ),
      )

    const remembered = (path: Location, load: Effect.Effect<Built>): Effect.Effect<LoomModule> =>
      memo.get(
        path,
        load.pipe(
          Effect.tap((built) =>
            Ref.update(builtAs, (was) => new Map(was).set(path, built.builtAs)),
          ),
          Effect.map((built) => built.module),
        ),
      )

    const finished =
      (settings: BuildSettings, declared: Declared) =>
      (loom: ParsedLoom): Effect.Effect<Built> =>
        builder.finish(loom, settings.primaryLanguage, settings.variables, declared).pipe(
          Effect.map((module): Built => ({ module, builtAs: declaredKey(declared) })),
          Effect.tap((built) => disk.keep(documents, settings, built)),
        )

    const loadOne = (source: Source, path: Location): Effect.Effect<LoomModule> =>
      Effect.all([config.resolve(path), Ref.get(declaredFor)]).pipe(
        Effect.flatMap(([settings, settled]) => {
          const wanted = Option.fromNullishOr(settled.get(path))
          return remembered(
            path,
            disk.recalled(source, path, settings).pipe(
              Effect.map(Option.filter(wasBuiltWith(wanted))),
              Effect.flatMap(
                Option.match({
                  onSome: (kept) => Effect.succeed(kept),
                  onNone: () =>
                    builder
                      .parse(source, path, settings.delims)
                      .pipe(
                        Effect.flatMap(
                          finished(settings, Option.getOrElse(wanted, () => nothingDeclared)),
                        ),
                      ),
                }),
              ),
            ),
          )
        }),
      )

    const evict = (paths: ReadonlyArray<Location>): Effect.Effect<void> =>
      memo.evict(paths).pipe(Effect.andThen(Ref.update(coreChapters, (kept) => without(kept, paths))))

    const noteReplaced = (module: LoomModule): Effect.Effect<void> =>
      Ref.get(builtAs).pipe(
        Effect.flatMap((built) =>
          Option.match(Option.fromNullishOr(built.get(module.path)), {
            onNone: () => Effect.void,
            onSome: (builtWith) =>
              Ref.update(replaced, (was) =>
                new Map(was).set(module.path, { module, builtAs: builtWith }),
              ),
          }),
        ),
      )

    const corpusPaths = (source: Source, entry: Location): Effect.Effect<ReadonlyArray<Location>> =>
      Option.match(source.list, {
        onNone: () => Effect.succeed<ReadonlyArray<Location>>([entry]),
        onSome: (list) =>
          list(entry).pipe(
            Effect.map((found) =>
              Array.dedupe(Array.contains(found, entry) ? found : [entry, ...found]),
            ),
          ),
      })

    const matchEntry = (source: Source, path: Location): Effect.Effect<void> =>
      Effect.all([Effect.option(source.read(path)), memo.entries]).pipe(
        Effect.flatMap(([text, modules]) =>
          pipe(
            Option.all([text, Option.fromNullishOr(modules.get(path))]),
            Option.filter(([shown, kept]) => kept.text !== shown),
            Option.match({
              onNone: () => Effect.void,
              onSome: ([, kept]) => noteReplaced(kept).pipe(Effect.andThen(evict([path]))),
            }),
          ),
        ),
      )

    const waitingAmong = (
      source: Source,
      paths: ReadonlyArray<Location>,
    ): Effect.Effect<ReadonlyArray<Waiting>> =>
      memo.entries.pipe(
        Effect.flatMap((held) =>
          Effect.forEach(
            paths.filter((path) => !held.has(path)),
            (path) =>
              config.resolve(path).pipe(
                Effect.flatMap((settings) =>
                  disk.recalled(source, path, settings).pipe(
                    Effect.flatMap(
                      Option.match({
                        onSome: (kept) =>
                          remembered(path, Effect.succeed(kept)).pipe(
                            Effect.as(Option.none<Waiting>()),
                          ),
                        onNone: () =>
                          builder
                            .parse(source, path, settings.delims)
                            .pipe(Effect.map((loom) => Option.some<Waiting>({ loom, settings }))),
                      }),
                    ),
                  ),
                ),
              ),
          ),
        ),
        Effect.map(Array.getSomes),
      )

    const heldAmong = (paths: ReadonlyArray<Location>): Effect.Effect<Modules> =>
      memo.entries.pipe(
        Effect.map(
          (held): Modules =>
            new Map(
              Array.getSomes(
                paths.map((path) =>
                  Option.map(
                    Option.fromNullishOr(held.get(path)),
                    (module) => [path, module] as const,
                  ),
                ),
              ),
            ),
        ),
      )

    const keptCore = (core: LoomModule): Effect.Effect<void> =>
      Ref.update(coreChapters, (was) => new Map(was).set(core.path, core))

    const coreChapterOf = (source: Source, chapter: LoomModule): Effect.Effect<LoomModule> =>
      Effect.all([Ref.get(coreChapters), Ref.get(builtAs), config.resolve(chapter.path)]).pipe(
        Effect.flatMap(([cores, built, settings]) =>
          Option.match(Option.fromNullishOr(cores.get(chapter.path)), {
            onSome: (core) => Effect.succeed(core),
            onNone: () =>
              (built.get(chapter.path) === declaredKey(nothingDeclared)
                ? Effect.succeed(chapter)
                : builder.build(
                    source,
                    chapter.path,
                    settings.delims,
                    settings.primaryLanguage,
                    settings.variables,
                  )
              ).pipe(Effect.tap(keptCore)),
          }),
        ),
      )

    const coreChapterFrom = ({ loom, settings }: Waiting): Effect.Effect<LoomModule> =>
      builder
        .finish(loom, settings.primaryLanguage, settings.variables)
        .pipe(Effect.tap(keptCore))

    const registryOf = (
      source: Source,
      modules: Modules,
      waiting: ReadonlyArray<Waiting>,
      entry: Location,
    ): Effect.Effect<DeclaredKinds> =>
      Effect.all([
        Effect.forEach(Array.fromIterable(modules.values()).filter(inTrope), (chapter) =>
          coreChapterOf(source, chapter),
        ),
        Effect.forEach(
          waiting.filter(({ loom }) => Option.isSome(tropeIn(loom.tree))),
          coreChapterFrom,
        ),
        installedKinds(entry),
      ]).pipe(
        Effect.map(([built, parsed, installed]) => {
          const core: Modules = new Map(
            [...built, ...parsed].map((chapter) => [chapter.path, chapter] as const),
          )
          return declaredKindsOf(core, installed)
        }),
      )

    const staleIn = (
      modules: Modules,
      declared: Declared,
    ): Effect.Effect<ReadonlyArray<Location>> =>
      Ref.get(builtAs).pipe(
        Effect.map((built) => {
          const now = declaredKey(declared)
          return Array.fromIterable(modules.keys()).filter((path) => built.get(path) !== now)
        }),
      )

    const settle = (paths: ReadonlyArray<Location>, declared: Declared): Effect.Effect<void> =>
      Ref.update(
        declaredFor,
        (was) => new Map([...was, ...paths.map((path) => [path, declared] as const)]),
      )

    const registered = (
      source: Source,
      entry: Location,
      paths: ReadonlyArray<Location>,
      modules: Modules,
      waiting: ReadonlyArray<Waiting>,
    ): Effect.Effect<Corpus> =>
      registryOf(source, modules, waiting, entry).pipe(
        Effect.flatMap((kinds) => {
          const declared = declaredIn(kinds)
          return settle(paths, declared).pipe(
            Effect.andThen(staleIn(modules, declared)),
            Effect.flatMap((stale) =>
              Array.isReadonlyArrayEmpty(stale) && Array.isReadonlyArrayEmpty(waiting)
                ? Effect.succeed<Corpus>({ modules, kinds })
                : memo.evict(stale).pipe(
                    Effect.andThen(Effect.forEach(stale, (path) => loadOne(source, path))),
                    Effect.andThen(
                      Effect.forEach(waiting, ({ loom, settings }) =>
                        remembered(loom.path, finished(settings, declared)(loom)),
                      ),
                    ),
                    Effect.andThen(heldAmong(paths)),
                    Effect.map((built): Corpus => ({ modules: built, kinds })),
                  ),
            ),
          )
        }),
      )

    const builtCorpus = (
      source: Source,
      entry: Location,
      installed: Declarations,
    ): Effect.Effect<Corpus> =>
      Effect.gen(function* () {
        const paths = yield* corpusPaths(source, entry)
        const waiting = yield* waitingAmong(source, paths)
        const modules = yield* heldAmong(paths)
        const notes = yield* Ref.get(keptCorpora)
        return yield* Option.match(
          Array.findFirst(
            Array.fromIterable(notes.values()),
            (note) =>
              Array.isReadonlyArrayEmpty(waiting) &&
              note.installed === installed &&
              sameModules(note.corpus.modules, modules),
          ),
          {
            onSome: (note) => Effect.succeed(note.corpus),
            onNone: () => registered(source, entry, paths, modules, waiting),
          },
        )
      })

    const kept = (entry: Location, installed: Declarations, corpus: Corpus): Effect.Effect<void> =>
      memo.entries.pipe(
        Effect.flatMap((held) =>
          Ref.update(
            keptCorpora,
            (notes) =>
              new Map([
                ...Array.fromIterable(notes).filter(([, note]) => note.held === held),
                [entry, { held, installed, corpus }] as const,
              ]),
          ),
        ),
      )

    const corpusOf = (source: Source, entry: Location): Effect.Effect<Corpus> =>
      Effect.all([memo.entries, installedKinds(entry), Ref.get(keptCorpora)]).pipe(
        Effect.flatMap(([held, installed, notes]) =>
          Option.match(
            Option.filter(
              Option.fromNullishOr(notes.get(entry)),
              (note) => note.held === held && note.installed === installed,
            ),
            {
              onSome: (note) => Effect.succeed(note.corpus),
              onNone: () =>
                builtCorpus(source, entry, installed).pipe(
                  Effect.tap((corpus) => kept(entry, installed, corpus)),
                ),
            },
          ),
        ),
      )

    const buildCorpus = (source: Source, entry: Location): Effect.Effect<Modules> =>
      corpusOf(source, entry).pipe(Effect.map((corpus) => corpus.modules))

    const settingsAfter = (
      workspace: Location,
      manifest: Option.Option<WorkspaceManifest>,
      setting: Option.Option<Setting>,
    ): Effect.Effect<Option.Option<string>> =>
      Option.match(Option.all({ manifest, setting }), {
        onNone: () => Effect.succeed(Option.none()),
        onSome: ({ manifest: held, setting: set }) =>
          documents.read(manifestFileOf(workspace)).pipe(
            Effect.orElseSucceed(() => manifestText(held)),
            Effect.map((text) => Option.some(editedSettings(text, set.path, set.value))),
          ),
      })

    const checkedEdit = (corpus: Corpus, edit: LoomEdit): Effect.Effect<void, EditBreaksLoom> => {
      const texts = editedTexts(corpus.modules, edit)
      const edited: Source = {
        read: (path) =>
          Effect.succeed(Option.getOrElse(Option.fromNullishOr(texts.get(path)), () => '')),
        list: Option.none(),
      }
      return Effect.forEach(Array.fromIterable(texts.keys()), (path) =>
        config
          .resolve(path)
          .pipe(
            Effect.flatMap((settings) =>
              builder.build(
                edited,
                path,
                settings.delims,
                settings.primaryLanguage,
                settings.variables,
                declaredIn(corpus.kinds),
              ),
            ),
          ),
      ).pipe(
        Effect.flatMap((rebuilt) =>
          Option.match(brokenBy(corpus, edit, rebuilt), {
            onNone: () => Effect.void,
            onSome: Effect.fail,
          }),
        ),
      )
    }

    return {
      compile: (source: Source, path: Location): Effect.Effect<VirtualCode> =>
        matchEntry(source, path).pipe(
          Effect.andThen(buildCorpus(source, path)),
          Effect.flatMap((modules) => entryOf(modules, path)),
          Effect.flatMap(({ modules, entry }) =>
            rootSpecifiers(modules, entry).pipe(
              Effect.map((specifiers) => toVolar(projectTree(modules, entry, specifiers))),
            ),
          ),
          Effect.catchCause((cause) =>
            Effect.logError(lineOf(describe(broke('projecting', path, cause))), cause).pipe(
              Effect.andThen(
                source.read(path).pipe(
                  Effect.orElseSucceed(() => ''),
                  Effect.map((text) => toVolar(rootVirtualCode(text, []))),
                ),
              ),
            ),
          ),
        ),

      tangle: (path: Location): Effect.Effect<ReadonlyArray<TangledFile>, TangleError> =>
        corpusOf(documents, path).pipe(
          Effect.flatMap((corpus) => {
            const { modules } = corpus
            const scoped = scopedTo(modules, reachable(modules, path))
            const failures = [
              ...corpusErrors({ modules: scoped }, tangleFaults(corpus)),
              ...unsettledFailures(modules, path),
            ]
            return failures.length > 0
              ? Effect.fail(new TangleError({ entry: path, failures }))
              : resolveSinks(modules, path, workspaces.placesOf, writtenFor).pipe(
                  Effect.flatMap(({ files, unwritten }) =>
                    Array.isReadonlyArrayNonEmpty(unwritten)
                      ? Effect.fail(new TangleError({ entry: path, failures: byLoom(unwritten) }))
                      : Effect.succeed(files),
                  ),
                )
          }),
        ),

      composition: (path: Location): Effect.Effect<ReadonlyArray<ComposedFile>> =>
        buildCorpus(documents, path).pipe(
          Effect.flatMap((modules) =>
            workspaces.placesOf(Array.fromIterable(modules.keys())).pipe(
              Effect.map(
                (placeOf): ReadonlyMap<Location, ReadonlyArray<Location>> =>
                  new Map(
                    Array.fromIterable(modules.values()).map(
                      (module) =>
                        [
                          module.path,
                          module.product.files.map((file) => placeOf(module.path, file.path)),
                        ] as const,
                    ),
                  ),
              ),
              Effect.flatMap((placed) =>
                Ref.get(composed).pipe(
                  Effect.flatMap((previous) => recompose(previous, modules, placed, writtenFor)),
                  Effect.tap((next) => Ref.set(composed, next)),
                  Effect.map(composedFiles),
                ),
              ),
            ),
          ),
        ),

      weave: (path: Location): Effect.Effect<WovenCorpus> =>
        buildCorpus(documents, path).pipe(
          Effect.flatMap((modules) => weaver.build({ modules }, path)),
        ),

      contents: (path: Location): Effect.Effect<TableOfContents> =>
        buildCorpus(documents, path).pipe(Effect.map((modules) => buildContents({ modules }))),

      outline: (path: Location): Effect.Effect<Outline, NoSuchLoom> =>
        documents.read(path).pipe(
          Effect.catchTag('ReadError', () => Effect.fail(new NoSuchLoom({ path }))),
          Effect.andThen(Effect.all([buildCorpus(documents, path), config.resolve(path)])),
          Effect.flatMap(([modules, settings]) =>
            Option.match(buildOutline({ modules }, path, settings.variables), {
              onNone: () => Effect.fail(new NoSuchLoom({ path })),
              onSome: (outline) => Effect.succeed(outline),
            }),
          ),
        ),

      concepts: (path: Location): Effect.Effect<Concepts> =>
        buildCorpus(documents, path).pipe(Effect.map((modules) => buildConcepts({ modules }))),

      types: (path: Location): Effect.Effect<Types> =>
        corpusOf(documents, path).pipe(Effect.map((corpus) => buildTypes(corpus.kinds))),

      edit: (
        workspace: Location,
        entry: Option.Option<Location>,
        intent: LoomIntent,
        locate: (uri: string) => Location,
      ): Effect.Effect<EditAnswer, EditRefusal | EditBreaksLoom | ReadError> =>
        Effect.all([
          Option.match(entry, {
            onNone: () => Effect.succeed(noCorpus),
            onSome: (loom) => corpusOf(documents, loom),
          }),
          config.manifest(workspace),
        ]).pipe(
          Effect.flatMap(([corpus, manifest]) =>
            Effect.fromResult(
              buildEdit(
                { corpus: { modules: corpus.modules }, workspace, manifest, locate },
                intent,
              ),
            ).pipe(
              Effect.tap((edit) => checkedEdit(corpus, edit)),
              Effect.flatMap((edit) =>
                settingsAfter(workspace, manifest, edit.configuration).pipe(
                  Effect.map((configuration) => answerOf(corpus.modules, edit, configuration)),
                ),
              ),
            ),
          ),
        ),

      summaries: (
        path: Location,
      ): Effect.Effect<ReadonlyArray<{ readonly path: Location; readonly text: string }>> =>
        buildCorpus(documents, path).pipe(Effect.map((modules) => refreshedSummaries({ modules }))),

      summaryEdits: (
        path: Location,
        before: string,
        after: string,
      ): Effect.Effect<ReadonlyArray<SummaryEdit>> =>
        Effect.all([
          config.resolve(path),
          buildCorpus(documents, path),
          declaredOf(path),
          Ref.get(replaced),
        ]).pipe(
          Effect.flatMap(([settings, modules, declared, earlier]) => {
            const builtFrom = (
              held: Option.Option<LoomModule>,
              text: string,
            ): Effect.Effect<LoomModule> =>
              Option.match(
                Option.filter(held, (module) => module.text === text),
                {
                  onSome: (module) => Effect.succeed(module),
                  onNone: () =>
                    builder.build(
                      { read: () => Effect.succeed(text), list: Option.none() },
                      path,
                      settings.delims,
                      settings.primaryLanguage,
                      settings.variables,
                      declared,
                    ),
                },
              )
            const edited = pipe(
              Option.fromNullishOr(earlier.get(path)),
              Option.filter(wasBuiltWith(Option.some(declared))),
              Option.map((kept) => kept.module),
            )
            const standing = Option.fromNullishOr(modules.get(path))
            return Effect.all([builtFrom(edited, before), builtFrom(standing, after)]).pipe(
              Effect.map(([was, now]) =>
                Array.getSomes(
                  syncedSummaries({ modules }, was, now).map((edit) =>
                    Option.map(
                      Option.fromNullishOr(modules.get(edit.path)),
                      (target): SummaryEdit => ({
                        path: edit.path,
                        range: {
                          start: lineCharAt(target, edit.at.start.offset),
                          end: lineCharAt(target, edit.at.end.offset),
                        },
                        text: edit.text,
                      }),
                    ),
                  ),
                ),
              ),
            )
          }),
        ),

      diagnose: (path: Location): Effect.Effect<ReadonlyArray<Diagnostic>> =>
        Effect.all([
          corpusOf(documents, path),
          workspaces.keptRelationsOf(path),
          servedFor(path),
        ]).pipe(
          Effect.map(([{ modules, kinds }, relations, served]) =>
            pipe(
              Option.fromNullishOr(modules.get(path)),
              Option.match({
                onNone: () => [],
                onSome: (module) => corpusDiagnostics(modules, kinds, relations, served)(module),
              }),
            ),
          ),
        ),

      approve: (
        path: Location,
        chosen: (relation: Relation) => boolean,
      ): Effect.Effect<ReadonlyArray<KeptRelation>, RelationsNotKept | StorageTakesNoWrite> =>
        Effect.all([buildCorpus(documents, path), workspaces.keptRelationsOf(path)]).pipe(
          Effect.flatMap(([modules, kept]) =>
            Option.match(Option.fromNullishOr(modules.get(path)), {
              onNone: () => Effect.succeed<ReadonlyArray<KeptRelation>>([]),
              onSome: (module) => {
                const catalogue = catalogueOf(modules)
                return workspaces
                  .keepRelations(path, approvedRelations(catalogue, module, kept, chosen))
                  .pipe(Effect.as(chosenRelations(catalogue, module, kept, chosen)))
              },
            }),
          ),
        ),

      relations: (path: Location): Effect.Effect<ReadonlyArray<Relation>> =>
        Effect.all([buildCorpus(documents, path), workspaces.keptRelationsOf(path)]).pipe(
          Effect.map(([modules, kept]) =>
            Option.match(Option.fromNullishOr(modules.get(path)), {
              onNone: () => [],
              onSome: (module) => relationsOf(catalogueOf(modules), module, kept),
            }),
          ),
        ),

      approvals: (
        path: Location,
        start: number,
        end: number,
      ): Effect.Effect<ReadonlyArray<FrameApproval>> =>
        Effect.all([buildCorpus(documents, path), workspaces.keptRelationsOf(path)]).pipe(
          Effect.map(([modules, kept]) =>
            pipe(
              Option.fromNullishOr(modules.get(path)),
              Option.map((module) => approvalsAt(catalogueOf(modules), module, kept, start, end)),
              Option.getOrElse((): ReadonlyArray<Approval> => []),
              Array.map((approval) =>
                Option.map(
                  workspaces.relationsFileOf(path, approval.keeps),
                  (written): FrameApproval => ({
                    title: approvalTitle(approval.relation),
                    file: written.file,
                    text: written.text,
                  }),
                ),
              ),
              Array.getSomes,
            ),
          ),
        ),

      definition: (path: Location, offset: number): Effect.Effect<FrameLocation | undefined> =>
        buildCorpus(documents, path).pipe(
          Effect.map((modules) =>
            Option.getOrUndefined(
              Option.flatMap(
                Option.orElse(definitionAt({ modules }, path, offset), () =>
                  recognisedDefinitionAt(vocabulariesIn(modules), path, offset),
                ),
                (loc) => frameLocationOf(modules, loc),
              ),
            ),
          ),
        ),

      references: (path: Location, offset: number): Effect.Effect<ReadonlyArray<FrameLocation>> =>
        buildCorpus(documents, path).pipe(
          Effect.map((modules) =>
            Array.getSomes(
              Option.getOrElse(conceptReferencesAt(vocabulariesIn(modules), path, offset), () =>
                referencesAt({ modules }, path, offset),
              ).map((loc) => frameLocationOf(modules, loc)),
            ),
          ),
        ),

      links: (path: Location, start: number, end: number): Effect.Effect<ReadonlyArray<FrameFix>> =>
        Effect.all([config.resolve(path), buildCorpus(documents, path)]).pipe(
          Effect.map(([settings, modules]) =>
            linksAt(vocabulariesIn(modules), path, start, end, settings.delims).map((fix) =>
              frameFixOf(modules, fix),
            ),
          ),
        ),

      moves: (path: Location, offset: number): Effect.Effect<ReadonlyArray<FrameMove>> =>
        buildCorpus(documents, path).pipe(
          Effect.map((modules) =>
            movesAt(vocabulariesIn(modules), path, offset).map((move): FrameMove => ({
              concept: move.concept,
              targets: move.targets.map((fix) => frameFixOf(modules, fix)),
            })),
          ),
        ),

      symbols: (within: Location, query: string): Effect.Effect<ReadonlyArray<FrameSymbol>> =>
        Option.match(documents.list, {
          onNone: () => Effect.succeed<ReadonlyArray<Location>>([]),
          onSome: (list) => list(within),
        }).pipe(
          Effect.flatMap((paths) =>
            Effect.forEach(paths, (path) =>
              loadOne(documents, path).pipe(Effect.map((module) => [path, module] as const)),
            ),
          ),
          Effect.map((pairs): Modules => new Map(pairs)),
          Effect.map((modules) =>
            Array.getSomes(
              conceptSymbolsIn({ modules }, query).map((symbol) =>
                Option.map(frameLocationOf(modules, symbol.location), (location): FrameSymbol => ({
                  name: symbol.name,
                  container: symbol.container,
                  location,
                })),
              ),
            ),
          ),
        ),

      hover: (path: Location, offset: number): Effect.Effect<FrameHover | undefined> =>
        corpusOf(documents, path).pipe(
          Effect.map((corpus) =>
            pipe(
              hoverAt({ modules: corpus.modules }, path, offset),
              Option.orElse(() => recognisedHoverAt(vocabulariesIn(corpus.modules), path, offset)),
              Option.orElse(() => keyHoverAt(corpus, path, offset)),
              Option.flatMap((card) =>
                Option.map(
                  frameLocationOf(corpus.modules, { path, position: card.position }),
                  (location): FrameHover => ({ range: location.range, markdown: card.markdown }),
                ),
              ),
              Option.getOrUndefined,
            ),
          ),
        ),

      rename: (path: Location, offset: number): Effect.Effect<ReadonlyArray<FrameEdit>> =>
        buildCorpus(documents, path).pipe(
          Effect.map((modules) => [
            ...Array.getSomes(
              renameAt({ modules }, path, offset).map((loc) => frameLocationOf(modules, loc)),
            ),
            ...Option.toArray(
              Option.flatMap(conceptRenameAt({ modules }, path, offset), (rename) =>
                Option.map(
                  frameLocationOf(modules, { path: rename.kept.path, position: rename.kept.at }),
                  (location): FrameEdit => ({ ...location, text: rename.kept.text }),
                ),
              ),
            ),
          ]),
        ),

      renameRange: (path: Location, offset: number): Effect.Effect<FrameLocation | undefined> =>
        buildCorpus(documents, path).pipe(
          Effect.map((modules) =>
            Option.getOrUndefined(
              Option.flatMap(renameRangeAt({ modules }, path, offset), (loc) =>
                frameLocationOf(modules, loc),
              ),
            ),
          ),
        ),

      navigationRange: (path: Location, offset: number): Effect.Effect<FrameLocation | undefined> =>
        buildCorpus(documents, path).pipe(
          Effect.map((modules) =>
            Option.getOrUndefined(
              Option.flatMap(
                Option.orElse(navigationRangeAt({ modules }, path, offset), () =>
                  recognisedRangeAt(vocabulariesIn(modules), path, offset),
                ),
                (loc) => frameLocationOf(modules, loc),
              ),
            ),
          ),
        ),

      semanticTokens: (path: Location): Effect.Effect<ReadonlyArray<FrameToken>> =>
        buildCorpus(documents, path).pipe(
          Effect.map((modules) =>
            pipe(
              Option.fromNullishOr(modules.get(path)),
              Option.match({
                onNone: () => [],
                onSome: (module) =>
                  Array.getSomes(
                    symbolsOf(module.doc).map((symbol) =>
                      Option.flatMap(profileOf(symbol.kind).semantic, (token) =>
                        Option.map(
                          frameLocationOf(modules, {
                            path,
                            position: symbol.position,
                          }),
                          (location): FrameToken => ({
                            range: location.range,
                            type: token,
                          }),
                        ),
                      ),
                    ),
                  ),
              }),
            ),
          ),
        ),

      boxes: (path: Location): Effect.Effect<ReadonlyArray<FrameBox>> =>
        buildCorpus(documents, path).pipe(
          Effect.map((modules) =>
            Option.match(Option.fromNullishOr(modules.get(path)), {
              onNone: (): ReadonlyArray<FrameBox> => [],
              onSome: (module) =>
                openedBoxesOf(module.doc).map((opened): FrameBox => ({
                  startLine: lineCharAt(module, opened.opener.position.start.offset).line,
                  endLine: lineCharAt(module, lastLineOf(opened).position.start.offset).line,
                  caption: captionOf(opened),
                })),
            }),
          ),
        ),

      hints: (path: Location): Effect.Effect<ReadonlyArray<FrameHint>> =>
        buildCorpus(documents, path).pipe(
          Effect.map((modules) =>
            Option.match(Option.fromNullishOr(modules.get(path)), {
              onNone: (): ReadonlyArray<FrameHint> => [],
              onSome: (module) =>
                hintsAt({ modules }, path).map((hint): FrameHint => ({
                  position: lineCharAt(module, hint.offset),
                  label: hint.label,
                })),
            }),
          ),
        ),

      completions: (
        path: Location,
        offset: number,
      ): Effect.Effect<ReadonlyArray<FrameCompletion>> =>
        corpusOf(documents, path).pipe(
          Effect.map(({ modules, kinds }) =>
            pipe(
              Option.fromNullishOr(modules.get(path)),
              Option.flatMap((module) =>
                Option.flatMap(slotAt(module.text, offset), (slot) =>
                  Option.map(bearerAt({ modules }, path, slot.brace), (bearer) =>
                    offersIn(
                      slot.wants,
                      takenBy(
                        { declared: declaredIn(kinds), document: module.doc },
                        bearer,
                        slot.kind,
                      ),
                      slot,
                    ).map((offer): FrameCompletion => ({
                      label: offer.label,
                      range: {
                        start: lineCharAt(module, slot.start),
                        end: lineCharAt(module, slot.end),
                      },
                      text: offer.text,
                    })),
                  ),
                ),
              ),
              Option.getOrElse((): ReadonlyArray<FrameCompletion> => []),
            ),
          ),
        ),

      contracts: (path: Location): Effect.Effect<ReadonlyArray<FrameContract>> =>
        buildCorpus(documents, path).pipe(
          Effect.map((modules) =>
            Array.getSomes(
              contractsIn(modules, path).map((contract) =>
                Option.map(
                  Option.fromNullishOr(modules.get(contract.target)),
                  (target): FrameContract => ({
                    target: {
                      path: contract.target,
                      range: {
                        start: lineCharAt(target, contract.span.start.offset),
                        end: lineCharAt(target, contract.span.end.offset),
                      },
                    },
                    language: contract.language,
                    expected: contract.provides.map((provided) => ({
                      name: provided.name,
                      diagnostic: faultAt(
                        MissingSymbol({
                          name: provided.name,
                          section: contract.section,
                          ...Option.match(contract.trope, {
                            onNone: () => ({}),
                            onSome: (trope) => ({ trope }),
                          }),
                        }),
                        provided.at,
                      ),
                    })),
                  }),
                ),
              ),
            ),
          ),
        ),

      promised: (path: Location, rootId: string): Effect.Effect<ReadonlyArray<PromisedName>> =>
        buildCorpus(documents, path).pipe(
          Effect.map((modules) => promisedNamesIn(modules, path, rootId)),
        ),

      reach: (path: Location): Effect.Effect<ReadonlyArray<Location>> =>
        buildCorpus(documents, path).pipe(
          Effect.map((modules) => reachable(modules, path).filter((p) => p !== path)),
        ),

      invalidate: (path: Location): Effect.Effect<ReadonlyArray<Location>> =>
        memo.entries.pipe(
          Effect.flatMap((modules) =>
            modules.has(path)
              ? evict([path]).pipe(Effect.as([path, ...transitiveDependents(modules, path)]))
              : Ref.set(keptCorpora, new Map()).pipe(Effect.as<ReadonlyArray<Location>>([])),
          ),
        ),

      invalidateWithin: (dir: Location): Effect.Effect<ReadonlyArray<Location>> =>
        memo.entries.pipe(
          Effect.map((modules) =>
            Array.fromIterable(modules.keys()).filter((path) => within(dir, path)),
          ),
          Effect.tap((paths) => evict(paths)),
        ),

      rebuild: (source: Source, path: Location): Effect.Effect<boolean> =>
        memo.entries.pipe(
          Effect.map((modules) => Option.map(Option.fromNullishOr(modules.get(path)), faceOf)),
          Effect.flatMap((before) =>
            matchEntry(source, path).pipe(
              Effect.andThen(loadOne(source, path)),
              Effect.map((module) => !Option.contains(before, faceOf(module))),
            ),
          ),
        ),
    }
  }),
}) {
  static readonly layer = Layer.effect(this, this.make).pipe(
    Layer.provide(Layer.mergeAll(LoomCorpusAstBuilder.layer, LoomMemo.layer, WeaveBuilder.layer)),
  )
}
