import type { CodeMapping, VirtualCode } from '@volar/language-core'
import { Array, Context, Data, Effect, Layer, Match, Option, pipe, Ref } from 'effect'
import { readFileSync } from 'node:fs'
import { dirname, resolve as resolvePath } from 'node:path'
import type * as ts from 'typescript'
import { type Diagnostic } from '@athrio/loom-ast/LoomNode'
import { LoomCorpusAstBuilder, ReadError, type Source } from '#ast/LoomCorpusAstBuilder'
import {
  corpusErrors,
  definitionAt,
  dependentsOf,
  moduleDiagnostics,
  reachable,
  referencesAt,
  renameAt,
  renameRangeAt,
  navigationRangeAt,
  transitiveDependents,
  unresolvedTocEntriesIn,
  type CorpusLocation,
  type LoomModule,
  type Path,
} from '@athrio/loom-ast/LoomCorpusAst'
import { faulty, UnresolvedTocEntry } from '#ast/LoomFault'
import { crossFileFaults } from '#ast/ProductBuilder'
import { keyOf, type Part } from '@athrio/loom-ast/ProductAst'
import {
  type ComposedFile,
  type FrameLocation,
  type FrameToken,
} from '@athrio/loom-lang-services/LanguageService'
import { normaliseTitle } from '#ast/WeftTokeniser'
import {
  fromProduct,
  fromProse,
  rootNamesAt,
  rootVirtualCode,
  symbolMappings,
} from '#ast/LoomVirtualCodeBuilder'
import { type LoomVirtualCode, type Mapping } from '@athrio/loom-ast/LoomVirtualCode'
import { profileOf, symbolsOf } from '@athrio/loom-ast/LoomSymbol'
import { LoomMemo } from './LoomMemo'
import { LoomDiskCache } from './LoomDiskCache'
import { PackageConfig } from './PackageConfig'
import { holds, loomsIn, projectIn, type LoomProject } from './LoomProject'
import { WeaveBuilder } from './weave/WeaveBuilder'
import { type WovenCorpus } from './weave/WovenCorpus'
import { TableOfContentsBuilder, rewriteBook } from './weave/TableOfContentsBuilder'

type Modules = ReadonlyMap<Path, LoomModule>

const scopedTo = (modules: Modules, paths: ReadonlyArray<Path>): Modules => {
  const keep = new Set(paths)
  return new Map(Array.filter(Array.fromIterable(modules), ([p]) => keep.has(p)))
}

const entryOf = (
  modules: Modules,
  path: Path,
): Effect.Effect<{ readonly modules: Modules; readonly entry: LoomModule }> =>
  Effect.fromNullishOr(modules.get(path)).pipe(
    Effect.orDie,
    Effect.map((entry) => ({ modules, entry })),
  )

const corpusDiagnostics =
  (modules: Modules) =>
  (module: LoomModule): ReadonlyArray<Diagnostic> => [
    ...moduleDiagnostics(module),
    ...crossFileFaults(modules, module),
  ]

export interface TangledFile {
  readonly section: string
  readonly path: Path
  readonly content: string
}

export const outputPath = (packageRoot: Option.Option<string>, entry: Path, sink: string): Path =>
  Option.match(packageRoot, {
    onNone: () => resolvePath(dirname(entry), sink),
    onSome: (root) => resolvePath(root, sink),
  })

const resolveSinks = (
  modules: Modules,
  entry: Path,
  packageRoot: Option.Option<string>,
): ReadonlyArray<TangledFile> =>
  pipe(
    Option.fromNullishOr(modules.get(entry)),
    Option.match({
      onNone: () => [],
      onSome: (module) =>
        Array.map(module.product.files, (file) => ({
          section: file.code.origin.name,
          path: outputPath(packageRoot, entry, file.path),
          content: fromProduct(modules, file.code.origin).code,
        })),
    }),
  )

export class TangleError extends Data.TaggedError('TangleError')<{
  readonly entry: Path
  readonly failures: ReadonlyArray<{
    readonly path: Path
    readonly diagnostics: ReadonlyArray<Diagnostic>
  }>
}> {
  get message(): string {
    const count = this.failures.reduce((n, f) => n + f.diagnostics.length, 0)
    const lines = this.failures.flatMap((f) =>
      f.diagnostics.map((d) => `  ${f.path}:${d.position.start.line}: ${d.message}`),
    )
    return `loom: refusing to tangle ${this.entry} — ${count} error(s) across the corpus:\n${lines.join('\n')}`
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

const valueOf = (token: { readonly value: string } | undefined): string =>
  Option.getOrElse(
    Option.map(Option.fromNullishOr(token), (present) => present.value),
    () => '',
  )

const partFaceOf = (part: Part): string =>
  Match.value(part).pipe(
    Match.when({ type: 'Fragment' }, (fragment) => fragment.text),
    Match.when({ type: 'NameRef' }, (ref) =>
      Option.match(ref.target, { onNone: () => '', onSome: keyOf }),
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
          valueOf,
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
  readonly roots: ReadonlyMap<Path, string>
  readonly files: ReadonlyMap<Path, ReadonlyArray<ComposedFile>>
}

const noComposition: Composition = { modules: new Map(), roots: new Map(), files: new Map() }

const composedFilesOf = (
  modules: Modules,
  module: LoomModule,
  packageRoot: Option.Option<string>,
): ReadonlyArray<ComposedFile> =>
  Array.map(module.product.files, (file): ComposedFile => ({
    path: outputPath(packageRoot, module.path, file.path),
    content: fromProduct(modules, file.code.origin).code,
    loomPath: module.path,
    rootId: file.code.origin.name.toLowerCase(),
    heading: headingLocationOf(modules, module, file.code.origin.name),
  }))

const changedSince = (
  previous: Composition,
  modules: Modules,
  roots: ReadonlyMap<Path, string>,
): ReadonlyArray<Path> =>
  Array.filter(
    Array.dedupe([...previous.modules.keys(), ...modules.keys()]),
    (path) =>
      previous.modules.get(path) !== modules.get(path) ||
      previous.roots.get(path) !== roots.get(path),
  )

const staleSince = (
  previous: Composition,
  modules: Modules,
  roots: ReadonlyMap<Path, string>,
): ReadonlySet<Path> => {
  const changed = changedSince(previous, modules, roots)
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
  roots: ReadonlyMap<Path, string>,
): Composition => {
  const stale = staleSince(previous, modules, roots)
  return {
    modules,
    roots,
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
                composedFilesOf(modules, module, Option.fromNullishOr(roots.get(module.path))),
              ),
            ),
          ] as const,
      ),
    ),
  }
}

const composedFiles = (composition: Composition): ReadonlyArray<ComposedFile> =>
  Array.flatten(Array.fromIterable(composition.files.values()))

const namesAt = (modules: Modules, path: Path): ReadonlyArray<string> =>
  pipe(
    Option.fromNullishOr(modules.get(path)),
    Option.match({
      onNone: () => [],
      onSome: (module) => Array.map(module.product.code, (c) => c.origin.name),
    }),
  )

const rootsAt = (modules: Modules, path: Path): ReadonlyArray<string> => {
  const roots = rootNamesAt(modules, path)
  return Array.filter(namesAt(modules, path), (name) => roots.has(name.toLowerCase()))
}

const projectTree = (modules: Modules, entry: LoomModule): LoomVirtualCode =>
  rootVirtualCode(
    entry.text,
    [
      fromProse(modules, entry.path),
      ...pipe(
        rootsAt(modules, entry.path),
        Array.map((name) => fromProduct(modules, { path: entry.path, name })),
      ),
    ],
    symbolMappings(entry.doc),
  )

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
    Match.when('source', () => ({ verification: true, format: true })),
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
  make: Effect.succeed({
    read: (path: Path): Effect.Effect<string, ReadError> =>
      Effect.try({
        try: () => readFileSync(path, 'utf8'),
        catch: (cause) => new ReadError({ path, cause }),
      }),
    list: Option.some(
      (dir: Path, project: Option.Option<LoomProject>): Effect.Effect<ReadonlyArray<Path>> =>
        Effect.sync(() => loomsIn(dir, project)),
    ),
  }),
}) {
  static readonly layer = Layer.effect(this, this.make)
}

export class LoomCompiler extends Context.Service<LoomCompiler>()('LoomCompiler', {
  make: Effect.gen(function* () {
    const documents = yield* DocumentSource
    const builder = yield* LoomCorpusAstBuilder
    const memo = yield* LoomMemo
    const disk = yield* LoomDiskCache
    const config = yield* PackageConfig
    const weaver = yield* WeaveBuilder
    const tocBuilder = yield* TableOfContentsBuilder
    const composed = yield* Ref.make<Composition>(noComposition)

    const loadOne = (source: Source, path: Path): Effect.Effect<LoomModule> =>
      config
        .resolve(path)
        .pipe(
          Effect.flatMap((settings) =>
            memo.get(
              path,
              disk.through(
                source,
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

    const listFrom = (
      list: (dir: Path, project: Option.Option<LoomProject>) => Effect.Effect<ReadonlyArray<Path>>,
      entry: Path,
    ): Effect.Effect<ReadonlyArray<Path>> =>
      config.resolve(entry).pipe(
        Effect.flatMap((settings) =>
          Option.match(
            Option.filter(projectIn(settings), (project) => holds(project, entry)),
            {
              onNone: () => list(dirname(entry), Option.none()),
              onSome: (project) =>
                list(
                  Option.getOrElse(Option.fromNullishOr(settings.corpusDir), () => dirname(entry)),
                  Option.some(project),
                ),
            },
          ),
        ),
        Effect.map((found) => Array.dedupe([entry, ...found])),
      )

    const corpusPaths = (source: Source, entry: Path): Effect.Effect<ReadonlyArray<Path>> =>
      Option.match(source.list, {
        onNone: () => Effect.succeed<ReadonlyArray<Path>>([entry]),
        onSome: (list) => listFrom(list, entry),
      })

    const matchEntry = (source: Source, path: Path): Effect.Effect<void> =>
      Effect.all([Effect.option(source.read(path)), memo.entries]).pipe(
        Effect.flatMap(([text, modules]) =>
          pipe(
            Option.all([text, Option.fromNullishOr(modules.get(path))]),
            Option.filter(([shown, kept]) => kept.text !== shown),
            Option.match({ onNone: () => Effect.void, onSome: () => memo.evict([path]) }),
          ),
        ),
      )

    const buildCorpus = (source: Source, entry: Path): Effect.Effect<Modules> =>
      corpusPaths(source, entry).pipe(
        Effect.flatMap((paths) =>
          Effect.forEach(paths, (path) =>
            loadOne(source, path).pipe(Effect.map((m) => [path, m] as const)),
          ),
        ),
        Effect.map((pairs) => new Map(pairs)),
      )

    return {
      compile: (source: Source, path: Path): Effect.Effect<VirtualCode> =>
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

      tangle: (path: Path): Effect.Effect<ReadonlyArray<TangledFile>, TangleError> =>
        buildCorpus(documents, path).pipe(
          Effect.flatMap((modules) => {
            const scoped = scopedTo(modules, reachable(modules, path))
            const failures = corpusErrors({ modules: scoped }, corpusDiagnostics(scoped))
            return failures.length > 0
              ? Effect.fail(new TangleError({ entry: path, failures }))
              : config
                  .resolve(path)
                  .pipe(
                    Effect.map(({ packageRoot }) =>
                      resolveSinks(scoped, path, Option.fromNullishOr(packageRoot)),
                    ),
                  )
          }),
        ),

      composition: (path: Path): Effect.Effect<ReadonlyArray<ComposedFile>> =>
        buildCorpus(documents, path).pipe(
          Effect.flatMap((modules) =>
            Effect.forEach(Array.fromIterable(modules.values()), (module) =>
              config.resolve(module.path).pipe(
                Effect.map(({ packageRoot }) =>
                  Option.map(Option.fromNullishOr(packageRoot), (root) => [module.path, root] as const),
                ),
              ),
            ).pipe(
              Effect.map((roots) => new Map(Array.getSomes(roots))),
              Effect.flatMap((roots) =>
                Ref.modify(composed, (previous) => {
                  const next = recompose(previous, modules, roots)
                  return [composedFiles(next), next] as const
                }),
              ),
            ),
          ),
        ),

      weave: (path: Path): Effect.Effect<WovenCorpus> =>
        buildCorpus(documents, path).pipe(Effect.flatMap((modules) => weaver.build({ modules }))),

      contents: (path: Path): Effect.Effect<string> =>
        buildCorpus(documents, path).pipe(
          Effect.flatMap((modules) =>
            tocBuilder
              .build({ modules })
              .pipe(Effect.map((toc) => rewriteBook({ modules }, path, toc))),
          ),
        ),

      diagnose: (path: Path): Effect.Effect<ReadonlyArray<Diagnostic>> =>
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

      definition: (path: Path, offset: number): Effect.Effect<FrameLocation | undefined> =>
        buildCorpus(documents, path).pipe(
          Effect.map((modules) =>
            Option.getOrUndefined(
              Option.flatMap(definitionAt({ modules }, path, offset), (loc) =>
                frameLocationOf(modules, loc),
              ),
            ),
          ),
        ),

      references: (path: Path, offset: number): Effect.Effect<ReadonlyArray<FrameLocation>> =>
        buildCorpus(documents, path).pipe(
          Effect.map((modules) =>
            Array.getSomes(
              Array.map(referencesAt({ modules }, path, offset), (loc) =>
                frameLocationOf(modules, loc),
              ),
            ),
          ),
        ),

      rename: (path: Path, offset: number): Effect.Effect<ReadonlyArray<FrameLocation>> =>
        buildCorpus(documents, path).pipe(
          Effect.map((modules) =>
            Array.getSomes(
              Array.map(renameAt({ modules }, path, offset), (loc) =>
                frameLocationOf(modules, loc),
              ),
            ),
          ),
        ),

      renameRange: (path: Path, offset: number): Effect.Effect<FrameLocation | undefined> =>
        buildCorpus(documents, path).pipe(
          Effect.map((modules) =>
            Option.getOrUndefined(
              Option.flatMap(renameRangeAt({ modules }, path, offset), (loc) =>
                frameLocationOf(modules, loc),
              ),
            ),
          ),
        ),

      navigationRange: (path: Path, offset: number): Effect.Effect<FrameLocation | undefined> =>
        buildCorpus(documents, path).pipe(
          Effect.map((modules) =>
            Option.getOrUndefined(
              Option.flatMap(navigationRangeAt({ modules }, path, offset), (loc) =>
                frameLocationOf(modules, loc),
              ),
            ),
          ),
        ),

      semanticTokens: (path: Path): Effect.Effect<ReadonlyArray<FrameToken>> =>
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

      reach: (path: Path): Effect.Effect<ReadonlyArray<Path>> =>
        buildCorpus(documents, path).pipe(
          Effect.map((modules) => Array.filter(reachable(modules, path), (p) => p !== path)),
        ),

      invalidate: (path: Path): Effect.Effect<ReadonlyArray<Path>> =>
        memo.entries.pipe(
          Effect.flatMap((modules) =>
            modules.has(path)
              ? memo
                  .evict([path])
                  .pipe(Effect.as([path, ...transitiveDependents(modules, path)]))
              : Effect.succeed<ReadonlyArray<Path>>([]),
          ),
        ),

      invalidateWithin: (dir: Path): Effect.Effect<ReadonlyArray<Path>> =>
        memo.entries.pipe(
          Effect.map((modules) =>
            Array.filter(Array.fromIterable(modules.keys()), (path) => path.startsWith(`${dir}/`)),
          ),
          Effect.tap((paths) => memo.evict(paths)),
        ),

      rebuild: (source: Source, path: Path): Effect.Effect<boolean> =>
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
        LoomDiskCache.layer,
        WeaveBuilder.layer,
        TableOfContentsBuilder.layer,
      ),
    ),
  )
}
