import { Context, Effect, Layer, Option, Record } from 'effect'
import {
  defaultWidth,
  LoomConfig,
  type ResolvedConfig,
  type WorkspaceManifest,
} from '@athrio/loom-config/LoomConfig'
import { type AnchorDelims, defaultAnchorDelims } from '@athrio/loom-ast/LoomTokens'
import { type Location } from '@athrio/loom-ast/LoomCorpusAst'
import { type ReadError } from '#ast/LoomCorpusAstBuilder'

export interface BuildSettings {
  readonly delims: AnchorDelims
  readonly primaryLanguage: string | undefined
  readonly variables: Record<string, string>
  readonly width: number
}

const anchorDelimsOf = (
  anchor: { readonly open?: string; readonly close?: string } | undefined,
): AnchorDelims => ({
  open: anchor?.open ?? defaultAnchorDelims.open,
  close: anchor?.close ?? defaultAnchorDelims.close,
})

export interface WorkspaceSettingsApi {
  readonly resolve: (loom: Location) => Effect.Effect<BuildSettings>
  readonly manifest: (
    workspace: Location,
  ) => Effect.Effect<Option.Option<WorkspaceManifest>, ReadError>
}

export class WorkspaceSettings extends Context.Service<WorkspaceSettings>()('WorkspaceSettings', {
  make: Effect.die('WorkspaceSettings must be provided by an environment') as Effect.Effect<WorkspaceSettingsApi>,
}) {
  static readonly layer = Layer.effect(this, this.make)
}

const settingsOf = (resolved: ResolvedConfig): BuildSettings => ({
  delims: anchorDelimsOf(resolved.anchor),
  primaryLanguage: resolved.primary,
  variables: resolved.variables,
  width: resolved.width,
})

export const FileSystemSettings = Layer.effect(
  WorkspaceSettings,
  Effect.gen(function* () {
    const config = yield* LoomConfig
    const settings: WorkspaceSettingsApi = {
      resolve: (loom) => config.resolve(loom).pipe(Effect.map(settingsOf)),
      manifest: (workspace) => config.manifest(workspace).pipe(Effect.map(Option.fromNullishOr)),
    }
    return settings
  }),
).pipe(Layer.provide(LoomConfig.layer))

export const settingsOfManifest = (manifest: Option.Option<WorkspaceManifest>): BuildSettings =>
  Option.match(manifest, {
    onNone: () => ({
      delims: defaultAnchorDelims,
      primaryLanguage: undefined,
      variables: {},
      width: defaultWidth,
    }),
    onSome: (m) => ({
      delims: anchorDelimsOf(m.anchor),
      primaryLanguage: m.primary,
      variables: Record.map(m.variables ?? {}, (value) => String(value)),
      width: m.width ?? defaultWidth,
    }),
  })
