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

      const ensureModules = (
        source: Source,
        entry: Path,
      ): Effect.Effect<ReadonlyMap<Path, LoomModule>> =>
        load(source, entry).pipe(Effect.zipRight(memo.entries))

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
            Effect.flatMap(({ modules, entry }) => {
              const codeByPath = codeOf(modules)
              return Effect.forEach(
                Array.fromIterable(entry.code.values()),
                (node) => vcb.fromProduct(codeByPath, node.origin),
              )
            }),
          ),

        corpus: (entry: Path): Effect.Effect<LoomCorpusAst> =>
          ensureModules(documents, entry).pipe(
            Effect.map((modules) => ({ modules })),
          ),

        virtualCode: (source: Source, path: Path): Effect.Effect<VirtualCode> =>
          ensureEntry(source, path).pipe(
            Effect.map(({ modules, entry }) =>
              toVolar(projectTree(codeOf(modules), entry)),
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
    ],
  },
) {}

const projectTree = (
  codeByPath: CodeByPath,
  entry: LoomModule,
): LoomVirtualCode =>
  rootVirtualCode(entry.text, [
    fromFrame(entry.frame),
    ...pipe(
      Array.fromIterable(entry.code.values()),
      Array.map((node) => fromProduct(codeByPath, node.origin)),
    ),
  ])

export const codeOf = (modules: ReadonlyMap<Path, LoomModule>): CodeByPath =>
  new Map(
    Array.map(Array.fromIterable(modules), ([p, m]) => [p, m.code] as const),
  )
