import { Array, Effect, Option, pipe } from 'effect'
import { LoomSourceRanges } from '#ast/LineRanges'
import { WeftClassifier } from '#ast/WeftClassifier'
import { WeftTokeniser } from '#ast/WeftTokeniser'
import { LoomAstBuilder, emptyDocumentFor } from '#ast/LoomAstBuilder'
import type { FrameModule } from '#ast/FrameAst'
import { FrameAstBuilder } from '#ast/FrameAstBuilder'
import { ProductAstBuilder } from '#ast/ProductAstBuilder'
import type { LoomModule, Path } from '#ast/LoomCorpusAst'

// =============================================================================
// LoomCorpusAstBuilder — builds one `.loom` module: read → parse → frame pass →
// de re `code`, plus the resolved `.loom` paths of its `{Loom}` imports. One
// module, fully and locally; only `fromProduct` reaches across, at projection.
//
// It reads bytes through an abstract `Source`, *passed in by the caller* — the
// concrete I/O seam (`DocumentSource`: filesystem, Volar host, or a test fake)
// lives at the edge (`LoomCompiler`). The builder carries no I/O of its own and no
// cache: walking imports into the corpus and memoising the result are the
// compiler's job, over `LoomMemo`.
// =============================================================================

// Source — the byte/path seam the corpus build reads through.
export interface Source {
  readonly read: (path: Path) => Effect.Effect<string>
  readonly resolve: (from: Path, specifier: string) => Option.Option<Path>
}

export class LoomCorpusAstBuilder extends Effect.Service<LoomCorpusAstBuilder>()(
  'LoomCorpusAstBuilder',
  {
    effect: Effect.gen(function* () {
      const sourceRanges = yield* LoomSourceRanges
      const classify = yield* WeftClassifier
      const tokenise = yield* WeftTokeniser
      const astBuilder = yield* LoomAstBuilder
      const frames = yield* FrameAstBuilder
      const productBuilder = yield* ProductAstBuilder

      // build one module as a flat chain of passes, each consuming the previous
      // one's output: read text → line ranges → classify → tokenise → build the
      // LoomDocument → frame pass → de re `code`, plus the resolved `.loom` paths
      // of its `{Loom}` imports. `MixedEOL` short-circuits the parse to an empty
      // document; no stage runs past it.
      const build = (source: Source, path: Path): Effect.Effect<LoomModule> =>
        Effect.gen(function* () {
          const text = yield* source.read(path)
          const doc = yield* sourceRanges.stream(text).pipe(
            Effect.flatMap((ranges) =>
              pipe(
                ranges,
                classify.classifyWefts(text),
                tokenise.tokeniseWefts(text),
                astBuilder.build,
              ),
            ),
            Effect.catchTag('MixedEOL', (err) =>
              Effect.succeed(emptyDocumentFor(text, err)),
            ),
          )
          const frame = yield* frames.build(doc)
          const imports = pipe(
            frame.imports,
            Array.filterMap((i) =>
              pipe(
                specifierOf(i.text),
                Option.flatMap((spec) => source.resolve(path, spec)),
              ),
            ),
          )
          const code = yield* productBuilder.build({
            path,
            text,
            frame,
            imports: importBindingsOf(source.resolve, path, frame),
          })
          return { path, text, doc, frame, code, imports }
        })

      return { build }
    }),
    dependencies: [
      LoomSourceRanges.Default,
      WeftClassifier.Default,
      WeftTokeniser.Default,
      LoomAstBuilder.Default,
      FrameAstBuilder.Default,
      ProductAstBuilder.Default,
    ],
  },
) {}

// =============================================================================
// Leaves — the import-line scans.
// =============================================================================

// specifierOf — the module specifier of a `{Loom}` import line, when present:
//   `import { Neg } from "./Sad.loom"`  →  Some("./Sad.loom")
const specifierOf = (importLine: string): Option.Option<string> =>
  pipe(
    Option.fromNullable(importLine.match(/from\s*["']([^"']+)["']/)),
    Option.flatMap((m) => Option.fromNullable(m[1])),
  )

// namesOf — the bound names of a `{Loom}` import line: `import { A, B } from "…"`
// → ["A", "B"]. Aliased bindings (`{ X as Y }`) are skipped — they degrade to a
// name miss rather than misresolve, until alias support lands.
const namesOf = (importLine: string): ReadonlyArray<string> =>
  pipe(
    Option.fromNullable(importLine.match(/\{([^}]*)\}/)),
    Option.flatMap((m) => Option.fromNullable(m[1])),
    Option.match({
      onNone: () => [],
      onSome: (inner) =>
        pipe(
          inner.split(','),
          Array.map((s) => s.trim()),
          Array.filter((s) => s.length > 0 && !s.includes(' as ')),
        ),
    }),
  )

// importBindingsOf — a module's `{Loom}` imports as bound name → resolved `.loom`
// path (`import { Neg } from "./Sad.loom"` → `Neg ↦ /abs/Sad.loom`). Names whose
// specifier is not a `.loom` dependency (`effect`, `#loom/core`) are dropped.
const importBindingsOf = (
  resolveSpec: (from: Path, specifier: string) => Option.Option<Path>,
  from: Path,
  frame: FrameModule,
): ReadonlyMap<string, Path> =>
  new Map(
    pipe(
      frame.imports,
      Array.flatMap((line) =>
        pipe(
          specifierOf(line.text),
          Option.flatMap((spec) => resolveSpec(from, spec)),
          Option.match({
            onNone: (): ReadonlyArray<readonly [string, Path]> => [],
            onSome: (p) => Array.map(namesOf(line.text), (n) => [n, p] as const),
          }),
        ),
      ),
    ),
  )
