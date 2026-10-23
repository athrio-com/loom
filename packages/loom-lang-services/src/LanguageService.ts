import type { LanguageServicePlugin } from '@volar/language-service'
import { Context, Data, Effect, Layer, Option, type Result } from 'effect'
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
  ) => Effect.Effect<ReadonlyArray<LanguageServicePlugin>, ServiceError, HostCapabilities>
  readonly format?: (request: FormatRequest) => Effect.Effect<string, ServiceError>
}

export interface FormatRequest {
  readonly code: string
  readonly path: string
  readonly width: number
}

export interface FetchedTypeScript {
  readonly version: string
  readonly executable: string
  readonly fetch: () => Promise<void>
}

export class ClassicTypeScriptMissing extends Data.TaggedError('ClassicTypeScriptMissing')<{
  readonly folder: string
  readonly tsdk: Option.Option<string>
  readonly cause?: unknown
}> {
  get message(): string {
    return Option.match(this.tsdk, {
      onNone: () =>
        `found no TypeScript 6 for ${this.folder}, in the project or beside Loom; ` +
        'install it in the project with `npm install -D typescript@6`',
      onSome: (tsdk) => `the TypeScript in ${tsdk} did not load: ${String(this.cause)}`,
    })
  }
}

export interface TypescriptSdkApi {
  readonly classic: (
    folder: string,
  ) => Result.Result<typeof import('typescript'), ClassicTypeScriptMissing>
  readonly fetched: FetchedTypeScript
}

export class TypescriptSdk extends Context.Service<TypescriptSdk>()('TypescriptSdk', {
  make: Effect.die('TypescriptSdk must be provided by the host') as Effect.Effect<TypescriptSdkApi>,
}) {
  static readonly layer = Layer.effect(this, this.make)
}

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
  readonly navigationRange: (path: string, offset: number) => FrameLocation | undefined
  readonly semanticTokens: (path: string) => ReadonlyArray<FrameToken>
  readonly format: (path: string, text: string) => Promise<string>
}

export class FrameQuery extends Context.Service<FrameQuery>()('FrameQuery', {
  make: Effect.die('FrameQuery must be provided by the host') as Effect.Effect<FrameQueryApi>,
}) {
  static readonly layer = Layer.effect(this, this.make)
}

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

export class Composition extends Context.Service<Composition>()('Composition', {
  make: Effect.die('Composition must be provided by the host') as Effect.Effect<CompositionApi>,
}) {
  static readonly layer = Layer.effect(this, this.make)
}

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
