import type { CodeMapping, VirtualCode } from '@volar/language-core'
import { Array, Effect, pipe } from 'effect'
import { FileSystem } from '@effect/platform'
import type * as ts from 'typescript'
import type { FrameModule } from '#ast/FrameAst'
import { LoomCorpusAstBuilder, type Source } from '#ast/LoomCorpusAstBuilder'
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
  kind === 'prose' || kind === 'heading'
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
    effect: Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      return {
        read: (path: Path): Effect.Effect<string> =>
          fs.readFileString(path).pipe(Effect.orDie),
      }
    }),
  },
) {}

export class LoomCompiler extends Effect.Service<LoomCompiler>()(
  'LoomCompiler',
  {
    effect: Effect.gen(function* () {
      const source = yield* DocumentSource
      const builder = yield* LoomCorpusAstBuilder
      const vcb = yield* LoomVirtualCodeBuilder
      const memo = yield* LoomMemo
      const config = yield* PackageConfig

      const load = (path: Path): Effect.Effect<void> =>
        config.anchorDelims(path).pipe(
          Effect.flatMap((delims) =>
            memo.get(path, builder.build(source, path, delims)),
          ),
          Effect.flatMap((m) =>
            Effect.forEach(m.imports, (dep) => load(dep), { discard: true }),
          ),
        )

      const ensureModules = (
        entry: Path,
      ): Effect.Effect<ReadonlyMap<Path, LoomModule>> =>
        load(entry).pipe(Effect.zipRight(memo.entries))

      const ensureEntry = (
        path: Path,
      ): Effect.Effect<{
        readonly modules: ReadonlyMap<Path, LoomModule>
        readonly entry: LoomModule
      }> =>
        ensureModules(path).pipe(
          Effect.flatMap((modules) =>
            Effect.fromNullable(modules.get(path)).pipe(
              Effect.orDie,
              Effect.map((entry) => ({ modules, entry })),
            ),
          ),
        )

      return {
        frame: (path: Path): Effect.Effect<FrameModule> =>
          ensureEntry(path).pipe(Effect.map(({ entry }) => entry.frame)),

        code: (path: Path): Effect.Effect<ReadonlyArray<LoomVirtualCode>> =>
          ensureEntry(path).pipe(
            Effect.flatMap(({ modules, entry }) => {
              const codeByPath = codeOf(modules)
              return Effect.forEach(
                Array.fromIterable(entry.code.values()),
                (node) => vcb.fromProduct(codeByPath, node.origin),
              )
            }),
          ),

        corpus: (entry: Path): Effect.Effect<LoomCorpusAst> =>
          ensureModules(entry).pipe(Effect.map((modules) => ({ modules }))),

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

const singleFileSource = (text: string): Source => ({
  read: () => Effect.succeed(text),
})

export const loomVirtualCode = (
  snapshot: ts.IScriptSnapshot,
): Effect.Effect<VirtualCode, never, LoomCorpusAstBuilder> =>
  Effect.gen(function* () {
    const builder = yield* LoomCorpusAstBuilder

    const text = snapshot.getText(0, snapshot.getLength())
    const mod = yield* builder.build(singleFileSource(text), '')

    const codeByPath: CodeByPath = new Map([['', mod.code]])
    const sections = pipe(
      Array.fromIterable(mod.code.values()),
      Array.map((node) => fromProduct(codeByPath, node.origin)),
    )
    return rootVirtualCode(text, [fromFrame(mod.frame), ...sections])
  }).pipe(
    Effect.map(toVolar),
    Effect.catchAllCause((cause) =>
      Effect.logError('loom: projection failed; serving bare document', cause).pipe(
        Effect.as(
          toVolar(
            rootVirtualCode(snapshot.getText(0, snapshot.getLength()), []),
          ),
        ),
      ),
    ),
  )

export const codeOf = (modules: ReadonlyMap<Path, LoomModule>): CodeByPath =>
  new Map(
    Array.map(Array.fromIterable(modules), ([p, m]) => [p, m.code] as const),
  )
