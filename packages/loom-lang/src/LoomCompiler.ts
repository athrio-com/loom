import type { CodeMapping, VirtualCode } from '@volar/language-core'
import { Array, Context, Data, Effect, Layer, Match, Option, pipe, Record, Ref } from 'effect'
import { join, sep } from 'node:path'
import type * as ts from 'typescript'
import { type Diagnostic, type Health, type Position } from '@athrio/loom-ast/LoomNode'
import { type LoomWeft } from '@athrio/loom-ast/Weft'
import { LoomCorpusAstBuilder, type ReadError, type Source } from '#ast/LoomCorpusAstBuilder'
import {
  bookOf,
  type Book,
  BoxNotice,
  boxNoticesIn,
  captionOf,
  openedBoxesOf,
  type OpenedBox,
  corpusErrors,
  definitionAt,
  dependentsOf,
  hintsAt,
  labelSlotAt,
  moduleDiagnostics,
  namesakesOf,
  reachable,
  referencesAt,
  renameAt,
  renameRangeAt,
  navigationRangeAt,
  refreshedSummaries,
  syncedSummaries,
  transitiveDependents,
  unresolvedTocEntriesIn,
  type CorpusLocation,
  type LoomModule,
  type Location,
} from '@athrio/loom-ast/LoomCorpusAst'
import {
  DuplicateName,
  faultAt,
  faulty,
  MissingSymbol,
  SpecifierUnknown,
  StaleSummary,
  UnresolvedTocEntry,
  UnwrittenLoom,
  UnsettledTrope,
  UnsettledModule,
  UnsettledSection,
} from '#ast/LoomFault'
import {
  crossFileFaults,
  holdsReferences,
  type Landing,
  landingOf,
  Referred,
  referredFileOf,
} from '#ast/ProductBuilder'
import { anchorKinds } from '@athrio/loom-ast/LoomTokens'
import { type Code, keyOf, type Part } from '@athrio/loom-ast/ProductAst'
import {
  type ComposedFile,
  type FrameCompletion,
  type FrameContract,
  type FrameBox,
  type FrameHint,
  type FrameLocation,
  type FrameToken,
  type PromisedName,
  type ServiceError,
  type SpecifierRequest,
} from '@athrio/loom-lang-services/LanguageService'
import { normaliseTitle } from '#ast/WeftTokeniser'
import { declaredKindsOf, kindFaults } from '#ast/DeclaredKinds'
import { boundariesOf, boundaryFaults } from '#ast/TropeBoundaries'
import {
  contractsIn,
  fromCode,
  fromProduct,
  noSpecifiers,
  type Reference,
  referencesIn,
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
import { LoomDiskCache } from './LoomDiskCache'
import { WorkspaceSettings } from './WorkspaceSettings'
import { WorkspaceSource } from './WorkspaceSource'
import { LanguagePackages } from './LanguagePackages'
import { WeaveBuilder } from './weave/WeaveBuilder'
import { type WovenCorpus } from './weave/WovenCorpus'
import { TableOfContentsBuilder, rewriteBook } from './weave/TableOfContentsBuilder'

type Modules = ReadonlyMap<Location, LoomModule>

const scopedTo = (modules: Modules, paths: ReadonlyArray<Location>): Modules => {
  const keep = new Set(paths)
  return new Map(Array.filter(Array.fromIterable(modules), ([p]) => keep.has(p)))
}

const entryOf = (
  modules: Modules,
  path: Location,
): Effect.Effect<{ readonly modules: Modules; readonly entry: LoomModule }> =>
  Effect.fromNullishOr(modules.get(path)).pipe(
    Effect.orDie,
    Effect.map((entry) => ({ modules, entry })),
  )

const loomName = (loom: Location): string => loom.slice(loom.lastIndexOf('/') + 1)

const namesakeFaults = (book: Book, module: LoomModule): ReadonlyArray<Diagnostic> =>
  Option.match(namesakesOf(book, module), {
    onNone: (): ReadonlyArray<Diagnostic> => [],
    onSome: ({ title, looms }) =>
      faulty(
        DuplicateName({
          name: title.source,
          sibling: 'chapter',
          where: Array.join(Array.map(looms, loomName), ', '),
        }),
        title.position,
      ).diagnostics,
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

const corpusDiagnostics = (modules: Modules) => {
  const book = bookOf(modules)
  const landing = landingOf(book, modules)
  const kinds = declaredKindsOf(modules, book)
  const boundaries = boundariesOf(modules, book, kinds.tropes)
  return (module: LoomModule): ReadonlyArray<Diagnostic> => [
    ...moduleDiagnostics(module),
    ...crossFileFaults(book, modules, module, landing),
    ...namesakeFaults(book, module),
    ...kindFaults(kinds, module),
    ...boundaryFaults(boundaries, book, module),
    ...Array.flatMap(
      boxNoticesIn({ modules }, module),
      (notice) => boxNoticeHealth(notice).diagnostics,
    ),
  ]
}

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
  placeOf: (loom: Location, sink: string) => Effect.Effect<Location>,
  written: WrittenFor,
): Effect.Effect<Resolved> =>
  pipe(
    Option.fromNullishOr(modules.get(entry)),
    Option.match({
      onNone: () => Effect.succeed<Resolved>({ files: [], unwritten: [] }),
      onSome: (module) => {
        const book = bookOf(modules)
        const landing = landingOf(book, modules)
        return Effect.forEach(module.product.files, (file) =>
          placeOf(entry, file.path).pipe(
            Effect.flatMap((path) =>
              written(modules, book, landing, file.code, path).pipe(
                Effect.map((paths) => ({
                  file: {
                    section: file.code.origin.name,
                    path,
                    content: fromCode(modules, file.code, book, specifiersOf(paths)).code,
                  },
                  unwritten: paths.unwritten,
                })),
              ),
            ),
          ),
        ).pipe(
          Effect.map((each) => ({
            files: Array.map(each, (one) => one.file),
            unwritten: Array.flatMap(each, (one) => one.unwritten),
          })),
        )
      },
    }),
  )

const unsettledFailures = (
  modules: Modules,
  entry: Location,
): ReadonlyArray<{ readonly path: Location; readonly diagnostics: ReadonlyArray<Diagnostic> }> => {
  const book = bookOf(modules)
  return pipe(
    Option.fromNullishOr(modules.get(entry)),
    Option.match({
      onNone: (): ReadonlyArray<Unsettled> => [],
      onSome: (module) =>
        Array.flatMap(module.product.files, (file) => unsettledIn(modules, file.code, book)),
    }),
    Array.dedupeWith(
      (one, other) =>
        one.path === other.path && one.anchor.start.offset === other.anchor.start.offset,
    ),
    Array.groupBy((unsettled) => unsettled.path),
    Record.toEntries,
    Array.map(([path, unsettled]) => ({
      path,
      diagnostics: Array.flatMap(
        unsettled,
        (one) =>
          faulty(
            one.reference
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
}> {
  get message(): string {
    const count = this.failures.reduce((n, f) => n + f.diagnostics.length, 0)
    const lines = this.failures.flatMap((f) =>
      f.diagnostics.map((d) => `  ${f.path}:${d.position.start.line}: ${d.message}`),
    )
    return `loom: refusing to tangle ${this.entry} — ${count} problem(s) across the corpus:\n${lines.join('\n')}`
  }
}

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
  book: Book,
  landing: Landing,
  root: Code,
  from: Location,
) => Effect.Effect<Written>

const nothingWritten: Written = { specifiers: new Map(), unwritten: [] }

const specifierKey = (owner: Location, at: Position): string => `${owner}#${at.start.offset}`

const writtenOf = (reference: Reference, text: string): Written => ({
  specifiers: new Map([[specifierKey(reference.owner, reference.ref.anchor), text]]),
  unwritten: [],
})

const unwrittenOf = (reference: Reference, reason: string): Written => ({
  specifiers: new Map(),
  unwritten: [
    {
      path: reference.owner,
      diagnostic: faultAt(
        SpecifierUnknown({ name: reference.ref.name, language: reference.host.languageId, reason }),
        reference.ref.anchor,
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
    Array.map(([path, each]) => ({ path, diagnostics: Array.map(each, (one) => one.diagnostic) })),
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

const lineCharAt = (
  text: string,
  offset: number,
): { readonly line: number; readonly character: number } => {
  const before = text.slice(0, offset)
  return {
    line: before.split('\n').length - 1,
    character: offset - (before.lastIndexOf('\n') + 1),
  }
}

const frameLocationOf = (
  modules: Modules,
  location: CorpusLocation,
): Option.Option<FrameLocation> =>
  Option.map(Option.fromNullishOr(modules.get(location.path)?.text), (text) => ({
    path: location.path,
    range: {
      start: lineCharAt(text, location.position.start.offset),
      end: lineCharAt(text, location.position.end.offset),
    },
  }))

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

export const within = (dir: Location, path: Location): boolean => path.startsWith(join(dir, sep))

const tokenValue = (token: { readonly value: string } | undefined): string =>
  Option.getOrElse(
    Option.map(Option.fromNullishOr(token), (present) => present.value),
    () => '',
  )

const partFaceOf = (part: Part): string =>
  Match.value(part).pipe(
    Match.when({ type: 'Fragment' }, (fragment) => fragment.text),
    Match.when({ type: 'NameRef' }, (ref) =>
      Option.match(ref.target, { onNone: () => ref.name, onSome: keyOf }),
    ),
    Match.when(
      { type: 'ModuleRef' },
      (ref) =>
        `module ${Option.match(ref.target, { onNone: () => ref.name, onSome: keyOf })} ${Option.match(
          ref.file,
          { onNone: () => '', onSome: (file) => file.name },
        )}`,
    ),
    Match.exhaustive,
  )

const faceOf = (module: LoomModule): string =>
  JSON.stringify({
    frontmatter: Option.match(Option.fromNullishOr(module.doc.frontmatter), {
      onNone: () => [],
      onSome: (frontmatter) =>
        Array.map(
          [
            frontmatter.part,
            frontmatter.partName,
            frontmatter.chapter,
            frontmatter.title,
            frontmatter.package,
            frontmatter.language,
          ],
          tokenValue,
        ),
    }),
    titles: Array.map(module.doc.sections, (section) =>
      Option.getOrElse(
        Option.map(Option.fromNullishOr(section.heading.title), (title) => title.source),
        () => '',
      ),
    ),
    code: Array.map(module.product.code, (code) => [
      code.origin.name,
      code.languageId,
      Array.map(code.fragments, partFaceOf),
    ]),
    files: Array.map(module.product.files, (file) => [file.path, file.code.origin.name]),
  })

interface Composition {
  readonly modules: Modules
  readonly placed: ReadonlyMap<Location, ReadonlyArray<Location>>
  readonly files: ReadonlyMap<Location, ReadonlyArray<ComposedFile>>
}

const noComposition: Composition = { modules: new Map(), placed: new Map(), files: new Map() }

const composedFilesOf = (
  modules: Modules,
  book: Book,
  landing: Landing,
  module: LoomModule,
  paths: ReadonlyArray<Location>,
  written: WrittenFor,
): Effect.Effect<ReadonlyArray<ComposedFile>> =>
  Effect.forEach(Array.zip(module.product.files, paths), ([file, path]) =>
    written(modules, book, landing, file.code, path).pipe(
      Effect.map(
        (specifiers): ComposedFile => ({
          path,
          content: fromCode(modules, file.code, book, specifiersOf(specifiers)).code,
          loomPath: module.path,
          rootId: file.code.origin.name.toLowerCase(),
          heading: headingLocationOf(modules, module, file.code.origin.name),
        }),
      ),
    ),
  )

const samePlaces = (
  before: ReadonlyArray<Location> | undefined,
  after: ReadonlyArray<Location> | undefined,
): boolean =>
  Option.match(Option.all([Option.fromNullishOr(before), Option.fromNullishOr(after)]), {
    onNone: () => before === after,
    onSome: ([was, now]) =>
      was.length === now.length && Array.every(was, (path, i) => path === now[i]),
  })

const changedSince = (
  previous: Composition,
  modules: Modules,
  placed: ReadonlyMap<Location, ReadonlyArray<Location>>,
): ReadonlyArray<Location> =>
  Array.filter(
    Array.dedupe([...previous.modules.keys(), ...modules.keys()]),
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
  const book = bookOf(modules)
  const landing = landingOf(book, modules)
  return Effect.forEach(Array.fromIterable(modules.values()), (module) =>
    pipe(
      Option.fromNullishOr(previous.files.get(module.path)),
      Option.filter(() => !stale.has(module.path)),
      Option.match({
        onSome: (kept) => Effect.succeed([module.path, kept] as const),
        onNone: () =>
          composedFilesOf(
            modules,
            book,
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
  Array.flatten(Array.fromIterable(composition.files.values()))

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
        pipe(
          unsettledIn(modules, root),
          Array.flatMap((unsettled) =>
            Array.map(unsettled.provides, (provided): PromisedName => ({
              name: provided.name,
              section: unsettled.name,
            })),
          ),
          Array.dedupeWith(
            (one, other) => one.name === other.name && one.section === other.section,
          ),
        ),
    }),
  )

const namesAt = (modules: Modules, path: Location): ReadonlyArray<string> =>
  pipe(
    Option.fromNullishOr(modules.get(path)),
    Option.match({
      onNone: () => [],
      onSome: (module) => Array.map(module.product.code, (c) => c.origin.name),
    }),
  )

const rootsAt = (modules: Modules, path: Location): ReadonlyArray<string> => {
  const roots = rootNamesAt(modules, path)
  return Array.filter(namesAt(modules, path), (name) => roots.has(name.toLowerCase()))
}

const projectTree = (
  modules: Modules,
  entry: LoomModule,
  specifiers: ReadonlyMap<string, Specifiers>,
): LoomVirtualCode => {
  const book = bookOf(modules)
  return rootVirtualCode(
    entry.text,
    [
      fromProse(modules, entry.path),
      ...pipe(
        rootsAt(modules, entry.path),
        Array.map((name) =>
          fromProduct(
            modules,
            { path: entry.path, name },
            book,
            Option.getOrElse(Option.fromNullishOr(specifiers.get(name)), () => noSpecifiers),
          ),
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

const featuresOf = (kind: Mapping['kind']): CodeMapping['data'] =>
  Match.value(kind).pipe(
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
  mappings: Array.map(vc.mappings, toCodeMapping),
  embeddedCodes: Array.map(vc.embeddedCodes, toVolar),
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
        Ref.update(held, (texts) => new Map(Array.filter([...texts], ([path]) => path !== loom))),
      list: Option.some((loom: Location): Effect.Effect<ReadonlyArray<Location>> => source.corpusOf(loom)),
    }
  }),
}) {
  static readonly layer = Layer.effect(this, this.make)
}

export class LoomCompiler extends Context.Service<LoomCompiler>()('LoomCompiler', {
  make: Effect.gen(function* () {
    const documents = yield* DocumentSource
    const workspaces = yield* WorkspaceSource
    const builder = yield* LoomCorpusAstBuilder
    const memo = yield* LoomMemo
    const disk = yield* LoomDiskCache
    const config = yield* WorkspaceSettings
    const weaver = yield* WeaveBuilder
    const tocBuilder = yield* TableOfContentsBuilder
    const composed = yield* Ref.make<Composition>(noComposition)
    const packages = yield* Effect.serviceOption(LanguagePackages)

    const specifierOf = (request: SpecifierRequest): Effect.Effect<Option.Option<string>, ServiceError> =>
      Option.match(packages, {
        onNone: () => Effect.succeed(Option.none<string>()),
        onSome: (held) => held.moduleSpecifier(request),
      })

    const writtenFor: WrittenFor = (modules, book, landing, root, from) =>
      Effect.forEach(referencesIn(modules, root, book), (reference) =>
        pipe(
          Option.fromNullishOr(modules.get(reference.owner)),
          Option.map((module) =>
            referredFileOf(book, modules, landing, module, reference.host, reference.ref),
          ),
          Option.filter(Referred.$is('Named')),
          Option.match({
            onNone: () => Effect.succeed(nothingWritten),
            onSome: ({ landed }) =>
              workspaces.placeOf(landed.loom, landed.file.path).pipe(
                Effect.flatMap((to) =>
                  specifierOf({
                    language: reference.host.languageId,
                    loom: reference.owner,
                    from,
                    to,
                  }),
                ),
                Effect.map(
                  Option.match({
                    onNone: () => unwrittenOf(reference, 'No package writes its paths.'),
                    onSome: (text) => writtenOf(reference, text),
                  }),
                ),
                Effect.catchTag('ServiceError', (error) =>
                  Effect.succeed(unwrittenOf(reference, error.reason)),
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
          onSome: (file) => workspaces.placeOf(entry.path, file.path),
        },
      )

    const rootSpecifiers = (
      modules: Modules,
      entry: LoomModule,
    ): Effect.Effect<ReadonlyMap<string, Specifiers>> => {
      if (!holdsReferences(modules)) return Effect.succeed(new Map())
      const book = bookOf(modules)
      const landing = landingOf(book, modules)
      return Effect.forEach(entry.product.code, (root) =>
        fileOfRoot(entry, root).pipe(
          Effect.flatMap((from) => writtenFor(modules, book, landing, root, from)),
          Effect.map((written) => [root.origin.name, specifiersOf(written)] as const),
        ),
      ).pipe(Effect.map((pairs) => new Map(pairs)))
    }

    const loadOne = (source: Source, path: Location): Effect.Effect<LoomModule> =>
      config
        .resolve(path)
        .pipe(
          Effect.flatMap((settings) =>
            memo.get(
              path,
              disk.through(
                source,
                documents,
                path,
                settings,
                builder.build(
                  source,
                  path,
                  settings.delims,
                  settings.primaryLanguage,
                  settings.variables,
                ),
              ),
            ),
          ),
        )

    const corpusPaths = (source: Source, entry: Location): Effect.Effect<ReadonlyArray<Location>> =>
      Option.match(source.list, {
        onNone: () => Effect.succeed<ReadonlyArray<Location>>([entry]),
        onSome: (list) => list(entry).pipe(Effect.map((found) => Array.dedupe([entry, ...found]))),
      })

    const matchEntry = (source: Source, path: Location): Effect.Effect<void> =>
      Effect.all([Effect.option(source.read(path)), memo.entries]).pipe(
        Effect.flatMap(([text, modules]) =>
          pipe(
            Option.all([text, Option.fromNullishOr(modules.get(path))]),
            Option.filter(([shown, kept]) => kept.text !== shown),
            Option.match({ onNone: () => Effect.void, onSome: () => memo.evict([path]) }),
          ),
        ),
      )

    const buildCorpus = (source: Source, entry: Location): Effect.Effect<Modules> =>
      corpusPaths(source, entry).pipe(
        Effect.flatMap((paths) =>
          Effect.forEach(paths, (path) =>
            loadOne(source, path).pipe(Effect.map((m) => [path, m] as const)),
          ),
        ),
        Effect.map((pairs) => new Map(pairs)),
      )

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
            Effect.logError('loom: projection failed; serving bare document', cause).pipe(
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
        buildCorpus(documents, path).pipe(
          Effect.flatMap((modules) => {
            const scoped = scopedTo(modules, reachable(modules, path))
            const failures = [
              ...corpusErrors({ modules: scoped }, corpusDiagnostics(modules)),
              ...unsettledFailures(modules, path),
            ]
            return failures.length > 0
              ? Effect.fail(new TangleError({ entry: path, failures }))
              : resolveSinks(modules, path, workspaces.placeOf, writtenFor).pipe(
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
            Effect.forEach(Array.fromIterable(modules.values()), (module) =>
              Effect.forEach(module.product.files, (file) =>
                workspaces.placeOf(module.path, file.path),
              ).pipe(Effect.map((paths) => [module.path, paths] as const)),
            ).pipe(
              Effect.map((pairs) => new Map(pairs)),
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
        buildCorpus(documents, path).pipe(Effect.flatMap((modules) => weaver.build({ modules }))),

      contents: (path: Location): Effect.Effect<string> =>
        buildCorpus(documents, path).pipe(
          Effect.flatMap((modules) =>
            tocBuilder
              .build({ modules })
              .pipe(Effect.map((toc) => rewriteBook({ modules }, path, toc))),
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
        Effect.all([config.resolve(path), buildCorpus(documents, path)]).pipe(
          Effect.flatMap(([settings, modules]) => {
            const parsedAs = (text: string): Effect.Effect<LoomModule> =>
              builder.build(
                { read: () => Effect.succeed(text), list: Option.none() },
                path,
                settings.delims,
                settings.primaryLanguage,
                settings.variables,
              )
            return Effect.all([parsedAs(before), parsedAs(after)]).pipe(
              Effect.map(([was, now]) =>
                Array.getSomes(
                  Array.map(syncedSummaries({ modules }, was, now), (edit) =>
                    Option.map(
                      Option.fromNullishOr(modules.get(edit.path)),
                      (target): SummaryEdit => ({
                        path: edit.path,
                        range: {
                          start: lineCharAt(target.text, edit.at.start.offset),
                          end: lineCharAt(target.text, edit.at.end.offset),
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
        buildCorpus(documents, path).pipe(
          Effect.map((modules) =>
            pipe(
              Option.fromNullishOr(modules.get(path)),
              Option.match({
                onNone: () => [],
                onSome: (module) => [
                  ...corpusDiagnostics(modules)(module),
                  ...Array.flatMap(
                    unresolvedTocEntriesIn({ modules }, module),
                    (entry) =>
                      faulty(
                        UnresolvedTocEntry({
                          title: entry.title.value,
                          discussion: entry.discussion,
                        }),
                        entry.title.position,
                      ).diagnostics,
                  ),
                ],
              }),
            ),
          ),
        ),

      definition: (path: Location, offset: number): Effect.Effect<FrameLocation | undefined> =>
        buildCorpus(documents, path).pipe(
          Effect.map((modules) =>
            Option.getOrUndefined(
              Option.flatMap(definitionAt({ modules }, path, offset), (loc) =>
                frameLocationOf(modules, loc),
              ),
            ),
          ),
        ),

      references: (path: Location, offset: number): Effect.Effect<ReadonlyArray<FrameLocation>> =>
        buildCorpus(documents, path).pipe(
          Effect.map((modules) =>
            Array.getSomes(
              Array.map(referencesAt({ modules }, path, offset), (loc) =>
                frameLocationOf(modules, loc),
              ),
            ),
          ),
        ),

      rename: (path: Location, offset: number): Effect.Effect<ReadonlyArray<FrameLocation>> =>
        buildCorpus(documents, path).pipe(
          Effect.map((modules) =>
            Array.getSomes(
              Array.map(renameAt({ modules }, path, offset), (loc) =>
                frameLocationOf(modules, loc),
              ),
            ),
          ),
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
              Option.flatMap(navigationRangeAt({ modules }, path, offset), (loc) =>
                frameLocationOf(modules, loc),
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
                    Array.map(symbolsOf(module.doc), (symbol) =>
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
                Array.map(openedBoxesOf(module.doc), (opened): FrameBox => ({
                  startLine: lineCharAt(module.text, opened.opener.position.start.offset).line,
                  endLine: lineCharAt(module.text, lastLineOf(opened).position.start.offset).line,
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
                Array.map(hintsAt({ modules }, path), (hint): FrameHint => ({
                  position: lineCharAt(module.text, hint.offset),
                  label: hint.label,
                })),
            }),
          ),
        ),

      completions: (
        path: Location,
        offset: number,
      ): Effect.Effect<ReadonlyArray<FrameCompletion>> =>
        buildCorpus(documents, path).pipe(
          Effect.map((modules) =>
            Option.match(
              Option.all([
                Option.fromNullishOr(modules.get(path)),
                labelSlotAt({ modules }, path, offset),
              ]),
              {
                onNone: (): ReadonlyArray<FrameCompletion> => [],
                onSome: ([module, slot]) =>
                  Array.map(anchorKinds, (label): FrameCompletion => ({
                    label,
                    range: {
                      start: lineCharAt(module.text, slot.start),
                      end: lineCharAt(module.text, slot.end),
                    },
                    text: slot.closed ? label : `${label}}`,
                  })),
              },
            ),
          ),
        ),

      contracts: (path: Location): Effect.Effect<ReadonlyArray<FrameContract>> =>
        buildCorpus(documents, path).pipe(
          Effect.map((modules) =>
            Array.getSomes(
              Array.map(contractsIn(modules, path), (contract) =>
                Option.map(
                  Option.fromNullishOr(modules.get(contract.target)),
                  (target): FrameContract => ({
                    target: {
                      path: contract.target,
                      range: {
                        start: lineCharAt(target.text, contract.span.start.offset),
                        end: lineCharAt(target.text, contract.span.end.offset),
                      },
                    },
                    language: contract.language,
                    expected: Array.map(contract.provides, (provided) => ({
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
          Effect.map((modules) => Array.filter(reachable(modules, path), (p) => p !== path)),
        ),

      invalidate: (path: Location): Effect.Effect<ReadonlyArray<Location>> =>
        memo.entries.pipe(
          Effect.flatMap((modules) =>
            modules.has(path)
              ? memo
                  .evict([path])
                  .pipe(Effect.as([path, ...transitiveDependents(modules, path)]))
              : Effect.succeed<ReadonlyArray<Location>>([]),
          ),
        ),

      invalidateWithin: (dir: Location): Effect.Effect<ReadonlyArray<Location>> =>
        memo.entries.pipe(
          Effect.map((modules) =>
            Array.filter(Array.fromIterable(modules.keys()), (path) => within(dir, path)),
          ),
          Effect.tap((paths) => memo.evict(paths)),
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
    Layer.provide(
      Layer.mergeAll(
        LoomCorpusAstBuilder.layer,
        LoomMemo.layer,
        WeaveBuilder.layer,
        TableOfContentsBuilder.layer,
      ),
    ),
  )
}
