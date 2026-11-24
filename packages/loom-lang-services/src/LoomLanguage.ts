import { Array, Effect, Option, Schema } from 'effect'
import type {
  ClientCapabilities,
  CodeAction,
  CompletionItem,
  DocumentSymbol,
  Diagnostic as LspDiagnostic,
  FoldingRange,
  Hover,
  InlayHint,
  LanguageServicePlugin,
  LocationLink,
  SemanticToken,
  TextEdit,
  WorkspaceEdit,
  WorkspaceSymbol,
} from '@volar/language-service'
import { URI } from 'vscode-uri'
import { type Diagnostic } from '@athrio/loom-ast/LoomNode'
import { SemanticTokenSchema } from '@athrio/loom-ast/LoomSymbol'
import {
  defineLanguageService,
  type FrameEdit,
  type FrameFix,
  type FrameLocation,
  type FrameMove,
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
      return [...frame.diagnostics(loom), ...missing].map((diagnostic) =>
        toLspDiagnostic(at, diagnostic),
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
      : (symbol.children ?? []).flatMap(outermostWithin(range))

const missingSymbols = async (
  symbolsAt: (uri: URI) => Promise<ReadonlyArray<DocumentSymbol> | undefined>,
  frame: FrameQueryApi,
  loom: string,
): Promise<ReadonlyArray<Diagnostic>> => {
  const contracts = frame.contracts(loom)
  const symbols = new Map(
    await Promise.all(
      Array.dedupe(contracts.map((contract) => contract.target.path)).map(
        async (path) => [path, (await symbolsAt(frame.uriOf(path))) ?? []] as const,
      ),
    ),
  )
  return contracts.flatMap((contract) => {
    const declared = new Set(
      Option.getOrElse(Option.fromNullishOr(symbols.get(contract.target.path)), () => []).flatMap(
        outermostWithin(contract.target.range),
      ),
    )
    return contract.expected
      .filter((expected) => !declared.has(expected.name))
      .map((expected) => expected.diagnostic)
  })
}

const meets = (diagnostic: Diagnostic, start: number, end: number): boolean =>
  diagnostic.position.start.offset <= end && start <= diagnostic.position.end.offset

const writtenFile = (uri: string, text: string, replaces: boolean): WorkspaceEdit => ({
  documentChanges: [
    { kind: 'create', uri, options: { overwrite: replaces, ignoreIfExists: false } },
    {
      textDocument: { uri, version: null },
      edits: [
        {
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
          newText: text,
        },
      ],
    },
  ],
})

const newLoom = (uri: string, text: string): WorkspaceEdit => writtenFile(uri, text, false)

const fixActions =
  (
    uri: string,
    uriOf: (file: string) => string,
    at: (offset: number) => LspDiagnostic['range']['start'],
  ) =>
  (diagnostic: Diagnostic): ReadonlyArray<CodeAction> => {
    const repaired = toLspDiagnostic(at, diagnostic)
    return (diagnostic.fixes ?? []).map((fix): CodeAction => ({
      title: fix.title,
      kind: 'quickfix',
      diagnostics: [repaired],
      edit: Option.match(Option.fromNullishOr(fix.file), {
        onSome: (file) => newLoom(uriOf(file), fix.text),
        onNone: () => ({
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
        }),
      }),
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
      return frame
        .diagnostics(loom)
        .filter((diagnostic) => meets(diagnostic, start, end))
        .flatMap(
          fixActions(
            frame.uriOf(loom).toString(),
            (file) => frame.uriOf(file).toString(),
            (offset) => document.positionAt(offset),
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
      return frame
        .references(frame.locationOf(decoded[0]), document.offsetAt(position))
        .map((location) => ({
          uri: frame.uriOf(location.path).toString(),
          range: location.range,
        }))
    },
  }),
})

const groupEdits = (
  frame: FrameQueryApi,
  locations: ReadonlyArray<FrameEdit>,
  newName: string,
): Record<string, TextEdit[]> =>
  Object.fromEntries(
    Object.entries(
      Array.groupBy(locations, (location) => frame.uriOf(location.path).toString()),
    ).map(([uri, locs]) => [
      uri,
      locs.map((location) => ({ range: location.range, newText: location.text ?? newName })),
    ]),
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

const loomHover = (frame: FrameQueryApi): LanguageServicePlugin => ({
  name: 'loom-hover',
  capabilities: { hoverProvider: true },
  create: (context) => ({
    provideHover: (document, position): Hover | undefined => {
      const decoded = context.decodeEmbeddedDocumentUri(URI.parse(document.uri))
      if (!decoded || decoded[1] !== 'root') return undefined
      const card = frame.hover(frame.locationOf(decoded[0]), document.offsetAt(position))
      return card === undefined
        ? undefined
        : { contents: { kind: 'markdown', value: card.markdown }, range: card.range }
    },
  }),
})

const workspaceEditOf = (frame: FrameQueryApi, fix: FrameFix): WorkspaceEdit => ({
  changes: groupEdits(frame, fix.edits, ''),
})

const loomLinks = (frame: FrameQueryApi): LanguageServicePlugin => ({
  name: 'loom-links',
  capabilities: { codeActionProvider: { codeActionKinds: ['quickfix'] } },
  create: (context) => ({
    provideCodeActions: (document, range) => {
      const decoded = context.decodeEmbeddedDocumentUri(URI.parse(document.uri))
      if (!decoded || decoded[1] !== 'root') return undefined
      return frame
        .links(
          frame.locationOf(decoded[0]),
          document.offsetAt(range.start),
          document.offsetAt(range.end),
        )
        .map((fix): CodeAction => ({
          title: fix.title,
          kind: 'quickfix',
          edit: workspaceEditOf(frame, fix),
        }))
    },
  }),
})

const loomApprovals = (frame: FrameQueryApi): LanguageServicePlugin => ({
  name: 'loom-approvals',
  capabilities: { codeActionProvider: { codeActionKinds: ['quickfix'] } },
  create: (context) => ({
    provideCodeActions: (document, range) => {
      const decoded = context.decodeEmbeddedDocumentUri(URI.parse(document.uri))
      if (!decoded || decoded[1] !== 'root') return undefined
      return frame
        .approvals(
          frame.locationOf(decoded[0]),
          document.offsetAt(range.start),
          document.offsetAt(range.end),
        )
        .map((approval): CodeAction => ({
          title: approval.title,
          kind: 'quickfix',
          edit: writtenFile(frame.uriOf(approval.file).toString(), approval.text, true),
        }))
    },
  }),
})

const moveCommand = 'loom.moveConcept'

const ClientCommands = Schema.Struct({
  commands: Schema.Struct({ commands: Schema.Array(Schema.String) }),
})

const picksTargets = (capabilities: ClientCapabilities | undefined): boolean =>
  Option.exists(Schema.decodeUnknownOption(ClientCommands)(capabilities?.experimental), (listed) =>
    listed.commands.commands.includes(moveCommand),
  )

const moveActionsOf =
  (frame: FrameQueryApi, picker: boolean) =>
  (move: FrameMove): ReadonlyArray<CodeAction> =>
    picker
      ? [
          {
            title: `Move \`${move.concept}\` up…`,
            kind: 'refactor.move',
            command: {
              title: `Move \`${move.concept}\` up`,
              command: moveCommand,
              arguments: [
                move.targets.map((target) => ({
                  title: target.title,
                  edit: workspaceEditOf(frame, target),
                })),
              ],
            },
          },
        ]
      : Option.toArray(
          Option.map(Array.head(move.targets), (target): CodeAction => ({
            title: target.title,
            kind: 'refactor.move',
            edit: workspaceEditOf(frame, target),
          })),
        )

const loomMoves = (frame: FrameQueryApi): LanguageServicePlugin => ({
  name: 'loom-moves',
  capabilities: { codeActionProvider: { codeActionKinds: ['refactor.move'] } },
  create: (context) => ({
    provideCodeActions: (document, range) => {
      const decoded = context.decodeEmbeddedDocumentUri(URI.parse(document.uri))
      if (!decoded || decoded[1] !== 'root') return undefined
      return frame
        .moves(frame.locationOf(decoded[0]), document.offsetAt(range.start))
        .flatMap(moveActionsOf(frame, picksTargets(context.env.clientCapabilities)))
    },
  }),
})

const loomSymbols = (frame: FrameQueryApi): LanguageServicePlugin => ({
  name: 'loom-symbols',
  capabilities: { workspaceSymbolProvider: {} },
  create: () => ({
    provideWorkspaceSymbols: (query) =>
      frame.symbols(query).map((symbol): WorkspaceSymbol => ({
        name: symbol.name,
        kind: 14,
        containerName: symbol.container,
        location: {
          uri: frame.uriOf(symbol.location.path).toString(),
          range: symbol.location.range,
        },
      })),
  }),
})

const loomHints = (frame: FrameQueryApi): LanguageServicePlugin => ({
  name: 'loom-hints',
  capabilities: { inlayHintProvider: {} },
  create: (context) => ({
    provideInlayHints: (document) => {
      const decoded = context.decodeEmbeddedDocumentUri(URI.parse(document.uri))
      if (!decoded || decoded[1] !== 'root') return undefined
      return frame.hints(frame.locationOf(decoded[0])).map((hint): InlayHint => ({
        position: hint.position,
        label: hint.label,
        paddingLeft: true,
      }))
    },
  }),
})

const loomCompletions = (frame: FrameQueryApi): LanguageServicePlugin => ({
  name: 'loom-completions',
  capabilities: { completionProvider: { triggerCharacters: ['{', '='] } },
  create: (context) => ({
    provideCompletionItems: (document, position) => {
      const decoded = context.decodeEmbeddedDocumentUri(URI.parse(document.uri))
      if (!decoded || decoded[1] !== 'root') return undefined
      return {
        isIncomplete: false,
        items: frame
          .completions(frame.locationOf(decoded[0]), document.offsetAt(position))
          .map((completion): CompletionItem => ({
            label: completion.label,
            kind: 14,
            textEdit: { range: completion.range, newText: completion.text },
          })),
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
      return frame
        .semanticTokens(frame.locationOf(decoded[0]))
        .map((span): SemanticToken => [
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

const loomFolding = (frame: FrameQueryApi): LanguageServicePlugin => ({
  name: 'loom-folding',
  capabilities: { foldingRangeProvider: true },
  create: (context) => ({
    provideFoldingRanges: (document) => {
      const decoded = context.decodeEmbeddedDocumentUri(URI.parse(document.uri))
      if (!decoded || decoded[1] !== 'root') return undefined
      return frame.boxes(frame.locationOf(decoded[0])).map((box): FoldingRange => ({
        startLine: box.startLine,
        endLine: box.endLine,
        kind: 'region',
        collapsedText: box.caption,
      }))
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
        loomHover(frame),
        loomLinks(frame),
        loomApprovals(frame),
        loomMoves(frame),
        loomSymbols(frame),
        loomRename(frame),
        loomSemanticTokens(frame),
        loomHints(frame),
        loomFolding(frame),
        loomCompletions(frame),
        loomFormatting(frame),
      ]
    }),
})
