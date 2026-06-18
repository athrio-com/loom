import { Array, Effect, Option, SynchronizedRef, pipe } from 'effect'
import { type LoomModule, type Path } from '#ast/LoomCorpusAst'

export interface MemoStats {
  readonly hits: number
  readonly misses: number
  readonly size: number
}

interface MemoState {
  readonly modules: ReadonlyMap<Path, LoomModule>
  readonly hits: number
  readonly misses: number
}

const empty: MemoState = { modules: new Map(), hits: 0, misses: 0 }

export class LoomMemo extends Effect.Service<LoomMemo>()('LoomMemo', {
  effect: Effect.gen(function* () {
    const state = yield* SynchronizedRef.make<MemoState>(empty)

    return {
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

      entries: SynchronizedRef.get(state).pipe(Effect.map((s) => s.modules)),

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
