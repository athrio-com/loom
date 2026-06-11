import { Effect, HashMap, Option } from 'effect'
import type { LanguageService } from './LanguageService'

export class ActiveLanguages extends Effect.Service<ActiveLanguages>()(
  'ActiveLanguages',
  {
    effect: Effect.succeed({ all: [] as ReadonlyArray<LanguageService> }),
  },
) {}

export class LanguageRegistry extends Effect.Service<LanguageRegistry>()(
  'LanguageRegistry',
  {
    effect: Effect.gen(function* () {
      const { all } = yield* ActiveLanguages
      const byId = HashMap.fromIterable(all.map((s) => [s.id, s] as const))
      const byExtension = HashMap.fromIterable(
        all.flatMap((s) => s.extensions.map((e) => [e, s] as const)),
      )
      return {
        byId: (id: string): Option.Option<LanguageService> =>
          HashMap.get(byId, id),
        byExtension: (ext: string): Option.Option<LanguageService> =>
          HashMap.get(byExtension, ext),
        all,
      }
    }),
  },
) {}
