import type { LanguageServicePlugin } from '@volar/language-service'
import { Data, Effect } from 'effect'
import { type Diagnostic } from '@athrio/loom-core/LoomNode'

export class ServiceError extends Data.TaggedError('ServiceError')<{
  readonly service: string
  readonly reason: string
}> {}

export interface LanguageService {
  readonly id: string
  readonly displayName: string
  readonly extensions: ReadonlyArray<string>
  readonly plugins: (
    context: LanguageServiceContext,
  ) => Effect.Effect<
    ReadonlyArray<LanguageServicePlugin>,
    ServiceError,
    HostCapabilities
  >
}

export class TypescriptSdk extends Effect.Service<TypescriptSdk>()('TypescriptSdk', {
  effect: Effect.die(
    'TypescriptSdk must be provided by the host',
  ) as Effect.Effect<typeof import('typescript')>,
}) {}

export interface FrameQueryApi {
  readonly diagnostics: (path: string) => ReadonlyArray<Diagnostic>
}

export class FrameQuery extends Effect.Service<FrameQuery>()('FrameQuery', {
  effect: Effect.die(
    'FrameQuery must be provided by the host',
  ) as Effect.Effect<FrameQueryApi>,
}) {}

export type HostCapabilities = TypescriptSdk | FrameQuery

export interface LanguageServiceContext {
  readonly settings: Record<string, unknown>
}

export const defineLanguageService = (service: LanguageService): LanguageService =>
  service
