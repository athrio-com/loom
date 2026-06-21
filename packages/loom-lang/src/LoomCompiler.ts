import type { CodeMapping, VirtualCode } from '@volar/language-core'
import { Array, Effect, pipe } from 'effect'
import { readFileSync } from 'node:fs'
import type * as ts from 'typescript'
import type { FrameModule } from '#ast/FrameAst'
import { LoomCorpusAstBuilder, ReadError, type Source } from '#ast/LoomCorpusAstBuilder'
import {
  type LoomCorpusAst,
  type LoomModule,
  type Path,
  transitiveDependents,
} from '#ast/LoomCorpusAst'
import {
  type CodeByPath,
  fromFrame,
  fromProduct,
  LoomVirtualCodeBuilder,
  rootVirtualCode,
} from '#ast/LoomVirtualCodeBuilder'
import { type LoomVirtualCode, type Mapping } from '#ast/LoomVirtualCode'
import { LoomRunner, type RunOutput } from '#ast/FrameRunner'
import { LoomMemo } from './LoomMemo'
import { PackageConfig } from './PackageConfig'

export const stringSnapshot = (text: string): ts.IScriptSnapshot => ({
  getText: (start, end) => text.slice(start, end),
  getLength: () => text.length,
  getChangeRange: () => undefined,
})

const featuresOf = (kind: Mapping['kind']): CodeMapping['data'] =>
  kind === 'prose' || kind === 'heading' || kind === 'tag'
    ? { navigation: true, structure: true }
    : kind === 'anchor'
      ? { verification: true, navigation: true, structure: true }
      : {
          verification: true,
          completion: true,
          semantic: true,
          navigation: true,
          structure: true,
        }

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
      const vcb = yield* LoomVirtualCodeBuilder
      const memo = yield* LoomMemo
      const config = yield* PackageConfig
      const runner = yield* LoomRunner

      const load = (source: Source, path: Path): Effect.Effect<void> =>
        config.anchorDelims(path).pipe(
          Effect.flatMap((delims) =>
            memo.get(path, builder.build(source, path, delims)),
          ),
          Effect.flatMap((m) =>
            Effect.forEach(m.imports, (dep) => load(source, dep), {
              discard: true,
            }),
          ),
        )

      const runCorpus = (
        modules: ReadonlyMap<Path, LoomModule>,
      ): Effect.Effect<RunOutput> =>
        runner.run(
          new Map(
            Array.map(
              Array.fromIterable(modules),
              ([p, m]) => [p, fromFrame(m.frame).code] as const,
            ),
          ),
        )

      const ensureModules = (
        source: Source,
        entry: Path,
      ): Effect.Effect<ReadonlyMap<Path, LoomModule>> =>
        load(source, entry).pipe(
          Effect.zipRight(memo.entries),
          Effect.map((all) => reachableFrom(all, entry)),
        )

      const ensureEntry = (
        source: Source,
        path: Path,
      ): Effect.Effect<{
        readonly modules: ReadonlyMap<Path, LoomModule>
        readonly entry: LoomModule
      }> =>
        ensureModules(source, path).pipe(
          Effect.flatMap((modules) =>
            Effect.fromNullable(modules.get(path)).pipe(
              Effect.orDie,
              Effect.map((entry) => ({ modules, entry })),
            ),
          ),
        )

      return {
        frame: (path: Path): Effect.Effect<FrameModule> =>
          ensureEntry(documents, path).pipe(Effect.map(({ entry }) => entry.frame)),

        code: (path: Path): Effect.Effect<ReadonlyArray<LoomVirtualCode>> =>
          ensureEntry(documents, path).pipe(
            Effect.flatMap(({ modules, entry }) =>
              runCorpus(modules).pipe(
                Effect.flatMap((out) =>
                  Effect.forEach(namesAt(out.code, entry.path), (name) =>
                    vcb.fromProduct(out.code, { path: entry.path, name }),
                  ),
                ),
              ),
            ),
          ),

        corpus: (entry: Path): Effect.Effect<LoomCorpusAst> =>
          ensureModules(documents, entry).pipe(
            Effect.map((modules) => ({ modules })),
          ),

        composed: (
          entry: Path,
        ): Effect.Effect<{
          readonly corpus: LoomCorpusAst
          readonly output: RunOutput
        }> =>
          ensureModules(documents, entry).pipe(
            Effect.flatMap((modules) =>
              runCorpus(modules).pipe(
                Effect.map((output) => ({ corpus: { modules }, output })),
              ),
            ),
          ),

        virtualCode: (source: Source, path: Path): Effect.Effect<VirtualCode> =>
          ensureEntry(source, path).pipe(
            Effect.flatMap(({ modules, entry }) =>
              runCorpus(modules).pipe(
                Effect.map((out) => toVolar(projectTree(out.code, entry))),
              ),
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

        change: (path: Path): Effect.Effect<ReadonlyArray<Path>> =>
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
      LoomVirtualCodeBuilder.Default,
      LoomMemo.Default,
      LoomRunner.Default,
    ],
  },
) {}

const namesAt = (codeByPath: CodeByPath, path: Path): ReadonlyArray<string> =>
  Array.fromIterable((codeByPath.get(path) ?? new Map<string, never>()).keys())

const projectTree = (
  codeByPath: CodeByPath,
  entry: LoomModule,
): LoomVirtualCode =>
  rootVirtualCode(entry.text, [
    fromFrame(entry.frame),
    ...pipe(
      namesAt(codeByPath, entry.path),
      Array.map((name) => fromProduct(codeByPath, { path: entry.path, name })),
    ),
  ])

const reachableFrom = (
  modules: ReadonlyMap<Path, LoomModule>,
  entry: Path,
): ReadonlyMap<Path, LoomModule> => {
  const visit = (
    acc: ReadonlyMap<Path, LoomModule>,
    path: Path,
  ): ReadonlyMap<Path, LoomModule> => {
    if (acc.has(path)) return acc
    const m = modules.get(path)
    return m === undefined
      ? acc
      : Array.reduce(m.imports, new Map(acc).set(path, m), visit)
  }
  return visit(new Map<Path, LoomModule>(), entry)
}
