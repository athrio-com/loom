import type { CodeMapping, VirtualCode } from '@volar/language-core'
import { Array, Context, Data, Effect, Layer, Match, Option, pipe, Record, Ref } from 'effect'
import { join, sep } from 'node:path'
import type * as ts from 'typescript'
import { type Diagnostic } from '@athrio/loom-ast/LoomNode'
import { LoomCorpusAstBuilder, type ReadError, type Source } from '#ast/LoomCorpusAstBuilder'
import {
  bookOf,
  type Book,
  corpusErrors,
  definitionAt,
  dependentsOf,
  hintsAt,
  moduleDiagnostics,
  namesakesOf,
  reachable,
  referencesAt,
  renameAt,
  renameRangeAt,
  navigationRangeAt,
  transitiveDependents,
  unresolvedTocEntriesIn,
  type CorpusLocation,
  type LoomModule,
  type Location,
} from '@athrio/loom-ast/LoomCorpusAst'
import { DuplicateName, faulty, UnresolvedTocEntry, UnsettledSection } from '#ast/LoomFault'
import { crossFileFaults } from '#ast/ProductBuilder'
import { keyOf, type Part } from '@athrio/loom-ast/ProductAst'
import {
  type ComposedFile,
  type FrameHint,
  type FrameLocation,
  type FrameToken,
} from '@athrio/loom-lang-services/LanguageService'
import { normaliseTitle } from '#ast/WeftTokeniser'
import {
  fromCode,
  fromProduct,
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

const corpusDiagnostics = (modules: Modules) => {
  const book = bookOf(modules)
  return (module: LoomModule): ReadonlyArray<Diagnostic> => [
    ...moduleDiagnostics(module),
    ...crossFileFaults(book, modules, module),
    ...namesakeFaults(book, module),
  ]
}

export interface TangledFile {
  readonly section: string
  readonly path: Location
  readonly content: string
}

const resolveSinks = (
  modules: Modules,
  entry: Location,
  placeOf: (loom: Location, sink: string) => Effect.Effect<Location>,
): Effect.Effect<ReadonlyArray<TangledFile>> =>
  pipe(
    Option.fromNullishOr(modules.get(entry)),
    Option.match({
      onNone: () => Effect.succeed<ReadonlyArray<TangledFile>>([]),
      onSome: (module) => {
        const book = bookOf(modules)
        return Effect.forEach(module.product.files, (file) =>
          placeOf(entry, file.path).pipe(
            Effect.map((path) => ({
              section: file.code.origin.name,
              path,
              content: fromCode(modules, file.code, book).code,
            })),
          ),
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
            UnsettledSection({ name: one.name, declared: Option.isSome(one.section) }),
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
  module: LoomModule,
  paths: ReadonlyArray<Location>,
): ReadonlyArray<ComposedFile> =>
  Array.zipWith(module.product.files, paths, (file, path): ComposedFile => ({
    path,
    content: fromCode(modules, file.code, book).code,
    loomPath: module.path,
    rootId: file.code.origin.name.toLowerCase(),
    heading: headingLocationOf(modules, module, file.code.origin.name),
  }))

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
): Composition => {
  const stale = staleSince(previous, modules, placed)
  if (stale.size === 0) return { ...previous, modules, placed }
  const book = bookOf(modules)
  return {
    modules,
    placed,
    files: new Map(
      Array.map(
        Array.fromIterable(modules.values()),
        (module) =>
          [
            module.path,
            pipe(
              Option.fromNullishOr(previous.files.get(module.path)),
              Option.filter(() => !stale.has(module.path)),
              Option.getOrElse(() =>
                composedFilesOf(modules, book, module, placed.get(module.path) ?? []),
              ),
            ),
          ] as const,
      ),
    ),
  }
}

const composedFiles = (composition: Composition): ReadonlyArray<ComposedFile> =>
  Array.flatten(Array.fromIterable(composition.files.values()))

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

const projectTree = (modules: Modules, entry: LoomModule): LoomVirtualCode => {
  const book = bookOf(modules)
  return rootVirtualCode(
    entry.text,
    [
      fromProse(modules, entry.path),
      ...pipe(
        rootsAt(modules, entry.path),
        Array.map((name) => fromProduct(modules, { path: entry.path, name }, book)),
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
          Effect.map(({ modules, entry }) => toVolar(projectTree(modules, entry))),
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
              : resolveSinks(modules, path, workspaces.placeOf)
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
                Ref.modify(composed, (previous) => {
                  const next = recompose(previous, modules, placed)
                  return [composedFiles(next), next] as const
                }),
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
                    (title) =>
                      faulty(UnresolvedTocEntry({ title: title.value }), title.position)
                        .diagnostics,
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
