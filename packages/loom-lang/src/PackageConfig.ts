import { Effect } from 'effect'
import { LoomConfig } from '@athrio/loom-config/LoomConfig'
import { type AnchorDelims, defaultAnchorDelims } from '#ast/LoomTokens'
import { type Path } from '#ast/LoomCorpusAst'

export interface BuildSettings {
  readonly delims: AnchorDelims
  readonly primaryLanguage: string | undefined
}

const anchorDelimsOf = (
  anchor: { readonly open?: string; readonly close?: string } | undefined,
): AnchorDelims => ({
  open: anchor?.open ?? defaultAnchorDelims.open,
  close: anchor?.close ?? defaultAnchorDelims.close,
})

export class PackageConfig extends Effect.Service<PackageConfig>()(
  'PackageConfig',
  {
    effect: Effect.gen(function* () {
      const config = yield* LoomConfig
      return {
        resolve: (path: Path): Effect.Effect<BuildSettings> =>
          config.resolve(path).pipe(
            Effect.map((c) => ({
              delims: anchorDelimsOf(c.anchor),
              primaryLanguage: c.primary,
            })),
          ),
      }
    }),
    dependencies: [LoomConfig.Default],
  },
) {}
