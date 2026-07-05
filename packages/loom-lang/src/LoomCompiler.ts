import type { CodeMapping, VirtualCode } from '@volar/language-core'
import { Array, Context, Data, Effect, Layer, Match, Option, pipe } from 'effect'
import { readFileSync, readdirSync, type Dirent } from 'node:fs'
import { dirname, resolve as resolvePath } from 'node:path'
import type * as ts from 'typescript'
import { type Diagnostic } from '@athrio/loom-ast/LoomNode'
import { LoomCorpusAstBuilder, ReadError, type Source } from '#ast/LoomCorpusAstBuilder'
import {
  corpusErrors,
  definitionAt,
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
import { PackageConfig } from './PackageConfig'

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

export interface TangledFile {
  readonly section: string
  readonly path: Path
  readonly content: string
}

const outputPath = (
  packageRoot: Option.Option<string>,
  entry: Path,
  sink: string,
): Path =>
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
      f.diagnostics.map(
        (d) => `  ${f.path}:${d.position.start.line}: ${d.message}`,
      ),
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

const headingLocationOf = (
  modules: Modules,
  module: LoomModule,
  name: string,
): FrameLocation =>
  pipe(
    Array.findFirst(
      module.doc.sections,
      (section) => normaliseTitle(section.heading.title?.source ?? '') === name,
    ),
    Option.flatMapNullishOr((section) => section.heading.title),
    Option.flatMap((title) =>
      frameLocationOf(modules, { path: module.path, position: title.position }),
    ),
    Option.getOrElse(
      (): FrameLocation => ({
        path: module.path,
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
      }),
    ),
  )

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
  return Array.filter(namesAt(modules, path), (name) =>
    roots.has(name.toLowerCase()),
  )
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
    Match.when('source', () => ({ verification: true })),
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

const ignoredDir = new Set(['node_modules', '.loom', 'dist', '.git'])

const entriesIn = (dir: Path): ReadonlyArray<Dirent> => {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

export const loomsUnder = (dir: Path): ReadonlyArray<Path> =>
  Array.flatMap(entriesIn(dir), (entry) => {
    const full = resolvePath(dir, entry.name)
    return Match.value(entry).pipe(
      Match.when(
        (e) => ignoredDir.has(e.name),
        (): ReadonlyArray<Path> => [],
      ),
      Match.when((e) => e.isDirectory(), () => loomsUnder(full)),
      Match.when((e) => e.name.endsWith('.loom'), () => [full]),
      Match.orElse((): ReadonlyArray<Path> => []),
    )
  })

export class DocumentSource extends Context.Service<DocumentSource>()(
  'DocumentSource',
  {
    make: Effect.succeed({
      read: (path: Path): Effect.Effect<string, ReadError> =>
        Effect.try({
          try: () => readFileSync(path, 'utf8'),
          catch: (cause) => new ReadError({ path, cause }),
        }),
      list: Option.some(
        (dir: Path): Effect.Effect<ReadonlyArray<Path>> =>
          Effect.sync(() => loomsUnder(dir)),
      ),
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make)
}

export class LoomCompiler extends Context.Service<LoomCompiler>()(
  'LoomCompiler',
  {
    make: Effect.gen(function* () {
      const documents = yield* DocumentSource
      const builder = yield* LoomCorpusAstBuilder
      const memo = yield* LoomMemo
      const config = yield* PackageConfig

      const loadOne = (source: Source, path: Path): Effect.Effect<LoomModule> =>
        config.resolve(path).pipe(
          Effect.flatMap(({ delims, primaryLanguage }) =>
            memo.get(path, builder.build(source, path, delims, primaryLanguage)),
          ),
        )

      const listFrom = (
        list: (dir: Path) => Effect.Effect<ReadonlyArray<Path>>,
        entry: Path,
      ): Effect.Effect<ReadonlyArray<Path>> =>
        config.resolve(entry).pipe(
          Effect.map((settings) =>
            Option.getOrElse(
              Option.fromNullishOr(settings.corpusDir),
              () => dirname(entry),
            ),
          ),
          Effect.flatMap(list),
          Effect.map((found) => Array.dedupe([entry, ...found])),
        )

      const corpusPaths = (
        source: Source,
        entry: Path,
      ): Effect.Effect<ReadonlyArray<Path>> =>
        Option.match(source.list, {
          onNone: () => Effect.succeed<ReadonlyArray<Path>>([entry]),
          onSome: (list) => listFrom(list, entry),
        })

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
          buildCorpus(source, path).pipe(
            Effect.flatMap((modules) => entryOf(modules, path)),
            Effect.map(({ modules, entry }) =>
              toVolar(projectTree(modules, entry)),
            ),
            Effect.catchCause((cause) =>
              Effect.logError(
                'loom: projection failed; serving bare document',
                cause,
              ).pipe(
                Effect.andThen(
                  source.read(path).pipe(
                    Effect.orElseSucceed(() => ''),
                    Effect.map((text) => toVolar(rootVirtualCode(text, []))),
                  ),
                ),
              ),
            ),
          ),

        tangle: (
          path: Path,
        ): Effect.Effect<ReadonlyArray<TangledFile>, TangleError> =>
          buildCorpus(documents, path).pipe(
            Effect.flatMap((modules) => {
              const scoped = scopedTo(modules, reachable(modules, path))
              const failures = corpusErrors({ modules: scoped })
              return failures.length > 0
                ? Effect.fail(new TangleError({ entry: path, failures }))
                : config.resolve(path).pipe(
                    Effect.map(({ packageRoot }) =>
                      resolveSinks(scoped, path, Option.fromNullishOr(packageRoot)),
                    ),
                  )
            }),
          ),

        composition: (path: Path): Effect.Effect<ReadonlyArray<ComposedFile>> =>
          buildCorpus(documents, path).pipe(
            Effect.flatMap((modules) =>
              Effect.forEach(
                Array.fromIterable(modules.values()),
                (module) =>
                  config.resolve(module.path).pipe(
                    Effect.map(({ packageRoot }) =>
                      Array.map(
                        module.product.files,
                        (file): ComposedFile => ({
                          path: outputPath(
                            Option.fromNullishOr(packageRoot),
                            module.path,
                            file.path,
                          ),
                          content: fromProduct(modules, file.code.origin).code,
                          loomPath: module.path,
                          rootId: file.code.origin.name.toLowerCase(),
                          heading: headingLocationOf(modules, module, file.code.origin.name),
                        }),
                      ),
                    ),
                  ),
                { concurrency: 'unbounded' },
              ).pipe(Effect.map(Array.flatten))
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
                    ...moduleDiagnostics(module),
                    ...Array.flatMap(
                      unresolvedTocEntriesIn({ modules }, module),
                      (title) =>
                        faulty(
                          UnresolvedTocEntry({ title: title.value }),
                          title.position,
                        ).diagnostics,
                    ),
                  ],
                }),
              ),
            ),
          ),

        definition: (
          path: Path,
          offset: number,
        ): Effect.Effect<FrameLocation | undefined> =>
          buildCorpus(documents, path).pipe(
            Effect.map((modules) =>
              Option.getOrUndefined(
                Option.flatMap(definitionAt({ modules }, path, offset), (loc) =>
                  frameLocationOf(modules, loc),
                ),
              ),
            ),
          ),

        references: (
          path: Path,
          offset: number,
        ): Effect.Effect<ReadonlyArray<FrameLocation>> =>
          buildCorpus(documents, path).pipe(
            Effect.map((modules) =>
              Array.getSomes(Array.map(referencesAt({ modules }, path, offset), (loc) =>
                frameLocationOf(modules, loc),
              )),
            ),
          ),

        rename: (
          path: Path,
          offset: number,
        ): Effect.Effect<ReadonlyArray<FrameLocation>> =>
          buildCorpus(documents, path).pipe(
            Effect.map((modules) =>
              Array.getSomes(Array.map(renameAt({ modules }, path, offset), (loc) =>
                frameLocationOf(modules, loc),
              )),
            ),
          ),

        renameRange: (
          path: Path,
          offset: number,
        ): Effect.Effect<FrameLocation | undefined> =>
          buildCorpus(documents, path).pipe(
            Effect.map((modules) =>
              Option.getOrUndefined(
                Option.flatMap(renameRangeAt({ modules }, path, offset), (loc) =>
                  frameLocationOf(modules, loc),
                ),
              ),
            ),
          ),

        navigationRange: (
          path: Path,
          offset: number,
        ): Effect.Effect<FrameLocation | undefined> =>
          buildCorpus(documents, path).pipe(
            Effect.map((modules) =>
              Option.getOrUndefined(
                Option.flatMap(
                  navigationRangeAt({ modules }, path, offset),
                  (loc) => frameLocationOf(modules, loc),
                ),
              ),
            ),
          ),

        semanticTokens: (
          path: Path,
        ): Effect.Effect<ReadonlyArray<FrameToken>> =>
          buildCorpus(documents, path).pipe(
            Effect.map((modules) =>
              pipe(
                Option.fromNullishOr(modules.get(path)),
                Option.match({
                  onNone: () => [],
                  onSome: (module) =>
                    Array.getSomes(Array.map(symbolsOf(module.doc), (symbol) =>
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
                    )),
                }),
              ),
            ),
          ),

        reach: (path: Path): Effect.Effect<ReadonlyArray<Path>> =>
          buildCorpus(documents, path).pipe(
            Effect.map((modules) =>
              Array.filter(reachable(modules, path), (p) => p !== path),
            ),
          ),

        invalidate: (path: Path): Effect.Effect<ReadonlyArray<Path>> =>
          Effect.gen(function* () {
            const modules = yield* memo.entries
            const dependents = transitiveDependents(modules, path)
            yield* memo.evict([path])
            return [path, ...dependents]
          }),
      }
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make).pipe(
    Layer.provide(Layer.mergeAll(LoomCorpusAstBuilder.layer, LoomMemo.layer)),
  )
}
