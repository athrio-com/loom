import { create } from 'volar-service-typescript'
import { Array, Effect, pipe } from 'effect'
import type {
  Diagnostic as LspDiagnostic,
  LanguageServicePlugin,
  LocationLink,
  SemanticToken,
  TextEdit,
} from '@volar/language-service'
import { URI } from 'vscode-uri'
import { type Diagnostic } from '@athrio/loom-ast/LoomNode'
import { SemanticTokenSchema } from '@athrio/loom-ast/LoomSymbol'
import {
  defineLanguageService,
  type FrameLocation,
  FrameQuery,
  type FrameQueryApi,
  TypescriptSdk,
} from './LanguageService'

const lspSeverity = (
  severity: Diagnostic['severity'],
): LspDiagnostic['severity'] =>
  severity === 'error' ? 1 : severity === 'warning' ? 2 : 3

const toLspDiagnostic = (
  at: (offset: number) => LspDiagnostic['range']['start'],
  diagnostic: Diagnostic,
): LspDiagnostic => ({
  range: {
    start: at(diagnostic.position.start.offset),
    end: at(diagnostic.position.end.offset),
  },
  message: diagnostic.message,
  severity: lspSeverity(diagnostic.severity),
  source: 'loom',
})

const loomDiagnostics = (frame: FrameQueryApi): LanguageServicePlugin => ({
  name: 'loom-diagnostics',
  capabilities: {
    diagnosticProvider: {
      interFileDependencies: true,
      workspaceDiagnostics: false,
    },
  },
  create: (context) => ({
    provideDiagnostics: (document) => {
      const decoded = context.decodeEmbeddedDocumentUri(URI.parse(document.uri))
      if (!decoded || decoded[1] !== 'root') return undefined
      const at = (offset: number) => document.positionAt(offset)
      return pipe(
        frame.diagnostics(decoded[0].fsPath),
        Array.map((diagnostic) => toLspDiagnostic(at, diagnostic)),
      )
    },
  }),
})

const toLocationLink = (
  target: FrameLocation,
  origin: FrameLocation | undefined,
): LocationLink => ({
  targetUri: URI.file(target.path).toString(),
  targetRange: target.range,
  targetSelectionRange: target.range,
  originSelectionRange: origin?.range,
})

const loomDefinition = (frame: FrameQueryApi): LanguageServicePlugin => ({
  name: 'loom-definition',
  capabilities: { definitionProvider: true },
  create: (context) => ({
    provideDefinition: (document, position) => {
      const decoded = context.decodeEmbeddedDocumentUri(URI.parse(document.uri))
      if (!decoded || decoded[1] !== 'root') return undefined
      const offset = document.offsetAt(position)
      const target = frame.definition(decoded[0].fsPath, offset)
      return target === undefined
        ? undefined
        : [
            toLocationLink(
              target,
              frame.navigationRange(decoded[0].fsPath, offset),
            ),
          ]
    },
  }),
})

const loomReferences = (frame: FrameQueryApi): LanguageServicePlugin => ({
  name: 'loom-references',
  capabilities: { referencesProvider: true },
  create: (context) => ({
    provideReferences: (document, position) => {
      const decoded = context.decodeEmbeddedDocumentUri(URI.parse(document.uri))
      if (!decoded || decoded[1] !== 'root') return undefined
      return pipe(
        frame.references(decoded[0].fsPath, document.offsetAt(position)),
        Array.map((location) => ({
          uri: URI.file(location.path).toString(),
          range: location.range,
        })),
      )
    },
  }),
})

const groupEdits = (
  locations: ReadonlyArray<FrameLocation>,
  newName: string,
): Record<string, TextEdit[]> =>
  Object.fromEntries(
    Object.entries(
      Array.groupBy(locations, (location) => URI.file(location.path).toString()),
    ).map(([uri, locs]) => [
      uri,
      locs.map((location) => ({ range: location.range, newText: newName })),
    ]),
  )

const loomRename = (frame: FrameQueryApi): LanguageServicePlugin => ({
  name: 'loom-rename',
  capabilities: { renameProvider: { prepareProvider: true } },
  create: (context) => ({
    provideRenameRange: (document, position) => {
      const decoded = context.decodeEmbeddedDocumentUri(URI.parse(document.uri))
      if (!decoded || decoded[1] !== 'root') return undefined
      const span = frame.renameRange(decoded[0].fsPath, document.offsetAt(position))
      return span === undefined ? undefined : span.range
    },
    provideRenameEdits: (document, position, newName) => {
      const decoded = context.decodeEmbeddedDocumentUri(URI.parse(document.uri))
      if (!decoded || decoded[1] !== 'root') return undefined
      const edits = frame.rename(decoded[0].fsPath, document.offsetAt(position))
      return edits.length === 0 ? undefined : { changes: groupEdits(edits, newName) }
    },
  }),
})

const semanticLegend = {
  tokenTypes: [...SemanticTokenSchema.literals],
  tokenModifiers: [],
}

const loomSemanticTokens = (frame: FrameQueryApi): LanguageServicePlugin => ({
  name: 'loom-semantic-tokens',
  capabilities: { semanticTokensProvider: { legend: semanticLegend } },
  create: (context) => ({
    provideDocumentSemanticTokens: (document) => {
      const decoded = context.decodeEmbeddedDocumentUri(URI.parse(document.uri))
      if (!decoded || decoded[1] !== 'root') return undefined
      return Array.map(
        frame.semanticTokens(decoded[0].fsPath),
        (span): SemanticToken => [
          span.range.start.line,
          span.range.start.character,
          span.range.end.character - span.range.start.character,
          semanticLegend.tokenTypes.indexOf(span.type),
          0,
        ],
      )
    },
  }),
})

const withoutHighlights = (
  plugin: LanguageServicePlugin,
): LanguageServicePlugin => ({
  ...plugin,
  create: (context) => ({
    ...plugin.create(context),
    provideDocumentHighlights: () => [],
  }),
})

export const LoomLanguage = defineLanguageService({
  id: 'loom',
  displayName: 'Loom',
  extensions: [],
  plugins: () =>
    Effect.gen(function* () {
      const ts = yield* TypescriptSdk
      const frame = yield* FrameQuery
      return [
        ...create(ts).map(withoutHighlights),
        loomDiagnostics(frame),
        loomDefinition(frame),
        loomReferences(frame),
        loomRename(frame),
        loomSemanticTokens(frame),
      ]
    }),
})
