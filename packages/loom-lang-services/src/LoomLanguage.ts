import { Array, Effect, Option, pipe } from 'effect'
import type {
  CodeAction,
  CompletionItem,
  DocumentSymbol,
  Diagnostic as LspDiagnostic,
  InlayHint,
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
} from './LanguageService'

const lspSeverity = (severity: Diagnostic['severity']): LspDiagnostic['severity'] =>
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
    provideDiagnostics: async (document) => {
      const decoded = context.decodeEmbeddedDocumentUri(URI.parse(document.uri))
      if (!decoded || decoded[1] !== 'root') return undefined
      const loom = frame.locationOf(decoded[0])
      const at = (offset: number) => document.positionAt(offset)
      const missing = await missingSymbols(
        (uri) => context.getLanguageService().getDocumentSymbols(uri),
        frame,
        loom,
      )
      return pipe(
        [...frame.diagnostics(loom), ...missing],
        Array.map((diagnostic) => toLspDiagnostic(at, diagnostic)),
      )
    },
  }),
})

type EditorRange = FrameLocation['range']

type EditorPosition = EditorRange['start']

const before = (one: EditorPosition, other: EditorPosition): boolean =>
  one.line < other.line || (one.line === other.line && one.character < other.character)

const inside = (inner: EditorRange, outer: EditorRange): boolean =>
  !before(inner.start, outer.start) && !before(outer.end, inner.end)

const outermostWithin =
  (range: EditorRange) =>
  (symbol: DocumentSymbol): ReadonlyArray<string> =>
    inside(symbol.selectionRange, range)
      ? [symbol.name]
      : Array.flatMap(symbol.children ?? [], outermostWithin(range))

const missingSymbols = async (
  symbolsAt: (uri: URI) => Promise<ReadonlyArray<DocumentSymbol> | undefined>,
  frame: FrameQueryApi,
  loom: string,
): Promise<ReadonlyArray<Diagnostic>> => {
  const contracts = frame.contracts(loom)
  const symbols = new Map(
    await Promise.all(
      Array.map(
        Array.dedupe(Array.map(contracts, (contract) => contract.target.path)),
        async (path) => [path, (await symbolsAt(frame.uriOf(path))) ?? []] as const,
      ),
    ),
  )
  return Array.flatMap(contracts, (contract) => {
    const declared = new Set(
      Array.flatMap(
        Option.getOrElse(Option.fromNullishOr(symbols.get(contract.target.path)), () => []),
        outermostWithin(contract.target.range),
      ),
    )
    return pipe(
      contract.expected,
      Array.filter((expected) => !declared.has(expected.name)),
      Array.map((expected) => expected.diagnostic),
    )
  })
}

const meets = (diagnostic: Diagnostic, start: number, end: number): boolean =>
  diagnostic.position.start.offset <= end && start <= diagnostic.position.end.offset

const fixActions =
  (uri: string, at: (offset: number) => LspDiagnostic['range']['start']) =>
  (diagnostic: Diagnostic): ReadonlyArray<CodeAction> => {
    const repaired = toLspDiagnostic(at, diagnostic)
    return Array.map(diagnostic.fixes ?? [], (fix): CodeAction => ({
      title: fix.title,
      kind: 'quickfix',
      diagnostics: [repaired],
      edit: {
        changes: {
          [uri]: [
            {
              range: Option.match(Option.fromNullishOr(fix.at), {
                onNone: () => repaired.range,
                onSome: (span) => ({ start: at(span.start.offset), end: at(span.end.offset) }),
              }),
              newText: fix.text,
            },
          ],
        },
      },
    }))
  }

const loomFixes = (frame: FrameQueryApi): LanguageServicePlugin => ({
  name: 'loom-fixes',
  capabilities: { codeActionProvider: { codeActionKinds: ['quickfix'] } },
  create: (context) => ({
    provideCodeActions: (document, range) => {
      const decoded = context.decodeEmbeddedDocumentUri(URI.parse(document.uri))
      if (!decoded || decoded[1] !== 'root') return undefined
      const loom = frame.locationOf(decoded[0])
      const start = document.offsetAt(range.start)
      const end = document.offsetAt(range.end)
      return pipe(
        frame.diagnostics(loom),
        Array.filter((diagnostic) => meets(diagnostic, start, end)),
        Array.flatMap(
          fixActions(frame.uriOf(loom).toString(), (offset) => document.positionAt(offset)),
        ),
      )
    },
  }),
})

const toLocationLink = (
  frame: FrameQueryApi,
  target: FrameLocation,
  origin: FrameLocation | undefined,
): LocationLink => ({
  targetUri: frame.uriOf(target.path).toString(),
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
      const loom = frame.locationOf(decoded[0])
      const offset = document.offsetAt(position)
      const target = frame.definition(loom, offset)
      return target === undefined
        ? undefined
        : [toLocationLink(frame, target, frame.navigationRange(loom, offset))]
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
        frame.references(frame.locationOf(decoded[0]), document.offsetAt(position)),
        Array.map((location) => ({
          uri: frame.uriOf(location.path).toString(),
          range: location.range,
        })),
      )
    },
  }),
})

const groupEdits = (
  frame: FrameQueryApi,
  locations: ReadonlyArray<FrameLocation>,
  newName: string,
): Record<string, TextEdit[]> =>
  Object.fromEntries(
    Object.entries(Array.groupBy(locations, (location) => frame.uriOf(location.path).toString())).map(
      ([uri, locs]) => [uri, locs.map((location) => ({ range: location.range, newText: newName }))],
    ),
  )

const loomRename = (frame: FrameQueryApi): LanguageServicePlugin => ({
  name: 'loom-rename',
  capabilities: { renameProvider: { prepareProvider: true } },
  create: (context) => ({
    provideRenameRange: (document, position) => {
      const decoded = context.decodeEmbeddedDocumentUri(URI.parse(document.uri))
      if (!decoded || decoded[1] !== 'root') return undefined
      const span = frame.renameRange(frame.locationOf(decoded[0]), document.offsetAt(position))
      return span === undefined ? undefined : span.range
    },
    provideRenameEdits: (document, position, newName) => {
      const decoded = context.decodeEmbeddedDocumentUri(URI.parse(document.uri))
      if (!decoded || decoded[1] !== 'root') return undefined
      const edits = frame.rename(frame.locationOf(decoded[0]), document.offsetAt(position))
      return edits.length === 0 ? undefined : { changes: groupEdits(frame, edits, newName) }
    },
  }),
})

const loomHints = (frame: FrameQueryApi): LanguageServicePlugin => ({
  name: 'loom-hints',
  capabilities: { inlayHintProvider: {} },
  create: (context) => ({
    provideInlayHints: (document) => {
      const decoded = context.decodeEmbeddedDocumentUri(URI.parse(document.uri))
      if (!decoded || decoded[1] !== 'root') return undefined
      return Array.map(frame.hints(frame.locationOf(decoded[0])), (hint): InlayHint => ({
        position: hint.position,
        label: hint.label,
        paddingLeft: true,
      }))
    },
  }),
})

const loomCompletions = (frame: FrameQueryApi): LanguageServicePlugin => ({
  name: 'loom-completions',
  capabilities: { completionProvider: { triggerCharacters: ['{'] } },
  create: (context) => ({
    provideCompletionItems: (document, position) => {
      const decoded = context.decodeEmbeddedDocumentUri(URI.parse(document.uri))
      if (!decoded || decoded[1] !== 'root') return undefined
      return {
        isIncomplete: false,
        items: Array.map(
          frame.completions(frame.locationOf(decoded[0]), document.offsetAt(position)),
          (completion): CompletionItem => ({
            label: completion.label,
            kind: 14,
            textEdit: { range: completion.range, newText: completion.text },
          }),
        ),
      }
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
      return Array.map(frame.semanticTokens(frame.locationOf(decoded[0])), (span): SemanticToken => [
        span.range.start.line,
        span.range.start.character,
        span.range.end.character - span.range.start.character,
        semanticLegend.tokenTypes.indexOf(span.type),
        0,
      ])
    },
  }),
})

const loomFormatting = (frame: FrameQueryApi): LanguageServicePlugin => ({
  name: 'loom-formatting',
  capabilities: { documentFormattingProvider: true },
  create: (context) => ({
    provideDocumentFormattingEdits: async (document) => {
      const decoded = context.decodeEmbeddedDocumentUri(URI.parse(document.uri))
      if (!decoded || decoded[1] !== 'root') return undefined
      const text = document.getText()
      const formatted = await frame.format(frame.locationOf(decoded[0]), text)
      return formatted === text
        ? []
        : [
            {
              range: { start: document.positionAt(0), end: document.positionAt(text.length) },
              newText: formatted,
            },
          ]
    },
  }),
})

export const LoomLanguage = defineLanguageService({
  id: 'loom',
  displayName: 'Loom',
  extensions: [],
  plugins: () =>
    Effect.gen(function* () {
      const frame = yield* FrameQuery
      return [
        loomDiagnostics(frame),
        loomFixes(frame),
        loomDefinition(frame),
        loomReferences(frame),
        loomRename(frame),
        loomSemanticTokens(frame),
        loomHints(frame),
        loomCompletions(frame),
        loomFormatting(frame),
      ]
    }),
})
