import type { LanguageServicePlugin } from '@volar/language-service'
import { Data, Effect } from 'effect'
import { type Diagnostic } from '@athrio/loom-ast/LoomNode'
import type { SemanticToken } from '@athrio/loom-ast/LoomSymbol'

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

export interface FrameLocation {
  readonly path: string
  readonly range: {
    readonly start: { readonly line: number; readonly character: number }
    readonly end: { readonly line: number; readonly character: number }
  }
}

export interface FrameToken {
  readonly range: FrameLocation['range']
  readonly type: SemanticToken
}

export interface FrameQueryApi {
  readonly diagnostics: (path: string) => ReadonlyArray<Diagnostic>
  readonly definition: (path: string, offset: number) => FrameLocation | undefined
  readonly references: (path: string, offset: number) => ReadonlyArray<FrameLocation>
  readonly rename: (path: string, offset: number) => ReadonlyArray<FrameLocation>
  readonly renameRange: (path: string, offset: number) => FrameLocation | undefined
  readonly semanticTokens: (path: string) => ReadonlyArray<FrameToken>
}

export class FrameQuery extends Effect.Service<FrameQuery>()('FrameQuery', {
  effect: Effect.die(
    'FrameQuery must be provided by the host',
  ) as Effect.Effect<FrameQueryApi>,
}) {}

export interface ComposedFile {
  readonly path: string
  readonly content: string
  readonly loomPath: string
  readonly rootId: string
  readonly heading: FrameLocation
}

export interface CompositionApi {
  readonly rootsFor: (path: string) => ReadonlyArray<ComposedFile>
}

export class Composition extends Effect.Service<Composition>()('Composition', {
  effect: Effect.die(
    'Composition must be provided by the host',
  ) as Effect.Effect<CompositionApi>,
}) {}

export type HostCapabilities = TypescriptSdk | FrameQuery | Composition

export interface LanguageServiceContext {
  readonly settings: Record<string, unknown>
}

export const isLanguageService = (value: unknown): value is LanguageService =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as LanguageService).id === 'string' &&
  typeof (value as LanguageService).displayName === 'string' &&
  Array.isArray((value as LanguageService).extensions) &&
  typeof (value as LanguageService).plugins === 'function'

export const defineLanguageService = (service: LanguageService): LanguageService => {
  if (!isLanguageService(service)) {
    throw new Error(
      'defineLanguageService: the value does not satisfy the LanguageService contract',
    )
  }
  return service
}
