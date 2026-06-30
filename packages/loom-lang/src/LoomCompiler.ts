import type { CodeMapping, VirtualCode } from '@volar/language-core'
import { Array, Data, Effect, Match, Option, pipe } from 'effect'
import { readFileSync, readdirSync, type Dirent } from 'node:fs'
import { dirname, resolve as resolvePath } from 'node:path'
import type * as ts from 'typescript'
import { type Diagnostic } from '@athrio/loom-ast/LoomNode'
import { LoomCorpusAstBuilder, ReadError, type Source } from '#ast/LoomCorpusAstBuilder'
import {
  corpusErrors,
  definitionAt,
  moduleDiagnostics,
  placeReachable,
  placedModules,
  referencesAt,
  renameAt,
  renameRangeAt,
  sinkTreeFaults,
  sinkTreeRouting,
  tangleSinks,
  transitiveDependents,
  type CorpusLocation,
  type LoomModule,
  type Path,
  type SinkFault,
} from '@athrio/loom-ast/LoomCorpusAst'
import { type FrameLocation } from '@athrio/loom-lang-services/LanguageService'
import {
  CollidingSinks,
  CollidingTitles,
  DuplicateChapter,
  EmptySink,
  faulty,
  MisplacedSpecifier,
  OrphanedOpening,
  PointedNotH1,
  SelfRoutingSink,
  SinkCycle,
  SinklessChapter,
  UnresolvedAnchor,
  type LoomFault,
} from '#ast/LoomFault'
import { normaliseTitle } from '#ast/WeftTokeniser'
import {
  fromProduct,
  fromProse,
  rootNamesAt,
  rootVirtualCode,
  symbolMappings,
} from '#ast/LoomVirtualCodeBuilder'
import { type LoomVirtualCode, type Mapping } from '@athrio/loom-ast/LoomVirtualCode'
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
  Effect.fromNullable(modules.get(path)).pipe(
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

const fileRoot = (
  routed: ReadonlyMap<string, string> | undefined,
  sink: string,
  packageRoot: Option.Option<string>,
  workspaceRoot: Option.Option<string>,
): Option.Option<string> =>
  Option.all([Option.fromNullable(routed?.get(sink)), workspaceRoot]).pipe(
    Option.map(([prefix, workspace]) => resolvePath(workspace, prefix)),
    Option.orElse(() => packageRoot),
  )

const resolveSinks = (
  modules: Modules,
  entry: Path,
  packageRoot: Option.Option<string>,
  workspaceRoot: Option.Option<string>,
): ReadonlyArray<TangledFile> => {
  const routing = sinkTreeRouting({ modules })
  return pipe(
    Array.fromIterable(modules.values()),
    Array.flatMap((module) => {
      const routed = routing.get(module.path)
      return Array.filterMap(module.product.files, (file) =>
        module.path === entry || (routed?.has(file.path) ?? false)
          ? Option.some({
              section: file.code.origin.name,
              path: outputPath(
                fileRoot(routed, file.path, packageRoot, workspaceRoot),
                module.path,
                file.path,
              ),
              content: fromProduct(modules, file.code.origin).code,
            })
          : Option.none(),
      )
    }),
  )
}

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

const wordSinkFault = (fault: SinkFault): LoomFault =>
  Match.value(fault).pipe(
    Match.when({ kind: 'CollidingTitles' }, ({ name }) => CollidingTitles({ name })),
    Match.when({ kind: 'SinkCycle' }, ({ name }) => SinkCycle({ name })),
    Match.when({ kind: 'EmptySink' }, ({ directory }) => EmptySink({ directory })),
    Match.when({ kind: 'MisplacedSpecifier' }, ({ specifier }) =>
      MisplacedSpecifier({ specifier }),
    ),
    Match.when({ kind: 'SelfRoutingSink' }, ({ name }) => SelfRoutingSink({ name })),
    Match.when({ kind: 'SinklessChapter' }, ({ name }) => SinklessChapter({ name })),
    Match.when({ kind: 'PointedNotH1' }, ({ name }) => PointedNotH1({ name })),
    Match.when({ kind: 'OrphanedOpening' }, ({ name }) => OrphanedOpening({ name })),
    Match.when({ kind: 'DuplicateChapter' }, ({ name }) => DuplicateChapter({ name })),
    Match.when({ kind: 'UnresolvedPointing' }, ({ name }) => UnresolvedAnchor({ name })),
    Match.exhaustive,
  )

const sinkDiagnostics = (
  modules: Modules,
): ReadonlyArray<{ readonly path: Path; readonly diagnostic: Diagnostic }> =>
  Array.flatMap(sinkTreeFaults({ modules }, normaliseTitle), (fault) =>
    Array.map(
      faulty(wordSinkFault(fault), fault.position).diagnostics,
      (diagnostic) => ({ path: fault.path, diagnostic }),
    ),
  )

const collisionDiagnostics = (
  config: PackageConfig,
  modules: Modules,
): Effect.Effect<
  ReadonlyArray<{ readonly path: Path; readonly diagnostic: Diagnostic }>
> =>
  Effect.forEach(
    Object.entries(Array.groupBy(tangleSinks({ modules }), (sink) => sink.module)),
    ([module, sinks]) =>
      config.resolve(module).pipe(
        Effect.map(({ packageRoot, workspaceRoot }) => {
          const routed = sinkTreeRouting({ modules }).get(module)
          return Array.map(sinks, (sink) => ({
            module,
            position: sink.position,
            at: outputPath(
              fileRoot(
                routed,
                sink.path,
                Option.fromNullable(packageRoot),
                Option.fromNullable(workspaceRoot),
              ),
              module,
              sink.path,
            ),
          }))
        }),
      ),
  ).pipe(
    Effect.map((perModule) =>
      pipe(
        Array.flatten(perModule),
        Array.groupBy((sink) => sink.at),
        (groups) => Object.values(groups),
        Array.filter((group) => group.length > 1),
        Array.flatMap((group) =>
          Array.flatMap(group, (sink) =>
            Array.map(
              faulty(CollidingSinks({ path: sink.at }), sink.position).diagnostics,
              (diagnostic) => ({ path: sink.module, diagnostic }),
            ),
          ),
        ),
      ),
    ),
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
  Option.map(Option.fromNullable(modules.get(location.path)?.text), (text) => ({
    path: location.path,
    range: {
      start: lineCharAt(text, location.position.start.offset),
      end: lineCharAt(text, location.position.end.offset),
    },
  }))

const namesAt = (modules: Modules, path: Path): ReadonlyArray<string> =>
  pipe(
    Option.fromNullable(modules.get(path)),
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

const featuresOf = (kind: Mapping['kind']): CodeMapping['data'] =>
  Match.value(kind).pipe(
    Match.whenOr('prose', 'heading', 'tag', () => ({
      navigation: true,
      structure: true,
    })),
    Match.when('anchor', () => ({
      verification: true,
      navigation: true,
      structure: true,
    })),
    Match.when('source', () => ({ verification: true })),
    Match.orElse(() => ({
      verification: true,
      completion: true,
      semantic: true,
      navigation: true,
      structure: true,
    })),
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

export class DocumentSource extends Effect.Service<DocumentSource>()(
  'DocumentSource',
  {
    succeed: {
      read: (path: Path): Effect.Effect<string, ReadError> =>
        Effect.try({
          try: () => readFileSync(path, 'utf8'),
          catch: (cause) => new ReadError({ path, cause }),
        }),
      list: Option.some(
        (dir: Path): Effect.Effect<ReadonlyArray<Path>> =>
          Effect.sync(() => loomsUnder(dir)),
      ),
    },
  },
) {}

export class LoomCompiler extends Effect.Service<LoomCompiler>()(
  'LoomCompiler',
  {
    effect: Effect.gen(function* () {
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
              Option.fromNullable(settings.corpusDir),
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
            Effect.catchAllCause((cause) =>
              Effect.logError(
                'loom: projection failed; serving bare document',
                cause,
              ).pipe(
                Effect.zipRight(
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
              const scoped = scopedTo(modules, placeReachable(modules, path))
              return collisionDiagnostics(config, scoped).pipe(
                Effect.flatMap((collisions) => {
                  const sinkErrors = Array.filterMap(
                    sinkDiagnostics(scoped),
                    (d) =>
                      d.diagnostic.severity === 'error'
                        ? Option.some({ path: d.path, diagnostics: [d.diagnostic] })
                        : Option.none(),
                  )
                  const collisionErrors = Array.map(collisions, (d) => ({
                    path: d.path,
                    diagnostics: [d.diagnostic],
                  }))
                  const failures = [
                    ...corpusErrors({ modules: scoped }),
                    ...sinkErrors,
                    ...collisionErrors,
                  ]
                  return failures.length > 0
                    ? Effect.fail(new TangleError({ entry: path, failures }))
                    : config.resolve(path).pipe(
                        Effect.map(({ packageRoot, workspaceRoot }) =>
                          resolveSinks(
                            scoped,
                            path,
                            Option.fromNullable(packageRoot),
                            Option.fromNullable(workspaceRoot),
                          ),
                        ),
                      )
                }),
              )
            }),
          ),

        placed: (path: Path): Effect.Effect<ReadonlySet<Path>> =>
          buildCorpus(documents, path).pipe(
            Effect.map((modules) => placedModules({ modules })),
          ),

        diagnose: (path: Path): Effect.Effect<ReadonlyArray<Diagnostic>> =>
          buildCorpus(documents, path).pipe(
            Effect.flatMap((modules) => {
              const scoped = scopedTo(modules, placeReachable(modules, path))
              return collisionDiagnostics(config, scoped).pipe(
                Effect.map((collisions) =>
                  pipe(
                    Option.fromNullable(modules.get(path)),
                    Option.match({
                      onNone: () => [],
                      onSome: (module) => [
                        ...moduleDiagnostics(module),
                        ...Array.filterMap(sinkDiagnostics(scoped), (d) =>
                          d.path === path ? Option.some(d.diagnostic) : Option.none(),
                        ),
                        ...Array.filterMap(collisions, (d) =>
                          d.path === path ? Option.some(d.diagnostic) : Option.none(),
                        ),
                      ],
                    }),
                  ),
                ),
              )
            }),
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
              Array.filterMap(referencesAt({ modules }, path, offset), (loc) =>
                frameLocationOf(modules, loc),
              ),
            ),
          ),

        rename: (
          path: Path,
          offset: number,
        ): Effect.Effect<ReadonlyArray<FrameLocation>> =>
          buildCorpus(documents, path).pipe(
            Effect.map((modules) =>
              Array.filterMap(renameAt({ modules }, path, offset), (loc) =>
                frameLocationOf(modules, loc),
              ),
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

        reach: (path: Path): Effect.Effect<ReadonlyArray<Path>> =>
          buildCorpus(documents, path).pipe(
            Effect.map((modules) =>
              Array.filter(placeReachable(modules, path), (p) => p !== path),
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
    dependencies: [
      LoomCorpusAstBuilder.Default,
      LoomMemo.Default,
    ],
  },
) {}
