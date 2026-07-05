import { Context, Effect, Layer } from 'effect'
import { LoomConfig } from '@athrio/loom-config/LoomConfig'
import { type AnchorDelims, defaultAnchorDelims } from '@athrio/loom-ast/LoomTokens'
import { type Path } from '@athrio/loom-ast/LoomCorpusAst'

export interface BuildSettings {
  readonly delims: AnchorDelims
  readonly primaryLanguage: string | undefined
  readonly packageRoot: string | undefined
  readonly workspaceRoot: string | undefined
  readonly corpusDir: string | undefined
}

const anchorDelimsOf = (
  anchor: { readonly open?: string; readonly close?: string } | undefined,
): AnchorDelims => ({
  open: anchor?.open ?? defaultAnchorDelims.open,
  close: anchor?.close ?? defaultAnchorDelims.close,
})

export class PackageConfig extends Context.Service<PackageConfig>()(
  'PackageConfig',
  {
    make: Effect.gen(function* () {
      const config = yield* LoomConfig
      return {
        resolve: (path: Path): Effect.Effect<BuildSettings> =>
          config.resolve(path).pipe(
            Effect.map((c) => ({
              delims: anchorDelimsOf(c.anchor),
              primaryLanguage: c.primary,
              packageRoot: c.packageRoot,
              workspaceRoot: c.workspaceRoot,
              corpusDir: c.corpusDir,
            })),
          ),
      }
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make).pipe(
    Layer.provide(LoomConfig.layer),
  )
}
