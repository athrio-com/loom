import { create } from 'volar-service-typescript'
import { Array, Effect, pipe } from 'effect'
import type {
  Diagnostic as LspDiagnostic,
  LanguageServicePlugin,
} from '@volar/language-service'
import { URI } from 'vscode-uri'
import { type Diagnostic } from '@athrio/loom-core/LoomNode'
import {
  defineLanguageService,
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

export const LoomLanguage = defineLanguageService({
  id: 'loom',
  displayName: 'Loom',
  extensions: [],
  plugins: () =>
    Effect.gen(function* () {
      const ts = yield* TypescriptSdk
      const frame = yield* FrameQuery
      return [...create(ts), loomDiagnostics(frame)]
    }),
})
