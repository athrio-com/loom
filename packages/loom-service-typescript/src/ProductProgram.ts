import { Array, Equivalence, Option, pipe } from 'effect'
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
import { createLanguageServiceHost, resolveFileLanguageId } from '@volar/typescript'
import { create as createTypescriptServices } from 'volar-service-typescript'
import { URI } from 'vscode-uri'
import type { CompilerOptions, IScriptSnapshot } from 'typescript'

type TypeScript = typeof import('typescript')

export interface ProductFile {
  readonly path: string
  readonly text: string
  readonly loose?: boolean
  readonly loom?: string
}

export interface ProductProgram {
  readonly sync: (
    listed: ReadonlyArray<ProductFile>,
    others?: ReadonlyArray<ProductFile>,
  ) => void
  readonly diagnostics: (fileName: string) => Promise<Diagnostic[]>
  readonly hover: (fileName: string, position: Position) => Promise<Hover | undefined>
  readonly completions: (fileName: string, position: Position) => Promise<CompletionList>
  readonly definition: (fileName: string, position: Position) => Promise<LocationLink[] | undefined>
  readonly references: (fileName: string, position: Position) => Promise<Location[] | undefined>
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

export const productLanguage = (
  ts: TypeScript,
  roots: ReadonlyMap<string, IScriptSnapshot>,
): Language<URI> => {
  const fromDisk = diskSnapshots(ts)
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
      Option.match(fromDisk(fileName), {
        onSome: (snapshot) => language.scripts.set(uri, snapshot),
        onNone: () => language.scripts.delete(uri),
      })
    },
  )
  return language
}

interface DiskFile {
  readonly modified: Option.Option<number>
  readonly snapshot: Option.Option<IScriptSnapshot>
}

const sameTime = Option.makeEquivalence(Equivalence.Number)

const diskSnapshots = (ts: TypeScript): ((fileName: string) => Option.Option<IScriptSnapshot>) => {
  const disk = new Map<string, DiskFile>()
  const read = (fileName: string, modified: Option.Option<number>): Option.Option<IScriptSnapshot> => {
    const snapshot = Option.map(
      Option.fromNullishOr(ts.sys.fileExists(fileName) ? ts.sys.readFile(fileName) : undefined),
      (text) => ts.ScriptSnapshot.fromString(text),
    )
    disk.set(fileName, { modified, snapshot })
    return snapshot
  }
  return (fileName) => {
    const modified = Option.map(Option.fromNullishOr(ts.sys.getModifiedTime?.(fileName)), (time) =>
      time.valueOf(),
    )
    return pipe(
      Option.fromNullishOr(disk.get(fileName)),
      Option.filter((file) => sameTime(file.modified, modified)),
      Option.match({
        onSome: (file) => file.snapshot,
        onNone: () => read(fileName, modified),
      }),
    )
  }
}

export const createProductProgram = (
  ts: TypeScript,
  compilerOptions: CompilerOptions,
): ProductProgram => {
  const roots = new Map<string, IScriptSnapshot>()
  let fileNames: ReadonlySet<string> = new Set()
  let projectVersion = 0
  const language = productLanguage(ts, roots)
  const asUri = (fileName: string): URI => URI.file(fileName)

  const projectHost = {
    getCurrentDirectory: () => process.cwd(),
    getCompilationSettings: () => compilerOptions,
    getProjectVersion: () => projectVersion.toString(),
    getScriptFileNames: () => [...fileNames],
  }

  const env: LanguageServiceEnvironment = {
    workspaceFolders: [URI.file(process.cwd())],
  }

  const service = createLanguageService(language, createTypescriptServices(ts), env, {
    typescript: {
      configFileName: undefined,
      sys: ts.sys,
      uriConverter: { asFileName: (uri: URI) => uri.fsPath, asUri },
      ...createLanguageServiceHost(ts, ts.sys, language, asUri, projectHost),
    },
  })

  const unchanged = (path: string, text: string): boolean =>
    pipe(
      Option.fromNullishOr(roots.get(path)),
      Option.match({
        onNone: () => false,
        onSome: (snapshot) => snapshot.getText(0, snapshot.getLength()) === text,
      }),
    )

  const sync = (
    listed: ReadonlyArray<ProductFile>,
    others: ReadonlyArray<ProductFile> = [],
  ): void => {
    const files = [...listed, ...others]
    const present = new Set(Array.map(files, (file) => file.path))
    const stale = Array.filter(Array.fromIterable(roots.keys()), (path) => !present.has(path))
    const fresh = Array.filter(files, (file) => !unchanged(file.path, file.text))
    const listing = new Set(Array.map(listed, (file) => file.path))
    const relisted =
      listing.size !== fileNames.size ||
      Array.some(Array.fromIterable(listing), (path) => !fileNames.has(path))
    if (stale.length === 0 && fresh.length === 0 && !relisted) return
    stale.forEach((path) => {
      roots.delete(path)
      language.scripts.delete(asUri(path))
    })
    fresh.forEach((file) => {
      const snapshot = ts.ScriptSnapshot.fromString(file.text)
      roots.set(file.path, snapshot)
      language.scripts.set(asUri(file.path), snapshot)
    })
    fileNames = listing
    projectVersion++
  }

  return {
    sync,
    diagnostics: (fileName) => service.getDiagnostics(asUri(fileName)),
    hover: (fileName, position) => service.getHover(asUri(fileName), position),
    completions: (fileName, position) => service.getCompletionItems(asUri(fileName), position),
    definition: (fileName, position) => service.getDefinition(asUri(fileName), position),
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
