import type { CodeMapping, VirtualCode } from '@volar/language-core'
import { Array, Effect, Option, pipe } from 'effect'
import { FileSystem } from '@effect/platform'
import { dirname, resolve as resolvePath } from 'node:path'
import type * as ts from 'typescript'
import { Loom } from '#ast/Loom'
import type { FrameModule } from '#ast/FrameAst'
import { FrameAstBuilder } from '#ast/FrameAstBuilder'
import { buildCode } from '#ast/ProductAstBuilder'
import { LoomCorpusAstBuilder } from '#ast/LoomCorpusAstBuilder'
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

// =============================================================================
// LoomCompiler — the editor edge. It owns the I/O seam (`DocumentSource`),
// drives the spine (`LoomCorpusAstBuilder`) and the projection
// (`LoomVirtualCodeBuilder`), caches the loaded module set, and answers the editor
// in models: the de dicto `frame`, the de re `code` virtual codes, the whole
// `corpus`, and the `change` invalidation set. Every method takes and returns a
// model; the only thing here that is not a model is Volar's own `VirtualCode`, and
// `toVolar` is the lone adapter that produces it.
//
// Read top-down: the Volar adapter → the I/O seam → the cached compiler → the
// single-file editor entry → the cache leaves.
// =============================================================================

// =============================================================================
// toVolar — the one adapter to Volar's runtime types. A `LoomVirtualCode` is plain
// data; Volar wants a function-based `IScriptSnapshot` and its own `CodeMapping`,
// neither of which is serialisable. Derive both here — the only place that touches
// Volar's shapes — recursively down the embedded tree.
// =============================================================================

// stringSnapshot — a minimal IScriptSnapshot over a string (Volar's unit of text).
export const stringSnapshot = (text: string): ts.IScriptSnapshot => ({
  getText: (start, end) => text.slice(start, end),
  getLength: () => text.length,
  getChangeRange: () => undefined,
})

// featuresOf — kind → which language-service features Volar forwards at the span.
// Prose (titles, preambles) is locate-only; names and product code get the full set.
const featuresOf = (kind: Mapping['kind']): CodeMapping['data'] =>
  kind === 'prose'
    ? { navigation: true, structure: true }
    : {
        verification: true,
        completion: true,
        semantic: true,
        navigation: true,
        structure: true,
      }

// toCodeMapping — our Mapping (a `.loom` source span ⟷ a generated span) → Volar's.
const toCodeMapping = (m: Mapping): CodeMapping => ({
  sourceOffsets: [m.source.start.offset],
  generatedOffsets: [m.genStart],
  lengths: [m.source.end.offset - m.source.start.offset],
  generatedLengths: [m.genLength],
  data: featuresOf(m.kind),
})

// toVolar — LoomVirtualCode → Volar VirtualCode: snapshot from `code`, CodeMappings
// from `mappings`, children converted in turn.
export const toVolar = (vc: LoomVirtualCode): VirtualCode => ({
  id: vc.id,
  languageId: vc.languageId,
  snapshot: stringSnapshot(vc.code),
  mappings: Array.map(vc.mappings, toCodeMapping),
  embeddedCodes: Array.map(vc.embeddedCodes, toVolar),
})

// =============================================================================
// DocumentSource — the one effectful seam: bytes by path, and `.loom` specifier →
// resolved path. The edge owns it. A free requirement: the CLI root provides the
// filesystem default, the LSP a Volar document host, a test a fake in-memory
// source. (Conforms to the spine's abstract `Source`.)
// =============================================================================

export class DocumentSource extends Effect.Service<DocumentSource>()(
  'DocumentSource',
  {
    effect: Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      return {
        read: (path: Path): Effect.Effect<string> =>
          fs.readFileString(path).pipe(Effect.orDie),
        resolve: (from: Path, specifier: string): Option.Option<Path> =>
          specifier.endsWith('.loom')
            ? Option.some(resolvePath(dirname(from), specifier))
            : Option.none(),
      }
    }),
  },
) {}

// =============================================================================
// LoomCompiler — memoises the loaded module set (in `LoomMemo`) over the
// DocumentSource, and answers in models: the built `frame`, the `code` de re
// virtual codes (one
// per section, cross-file `{{…}}` followed through the corpus), the whole `corpus`,
// and the files to refresh on a `change`. Building is the `LoomCorpusAstBuilder`;
// projecting is the `LoomVirtualCodeBuilder`.
// =============================================================================

export class LoomCompiler extends Effect.Service<LoomCompiler>()(
  'LoomCompiler',
  {
    effect: Effect.gen(function* () {
      const source = yield* DocumentSource
      const builder = yield* LoomCorpusAstBuilder
      const vcb = yield* LoomVirtualCodeBuilder
      const memo = yield* LoomMemo

      // load `path` and its transitive imports into the memo. Cycle-safe: a module
      // is kept (the `get` stores it) before its imports are walked, so a cyclic
      // re-entry is a hit, not a rebuild.
      const load = (path: Path): Effect.Effect<void> =>
        memo.get(path, builder.build(source, path)).pipe(
          Effect.flatMap((m) =>
            Effect.forEach(m.imports, (dep) => load(dep), { discard: true }),
          ),
        )

      // the kept corpus reachable from `entry`, loading it first.
      const ensureModules = (
        entry: Path,
      ): Effect.Effect<ReadonlyMap<Path, LoomModule>> =>
        load(entry).pipe(Effect.zipRight(memo.entries))

      // the loaded corpus plus the entry module it guarantees. After `load` the
      // entry is always present, so an absent one is an invariant break (a defect
      // via `orDie`), not a recoverable error.
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
        // de dicto — the file's built frame.
        frame: (path: Path): Effect.Effect<FrameModule> =>
          ensureEntry(path).pipe(Effect.map(({ entry }) => entry.frame)),

        // de re — the file's product virtual codes, projected from the corpus so
        // cross-file `{{…}}` resolves. One per section, keyed by its name.
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

        // the whole corpus data `{ modules }` reachable from `entry` — each module
        // carries its own `code` (de re), so the cross-file graph is distributed.
        corpus: (entry: Path): Effect.Effect<LoomCorpusAst> =>
          ensureModules(entry).pipe(Effect.map((modules) => ({ modules }))),

        // a file changed: evict it (rebuilds on next access) and report the set to
        // refresh — itself plus its transitive dependents, whose de re inlined its
        // code. Their modules stay valid; only their de re re-projects.
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

// =============================================================================
// loomVirtualCode — the single-file editor entry. Volar's hooks are synchronous
// and hand us a snapshot, so this projects one `.loom` to its Volar tree without
// the corpus: parse → `FrameAstBuilder` → `buildCode` → `fromFrame` (frame) + `fromProduct`
// (each section) → assemble → `toVolar`. A lone file is a corpus of one — no
// imports, so nothing crosses a boundary; cross-file editing arrives when the
// snapshot is served through a Volar-backed DocumentSource. Total by construction:
// any failure is logged and degraded to a bare `loom` document, never thrown.
// =============================================================================

export const loomVirtualCode = (
  snapshot: ts.IScriptSnapshot,
): Effect.Effect<VirtualCode, never, Loom | FrameAstBuilder> =>
  Effect.gen(function* () {
    const loom = yield* Loom
    const frameBuilder = yield* FrameAstBuilder

    const text = snapshot.getText(0, snapshot.getLength())
    const document = yield* loom.ast(text)
    const frame = yield* frameBuilder.build(document)

    const code = buildCode({ path: '', text, frame, imports: new Map() })
    const codeByPath: CodeByPath = new Map([['', code]])

    const sections = pipe(
      Array.fromIterable(code.values()),
      Array.map((node) => fromProduct(codeByPath, node.origin)),
    )
    return rootVirtualCode(text, [fromFrame(frame), ...sections])
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

// =============================================================================
// Cache leaves — total module lookup, the corpus `code` view, and cache eviction.
// =============================================================================

// codeOf — each module's `code` map indexed by path, the view `fromProduct` walks.
const codeOf = (modules: ReadonlyMap<Path, LoomModule>): CodeByPath =>
  new Map(
    Array.map(Array.fromIterable(modules), ([p, m]) => [p, m.code] as const),
  )
