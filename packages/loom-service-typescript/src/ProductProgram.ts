import { Array, Option, pipe } from 'effect'
import {
  createLanguage,
  createLanguageService,
  createUriMap,
  type LanguageServiceEnvironment,
} from '@volar/language-service'
import type {
  CodeAction,
  CodeActionContext,
  CompletionList,
  Diagnostic,
  Hover,
  Location,
  LocationLink,
  Position,
  Range,
  WorkspaceEdit,
} from '@volar/language-service'
import type { Language } from '@volar/language-core'
import {
  createLanguageServiceHost,
  resolveFileLanguageId,
} from '@volar/typescript'
import { create as createTypescriptServices } from 'volar-service-typescript'
import { URI } from 'vscode-uri'
import type { CompilerOptions, IScriptSnapshot } from 'typescript'

type TypeScript = typeof import('typescript')

export interface ProductProgram {
  readonly sync: (
    files: ReadonlyArray<{ readonly path: string; readonly text: string }>,
  ) => void
  readonly diagnostics: (fileName: string) => Promise<Diagnostic[]>
  readonly hover: (
    fileName: string,
    position: Position,
  ) => Promise<Hover | undefined>
  readonly completions: (
    fileName: string,
    position: Position,
  ) => Promise<CompletionList>
  readonly definition: (
    fileName: string,
    position: Position,
  ) => Promise<LocationLink[] | undefined>
  readonly references: (
    fileName: string,
    position: Position,
  ) => Promise<Location[] | undefined>
  readonly rename: (
    fileName: string,
    position: Position,
    newName: string,
  ) => Promise<WorkspaceEdit | undefined>
  readonly codeActions: (
    fileName: string,
    range: Range,
    context: CodeActionContext,
  ) => Promise<CodeAction[] | undefined>
  readonly resolveCodeAction: (action: CodeAction) => Promise<CodeAction>
  readonly dispose: () => void
}

const productLanguage = (
  ts: TypeScript,
  roots: ReadonlyMap<string, IScriptSnapshot>,
): Language<URI> => {
  const language = createLanguage<URI>(
    [{ getLanguageId: (uri: URI) => resolveFileLanguageId(uri.path) }],
    createUriMap(ts.sys.useCaseSensitiveFileNames),
    (uri, includeFsFiles) => {
      const fileName = uri.fsPath
      const root = roots.get(fileName)
      if (root) {
        language.scripts.set(uri, root)
        return
      }
      if (!includeFsFiles) return
      const text = ts.sys.fileExists(fileName)
        ? ts.sys.readFile(fileName)
        : undefined
      if (text !== undefined) {
        language.scripts.set(uri, ts.ScriptSnapshot.fromString(text))
      } else {
        language.scripts.delete(uri)
      }
    },
  )
  return language
}

export const createProductProgram = (
  ts: TypeScript,
  compilerOptions: CompilerOptions,
): ProductProgram => {
  const roots = new Map<string, IScriptSnapshot>()
  let projectVersion = 0
  const language = productLanguage(ts, roots)
  const asUri = (fileName: string): URI => URI.file(fileName)

  const projectHost = {
    getCurrentDirectory: () => process.cwd(),
    getCompilationSettings: () => compilerOptions,
    getProjectVersion: () => projectVersion.toString(),
    getScriptFileNames: () => [...roots.keys()],
  }

  const env: LanguageServiceEnvironment = {
    workspaceFolders: [URI.file(process.cwd())],
  }

  const service = createLanguageService(
    language,
    createTypescriptServices(ts),
    env,
    {
      typescript: {
        configFileName: undefined,
        sys: ts.sys,
        uriConverter: { asFileName: (uri: URI) => uri.fsPath, asUri },
        ...createLanguageServiceHost(ts, ts.sys, language, asUri, projectHost),
      },
    },
  )

  const unchanged = (path: string, text: string): boolean =>
    pipe(
      Option.fromNullable(roots.get(path)),
      Option.match({
        onNone: () => false,
        onSome: (snapshot) => snapshot.getText(0, snapshot.getLength()) === text,
      }),
    )

  const sync = (
    files: ReadonlyArray<{ readonly path: string; readonly text: string }>,
  ): void => {
    const present = new Set(Array.map(files, (file) => file.path))
    const stale = Array.filter(
      Array.fromIterable(roots.keys()),
      (path) => !present.has(path),
    )
    const fresh = Array.filter(files, (file) => !unchanged(file.path, file.text))
    if (stale.length === 0 && fresh.length === 0) return
    stale.forEach((path) => {
      roots.delete(path)
      language.scripts.delete(asUri(path))
    })
    fresh.forEach((file) => {
      const snapshot = ts.ScriptSnapshot.fromString(file.text)
      roots.set(file.path, snapshot)
      language.scripts.set(asUri(file.path), snapshot)
    })
    projectVersion++
  }

  return {
    sync,
    diagnostics: (fileName) => service.getDiagnostics(asUri(fileName)),
    hover: (fileName, position) => service.getHover(asUri(fileName), position),
    completions: (fileName, position) =>
      service.getCompletionItems(asUri(fileName), position),
    definition: (fileName, position) =>
      service.getDefinition(asUri(fileName), position),
    references: (fileName, position) =>
      service.getReferences(asUri(fileName), position, {
        includeDeclaration: true,
      }),
    rename: (fileName, position, newName) =>
      service.getRenameEdits(asUri(fileName), position, newName),
    codeActions: (fileName, range, context) =>
      service.getCodeActions(asUri(fileName), range, context),
    resolveCodeAction: (action) => service.resolveCodeAction(action),
    dispose: () => service.dispose(),
  }
}
