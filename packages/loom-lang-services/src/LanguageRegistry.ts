import { Context, Effect, HashMap, Layer, Option } from 'effect'
import type { LanguageService } from './LanguageService'

export class ActiveLanguages extends Context.Service<ActiveLanguages>()(
  'ActiveLanguages',
  {
    make: Effect.succeed({ all: [] as ReadonlyArray<LanguageService> }),
  },
) {
  static readonly layer = Layer.effect(this, this.make)
}

export class LanguageRegistry extends Context.Service<LanguageRegistry>()(
  'LanguageRegistry',
  {
    make: Effect.gen(function* () {
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
) {
  static readonly layer = Layer.effect(this, this.make)
}
