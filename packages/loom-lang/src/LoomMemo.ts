import { Array, Effect, Option, SynchronizedRef, pipe } from 'effect'
import { type LoomModule, type Path } from '#ast/LoomCorpusAst'

// =============================================================================
// LoomMemo — the incremental build cache: the reason editing one `.loom` does
// not recompile the project.
//
// Building a module — parse → frame → de re `code` — is the costly half of the
// pipeline; projecting it to virtual code afterwards is cheap. So what keeps a
// keystroke cheap is simply *not rebuilding what didn't change*: each module is
// built once, kept by path, and returned on the next request. An edit drops only
// the file that changed — and the dependents whose de re inlined it — while every
// other module is reused untouched.
//
// This module is exactly that and nothing more: a `path → LoomModule` cache with
// cache semantics. A `get` is a **hit** (return the kept module) or a **miss**
// (build it, keep it, count it). `evict` forgets entries; `stats` reports
// hits / misses / size, so incrementality is observable — you can watch an edit
// reuse the cache instead of rebuilding.
//
// It is deliberately *just* a cache: it knows nothing of imports or the
// dependency graph. *Which* paths an edit invalidates — the file plus its
// transitive dependents — is the compiler's call, computed over the import edges
// and handed to `evict`. The cache stays general; graph knowledge stays in one
// place.
//
// A miss's work is supplied per call (`build`), not fixed once: building a module
// may recursively `get` its imports, so the cross-file build threads through this
// same cache and a dependency built for one file is a hit for the next.
// =============================================================================

// MemoStats — the observable counters. `hits` against `misses` is how much work an
// edit avoided; `size` is how many modules are currently kept.
export interface MemoStats {
  readonly hits: number
  readonly misses: number
  readonly size: number
}

// The cache's state — the kept modules and the running tallies — held immutably
// behind a SynchronizedRef; every operation produces a fresh value.
interface MemoState {
  readonly modules: ReadonlyMap<Path, LoomModule>
  readonly hits: number
  readonly misses: number
}

const empty: MemoState = { modules: new Map(), hits: 0, misses: 0 }

// =============================================================================
// LoomMemo — the cache as a Service. One instance is the project's build cache:
// the compiler holds it, `get`s every module through it, and `evict`s on a change.
// =============================================================================

export class LoomMemo extends Effect.Service<LoomMemo>()('LoomMemo', {
  effect: Effect.gen(function* () {
    const state = yield* SynchronizedRef.make<MemoState>(empty)

    return {
      // get — a hit returns the kept module; a miss runs `build`, keeps the result,
      // and counts it. The check-then-build is one atomic step through the
      // SynchronizedRef, so under concurrent gets a module is built at most once.
      // `build` is self-contained (the compiler captures the pipeline services and
      // uses them directly) and may itself `get` this cache for its imports.
      get: (
        path: Path,
        build: Effect.Effect<LoomModule>,
      ): Effect.Effect<LoomModule> =>
        SynchronizedRef.modifyEffect(state, (s) =>
          Option.match(Option.fromNullable(s.modules.get(path)), {
            onSome: (module) =>
              Effect.succeed([module, { ...s, hits: s.hits + 1 }] as const),
            onNone: () =>
              Effect.map(build, (module) => [
                module,
                {
                  ...s,
                  misses: s.misses + 1,
                  modules: new Map(s.modules).set(path, module),
                },
              ] as const),
          }),
        ),

      // entries — the modules currently kept. The compiler reads them to project,
      // and to walk the import graph when working out what an edit invalidates.
      entries: SynchronizedRef.get(state).pipe(Effect.map((s) => s.modules)),

      // evict — forget these paths: the compiler passes the edited file together
      // with its dependents. Copy-and-change; the kept map is never mutated.
      evict: (paths: Iterable<Path>): Effect.Effect<void> => {
        const drop = new Set(paths)
        return SynchronizedRef.update(state, (s) => ({
          ...s,
          modules: new Map(
            pipe(
              Array.fromIterable(s.modules),
              Array.filter(([path]) => !drop.has(path)),
            ),
          ),
        }))
      },

      // stats — hits / misses / size, the window onto how much work the cache is
      // sparing.
      stats: SynchronizedRef.get(state).pipe(
        Effect.map(
          (s): MemoStats => ({
            hits: s.hits,
            misses: s.misses,
            size: s.modules.size,
          }),
        ),
      ),
    }
  }),
}) {}
