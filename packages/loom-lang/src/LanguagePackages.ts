import { Array, Context, Effect, Layer, Option, Ref } from 'effect'
import { createRequire } from 'node:module'
import { type Location } from '@athrio/loom-ast/LoomCorpusAst'
import { LoomConfig } from '@athrio/loom-config/LoomConfig'
import {
  type LanguageService,
  type ServiceError,
  type SpecifierRequest,
} from '@athrio/loom-lang-services/LanguageService'

export interface LanguagePackagesApi {
  readonly hold: (
    workspace: Location,
    services: ReadonlyArray<LanguageService>,
  ) => Effect.Effect<void>
  readonly moduleSpecifier: (
    request: SpecifierRequest,
  ) => Effect.Effect<Option.Option<string>, ServiceError>
}

type Question<A> = Effect.Effect<Option.Option<A>, ServiceError>

const packagesWith = (loads: boolean): Effect.Effect<LanguagePackagesApi, never, LoomConfig> =>
  Effect.gen(function* () {
    const config = yield* LoomConfig
    const held = yield* Ref.make<ReadonlyMap<Location, ReadonlyArray<LanguageService>>>(new Map())

    const hold = (workspace: Location, services: ReadonlyArray<LanguageService>) =>
      Ref.update(held, (kept) => new Map(kept).set(workspace, services))

    const loaded = (
      workspace: Location,
      languages: ReadonlyArray<string>,
    ): Effect.Effect<ReadonlyArray<LanguageService>> =>
      Effect.promise(() =>
        Promise.all([
          import('@athrio/loom-lang-services/Runtime'),
          import('@athrio/loom-lang-services/LanguageLoader'),
        ]),
      ).pipe(
        Effect.flatMap(([{ installHostRuntime }, { loadActive }]) =>
          Effect.sync(() => {
            ;(globalThis as { require?: unknown }).require ??= createRequire(import.meta.url)
            installHostRuntime()
          }).pipe(Effect.andThen(loadActive(languages, workspace))),
        ),
        Effect.tap((services) => hold(workspace, services)),
      )

    const packagesOf = (loom: Location): Effect.Effect<ReadonlyArray<LanguageService>> =>
      config.resolve(loom).pipe(
        Effect.flatMap(({ workspaceRoot, languages }) =>
          Option.match(Option.fromNullishOr(workspaceRoot), {
            onNone: () => Effect.succeed<ReadonlyArray<LanguageService>>([]),
            onSome: (workspace) =>
              Ref.get(held).pipe(
                Effect.flatMap((kept) =>
                  Option.match(Option.fromNullishOr(kept.get(workspace)), {
                    onSome: (services) => Effect.succeed(services),
                    onNone: () =>
                      loads && Array.isReadonlyArrayNonEmpty(languages)
                        ? loaded(workspace, languages)
                        : Effect.succeed<ReadonlyArray<LanguageService>>([]),
                  }),
                ),
              ),
          }),
        ),
      )

    const firstAnswer = <A>(
      loom: Location,
      ask: (service: LanguageService) => Option.Option<Question<A>>,
    ): Effect.Effect<Option.Option<A>, ServiceError> =>
      packagesOf(loom).pipe(
        Effect.flatMap((services) => Effect.all(Array.getSomes(Array.map(services, ask)))),
        Effect.map((answers) => Array.head(Array.getSomes(answers))),
      )

    return {
      hold,
      moduleSpecifier: (request) =>
        firstAnswer(request.loom, (service) =>
          Option.map(Option.fromNullishOr(service.moduleSpecifier), (ask) => ask(request)),
        ),
    }
  })

export class LanguagePackages extends Context.Service<LanguagePackages>()('LanguagePackages', {
  make: packagesWith(true),
}) {
  static readonly layer = Layer.effect(this, this.make)
  static readonly held = Layer.effect(this, packagesWith(false))
}
