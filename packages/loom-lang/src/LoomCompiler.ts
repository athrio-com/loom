import type { CodeMapping, VirtualCode } from '@volar/language-core'
import { Array, Data, Effect, Match, Option, pipe } from 'effect'
import { readFileSync } from 'node:fs'
import { dirname, resolve as resolvePath } from 'node:path'
import type * as ts from 'typescript'
import type { Product } from '@athrio/loom-ast/ProductAst'
import { type Diagnostic } from '@athrio/loom-ast/LoomNode'
import { LoomCorpusAstBuilder, ReadError, type Source } from '#ast/LoomCorpusAstBuilder'
import {
  corpusErrors,
  definitionAt,
  moduleDiagnostics,
  referencesAt,
  sinkTreeFaults,
  sinkTreeRouting,
  transitiveDependents,
  type CorpusLocation,
  type LoomModule,
  type Path,
  type SinkFault,
} from '@athrio/loom-ast/LoomCorpusAst'
import { type FrameLocation } from '@athrio/loom-lang-services/LanguageService'
import {
  CollidingTitles,
  EmptySink,
  faulty,
  MisplacedSpecifier,
  SinkCycle,
  UnresolvedReroute,
  type LoomFault,
} from '#ast/LoomFault'
import { normaliseTitle } from '#ast/WeftTokeniser'
import {
  fromFrame,
  fromProduct,
  rootNamesAt,
  rootVirtualCode,
} from '#ast/LoomVirtualCodeBuilder'
import { type LoomVirtualCode, type Mapping } from '@athrio/loom-ast/LoomVirtualCode'
import { FrameRunner } from '#ast/FrameRunner'
import { LoomMemo } from './LoomMemo'
import { PackageConfig } from './PackageConfig'

type Modules = ReadonlyMap<Path, LoomModule>

const reachableFrom = (modules: Modules, entry: Path): Modules => {
  const visit = (acc: Modules, path: Path): Modules => {
    if (acc.has(path)) return acc
    const m = modules.get(path)
    return m === undefined
      ? acc
      : Array.reduce(m.imports, new Map(acc).set(path, m), visit)
  }
  return visit(new Map<Path, LoomModule>(), entry)
}

const emptyProduct: Product = { code: [], files: [] }

const framesOf = (modules: Modules): ReadonlyMap<Path, string> =>
  new Map(
    Array.map(
      Array.fromIterable(modules),
      ([p, m]) => [p, fromFrame(m.frame).code] as const,
    ),
  )

const withProducts = (
  modules: Modules,
  products: ReadonlyMap<Path, Product>,
): Modules =>
  new Map(
    Array.map(
      Array.fromIterable(modules),
      ([p, m]) => [p, { ...m, product: products.get(p) ?? emptyProduct }] as const,
    ),
  )

const allProduced = (modules: Modules): boolean =>
  Array.every(
    Array.fromIterable(modules.values()),
    (m) => m.product !== undefined,
  )

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

const sinkRoot = (
  modules: Modules,
  entry: Path,
  packageRoot: Option.Option<string>,
  workspaceRoot: Option.Option<string>,
): Option.Option<string> =>
  Option.all([
    Option.fromNullable(sinkTreeRouting({ modules }).get(entry)),
    workspaceRoot,
  ]).pipe(
    Option.map(([routed, workspace]) => resolvePath(workspace, routed)),
    Option.orElse(() => packageRoot),
  )

const resolveSinks = (
  modules: Modules,
  entry: Path,
  packageRoot: Option.Option<string>,
): ReadonlyArray<TangledFile> =>
  pipe(
    modules.get(entry)?.product?.files ?? [],
    Array.map((file) => ({
      section: file.code.origin.name,
      path: outputPath(packageRoot, entry, file.path),
      content: fromProduct(modules, file.code.origin).code,
    })),
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

const wordSinkFault = (fault: SinkFault): LoomFault =>
  Match.value(fault).pipe(
    Match.when({ kind: 'CollidingTitles' }, ({ name }) => CollidingTitles({ name })),
    Match.when({ kind: 'SinkCycle' }, ({ name }) => SinkCycle({ name })),
    Match.when({ kind: 'EmptySink' }, ({ directory }) => EmptySink({ directory })),
    Match.when({ kind: 'UnresolvedReroute' }, ({ directory }) =>
      UnresolvedReroute({ directory }),
    ),
    Match.when({ kind: 'MisplacedSpecifier' }, ({ specifier }) =>
      MisplacedSpecifier({ specifier }),
    ),
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

const namesAt = (modules: Modules, path: Path): ReadonlyArray<string> => {
  const product = modules.get(path)?.product
  return product === undefined
    ? []
    : Array.map(product.code, (c) => c.origin.name)
}

const rootsAt = (modules: Modules, path: Path): ReadonlyArray<string> => {
  const roots = rootNamesAt(modules, path)
  return Array.filter(namesAt(modules, path), (name) =>
    roots.has(name.toLowerCase()),
  )
}

const projectTree = (modules: Modules, entry: LoomModule): LoomVirtualCode =>
  rootVirtualCode(entry.text, [
    fromFrame(entry.frame),
    ...pipe(
      rootsAt(modules, entry.path),
      Array.map((name) => fromProduct(modules, { path: entry.path, name })),
    ),
  ])

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

export class DocumentSource extends Effect.Service<DocumentSource>()(
  'DocumentSource',
  {
    succeed: {
      read: (path: Path): Effect.Effect<string, ReadError> =>
        Effect.try({
          try: () => readFileSync(path, 'utf8'),
          catch: (cause) => new ReadError({ path, cause }),
        }),
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
      const frames = yield* FrameRunner

      const load = (source: Source, path: Path): Effect.Effect<void> =>
        config.resolve(path).pipe(
          Effect.flatMap(({ delims, primaryLanguage }) =>
            memo.get(path, builder.build(source, path, delims, primaryLanguage)),
          ),
          Effect.flatMap((m) =>
            Effect.forEach(m.imports, (dep) => load(source, dep), {
              discard: true,
            }),
          ),
        )

      const buildCorpus = (source: Source, entry: Path): Effect.Effect<Modules> =>
        load(source, entry).pipe(
          Effect.zipRight(memo.entries),
          Effect.map((all) => reachableFrom(all, entry)),
        )

      const produceCorpus = (
        source: Source,
        entry: Path,
      ): Effect.Effect<Modules> =>
        buildCorpus(source, entry).pipe(
          Effect.flatMap((modules) =>
            allProduced(modules)
              ? Effect.succeed(modules)
              : frames.produce(framesOf(modules)).pipe(
                  Effect.map((products) => withProducts(modules, products)),
                  Effect.tap(memo.fill),
                ),
          ),
        )

      return {
        compile: (source: Source, path: Path): Effect.Effect<VirtualCode> =>
          produceCorpus(source, path).pipe(
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
          produceCorpus(documents, path).pipe(
            Effect.flatMap((modules) => {
              const sinkErrors = Array.filterMap(sinkDiagnostics(modules), (d) =>
                d.diagnostic.severity === 'error'
                  ? Option.some({ path: d.path, diagnostics: [d.diagnostic] })
                  : Option.none(),
              )
              const failures = [...corpusErrors({ modules }), ...sinkErrors]
              return failures.length > 0
                ? Effect.fail(new TangleError({ entry: path, failures }))
                : config.resolve(path).pipe(
                    Effect.map(({ packageRoot, workspaceRoot }) =>
                      resolveSinks(
                        modules,
                        path,
                        sinkRoot(
                          modules,
                          path,
                          Option.fromNullable(packageRoot),
                          Option.fromNullable(workspaceRoot),
                        ),
                      ),
                    ),
                  )
            }),
          ),

        diagnose: (path: Path): Effect.Effect<ReadonlyArray<Diagnostic>> =>
          buildCorpus(documents, path).pipe(
            Effect.map((modules) =>
              pipe(
                Option.fromNullable(modules.get(path)),
                Option.match({
                  onNone: () => [],
                  onSome: (module) => [
                    ...moduleDiagnostics(module),
                    ...Array.filterMap(sinkDiagnostics(modules), (d) =>
                      d.path === path ? Option.some(d.diagnostic) : Option.none(),
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
              Array.filterMap(referencesAt({ modules }, path, offset), (loc) =>
                frameLocationOf(modules, loc),
              ),
            ),
          ),

        reach: (path: Path): Effect.Effect<ReadonlyArray<Path>> =>
          buildCorpus(documents, path).pipe(
            Effect.map((modules) =>
              Array.filter(
                Array.fromIterable(modules.keys()),
                (p) => p !== path,
              ),
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
      FrameRunner.Default,
    ],
  },
) {}
