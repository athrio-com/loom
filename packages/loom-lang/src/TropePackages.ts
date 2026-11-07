import { Array, Context, Effect, Layer, Option, Order, pipe, Ref } from 'effect'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { LoomConfig } from '@athrio/loom-config/LoomConfig'
import { installedTropeVersion, tropeDir } from '@athrio/loom-lang-services/LoomStore'
import { bookOf, type Location, type LoomModule } from '@athrio/loom-ast/LoomCorpusAst'
import { LoomCorpusAstBuilder, ReadError, type Source } from '#ast/LoomCorpusAstBuilder'
import { type DeclaredKind, declaredKindsOf } from '#ast/DeclaredKinds'

export interface TropePackagesApi {
  readonly kindsFor: (loom: Location) => Effect.Effect<ReadonlyArray<DeclaredKind>>
}

const fromDisk: Source = {
  read: (path) =>
    Effect.try({
      try: () => readFileSync(path, 'utf8'),
      catch: (cause) => new ReadError({ path, cause }),
    }),
  list: Option.none(),
}

const loomsIn = (folder: string): ReadonlyArray<Location> =>
  pipe(
    Option.liftThrowable(() => readdirSync(folder))(),
    Option.map((names) =>
      pipe(
        names,
        Array.filter((name) => name.endsWith('.loom')),
        Array.sort(Order.String),
        Array.map((name) => join(folder, name)),
      ),
    ),
    Option.getOrElse((): ReadonlyArray<Location> => []),
  )

const keyFor = (workspace: Location, tropes: ReadonlyArray<string>): string =>
  JSON.stringify([
    workspace,
    ...Array.map(tropes, (id) => [id, Option.getOrNull(installedTropeVersion(id, workspace))]),
  ])

export class TropePackages extends Context.Service<TropePackages>()('TropePackages', {
  make: Effect.gen(function* () {
    const config = yield* LoomConfig
    const builder = yield* LoomCorpusAstBuilder
    const kept = yield* Ref.make<ReadonlyMap<string, ReadonlyArray<DeclaredKind>>>(new Map())

    const installedKinds = (
      workspace: Location,
      tropes: ReadonlyArray<string>,
    ): Effect.Effect<ReadonlyArray<DeclaredKind>> =>
      Effect.forEach(
        Array.flatMap(tropes, (id) => loomsIn(join(tropeDir(id, workspace), 'looms'))),
        (path) =>
          builder.build(fromDisk, path).pipe(Effect.map((module) => [path, module] as const)),
      ).pipe(
        Effect.map((pairs): ReadonlyMap<Location, LoomModule> => new Map(pairs)),
        Effect.map((modules) => declaredKindsOf(modules, bookOf(modules))),
        Effect.tap((kinds) =>
          Effect.forEach(
            kinds.refusals,
            (refusal) =>
              Effect.logWarning(
                `loom: the installed trope in ${refusal.module} is refused: ${refusal.reason}`,
              ),
            { discard: true },
          ),
        ),
        Effect.map((kinds) => kinds.box),
      )

    const kindsFor = (loom: Location): Effect.Effect<ReadonlyArray<DeclaredKind>> =>
      config.resolve(loom).pipe(
        Effect.flatMap(({ workspaceRoot, tropes }) =>
          Option.match(Option.fromNullishOr(workspaceRoot), {
            onNone: () => Effect.succeed<ReadonlyArray<DeclaredKind>>([]),
            onSome: (workspace) => {
              const ids = Option.getOrElse(Option.fromNullishOr(tropes), () => [])
              const key = keyFor(workspace, ids)
              return Ref.get(kept).pipe(
                Effect.flatMap((known) =>
                  Option.match(Option.fromNullishOr(known.get(key)), {
                    onSome: (kinds) => Effect.succeed(kinds),
                    onNone: () =>
                      installedKinds(workspace, ids).pipe(
                        Effect.tap((kinds) =>
                          Ref.update(kept, (was) => new Map(was).set(key, kinds)),
                        ),
                      ),
                  }),
                ),
              )
            },
          }),
        ),
      )

    const packages: TropePackagesApi = { kindsFor }
    return packages
  }),
}) {
  static readonly layer = Layer.effect(this, this.make).pipe(
    Layer.provide(LoomCorpusAstBuilder.layer),
  )
}
