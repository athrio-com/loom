import type { LanguageServicePlugin } from '@volar/language-service'
import { Data, type Effect } from 'effect'

export class ServiceError extends Data.TaggedError('ServiceError')<{
  readonly service: string
  readonly reason: string
}> {}

export interface LoomService {
  readonly id: string
  readonly displayName: string
  readonly plugins: (
    context: LoomServiceContext,
  ) => Effect.Effect<ReadonlyArray<LanguageServicePlugin>, ServiceError>
}

export interface LoomServiceContext {
  readonly typescript: typeof import('typescript')
  readonly settings: Record<string, unknown>
}

export const defineLoomService = (service: LoomService): LoomService => service
