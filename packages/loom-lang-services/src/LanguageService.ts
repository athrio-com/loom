import type { LanguageServicePlugin } from '@volar/language-service'
import { Data, Effect } from 'effect'

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

export class TypeScriptSdk extends Effect.Service<TypeScriptSdk>()('TypeScriptSdk', {
  effect: Effect.die(
    'TypeScriptSdk must be provided by the host',
  ) as Effect.Effect<typeof import('typescript')>,
}) {}

export type HostCapabilities = TypeScriptSdk

export interface LanguageServiceContext {
  readonly settings: Record<string, unknown>
}

export const defineLanguageService = (service: LanguageService): LanguageService =>
  service
