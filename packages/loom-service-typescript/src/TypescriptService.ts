import { Array, Effect, Option } from 'effect'
import type {
  CodeAction,
  LanguageServicePlugin,
  WorkspaceEdit,
} from '@volar/language-service'
import { URI } from 'vscode-uri'
import { dirname } from 'node:path'
import type { CompilerOptions } from 'typescript'
import {
  Composition,
  type ComposedFile,
  type CompositionApi,
  defineLanguageService,
  TypescriptSdk,
} from '@athrio/loom-lang-services/LanguageService'
import { createProductProgram, type ProductProgram } from './ProductProgram'

type TypeScript = typeof import('typescript')

const loomOverrides = (
  options: CompilerOptions,
): CompilerOptions => ({
  ...options,
  noEmit: true,
  allowImportingTsExtensions: true,
})

const baselineOptions = (ts: TypeScript): CompilerOptions =>
  loomOverrides({
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    skipLibCheck: true,
  })

const consumerOptions = (ts: TypeScript, loomPath: string): CompilerOptions => {
  const found = ts.findConfigFile(dirname(loomPath), ts.sys.fileExists, 'tsconfig.json')
  if (found === undefined) return baselineOptions(ts)
  const read = ts.readConfigFile(found, ts.sys.readFile)
  const parsed = ts.parseJsonConfigFileContent(read.config ?? {}, ts.sys, dirname(found))
  return loomOverrides(parsed.options)
}

export interface ProductTarget {
  readonly program: ProductProgram
  readonly fileName: string
  readonly roots: ReadonlyArray<ComposedFile>
}

const tsExtension: ReadonlyMap<string, string> = new Map([
  ['typescript', '.ts'],
  ['tsx', '.tsx'],
  ['javascript', '.js'],
  ['jsx', '.jsx'],
])

export const productTarget = (
  decoded: readonly [URI, string] | undefined,
  languageId: string,
  text: string,
  programFor: (loomPath: string) => ProductProgram,
  rootsFor: (loomPath: string) => ReadonlyArray<ComposedFile>,
): ProductTarget | undefined => {
  const extension = tsExtension.get(languageId)
  if (decoded === undefined || extension === undefined) return undefined
  const [loomUri, rootId] = decoded
  const loomPath = loomUri.fsPath
  const composed = rootsFor(loomPath)
  const sink = Array.findFirst(
    composed,
    (file) => file.loomPath === loomPath && file.rootId === rootId,
  )
  const edited: ComposedFile = Option.getOrElse(sink, () => ({
    path: `${loomPath}.${rootId}${extension}`,
    content: text,
    loomPath,
    rootId,
  }))
  const roots = Option.match(sink, {
    onNone: () => Array.append(composed, edited),
    onSome: () => composed,
  })
  const program = programFor(loomPath)
  program.sync(
    Array.map(roots, (file) => ({
      path: file.path,
      text: file === edited ? text : file.content,
    })),
  )
  return { program, fileName: edited.path, roots }
}

const productPlugin = (
  ts: TypeScript,
  composition: CompositionApi,
): LanguageServicePlugin => ({
  name: 'loom-typescript-product',
  capabilities: {
    diagnosticProvider: { interFileDependencies: false, workspaceDiagnostics: false },
    hoverProvider: true,
    completionProvider: { triggerCharacters: ['.'] },
    definitionProvider: true,
    referencesProvider: true,
    renameProvider: {},
    codeActionProvider: {
      codeActionKinds: ['quickfix', 'refactor', 'source.organizeImports'],
    },
  },
  create: (context) => {
    const programs = new Map<string, ProductProgram>()
    const programFor = (loomPath: string): ProductProgram => {
      const existing = programs.get(loomPath)
      if (existing !== undefined) return existing
      const program = createProductProgram(ts, consumerOptions(ts, loomPath))
      programs.set(loomPath, program)
      return program
    }
    const targetOf = (
      uri: string,
      languageId: string,
      text: string,
    ): ProductTarget | undefined =>
      productTarget(
        context.decodeEmbeddedDocumentUri(URI.parse(uri)),
        languageId,
        text,
        programFor,
        composition.rootsFor,
      )

    const embeddedUriOf = (
      roots: ReadonlyArray<ComposedFile>,
      uri: string,
    ): string =>
      Option.match(
        Array.findFirst(roots, (file) => file.path === URI.parse(uri).fsPath),
        {
          onNone: () => uri,
          onSome: (file) =>
            context
              .encodeEmbeddedDocumentUri(URI.file(file.loomPath), file.rootId)
              .toString(),
        },
      )

    const remapEdit = (
      roots: ReadonlyArray<ComposedFile>,
      edit: WorkspaceEdit,
    ): WorkspaceEdit => ({
      ...edit,
      changes:
        edit.changes === undefined
          ? undefined
          : Object.fromEntries(
              Object.entries(edit.changes).map(([uri, edits]) => [
                embeddedUriOf(roots, uri),
                edits,
              ]),
            ),
      documentChanges: edit.documentChanges?.map((change) =>
        'textDocument' in change
          ? {
              ...change,
              textDocument: {
                ...change.textDocument,
                uri: embeddedUriOf(roots, change.textDocument.uri),
              },
            }
          : change,
      ),
    })

    const remapAction = (
      roots: ReadonlyArray<ComposedFile>,
      action: CodeAction,
    ): CodeAction =>
      action.edit === undefined
        ? action
        : { ...action, edit: remapEdit(roots, action.edit) }

    return {
      provideDiagnostics: (document) => {
        const target = targetOf(document.uri, document.languageId, document.getText())
        return target === undefined
          ? undefined
          : target.program.diagnostics(target.fileName)
      },
      provideHover: (document, position) => {
        const target = targetOf(document.uri, document.languageId, document.getText())
        return target === undefined
          ? undefined
          : target.program.hover(target.fileName, position)
      },
      provideCompletionItems: (document, position) => {
        const target = targetOf(document.uri, document.languageId, document.getText())
        return target === undefined
          ? undefined
          : target.program.completions(target.fileName, position)
      },
      provideDefinition: (document, position) => {
        const target = targetOf(document.uri, document.languageId, document.getText())
        return target === undefined
          ? undefined
          : target.program
              .definition(target.fileName, position)
              .then((links) =>
                links?.map((link) => ({
                  ...link,
                  targetUri: embeddedUriOf(target.roots, link.targetUri),
                })),
              )
      },
      provideReferences: (document, position) => {
        const target = targetOf(document.uri, document.languageId, document.getText())
        return target === undefined
          ? undefined
          : target.program
              .references(target.fileName, position)
              .then((locations) =>
                locations?.map((location) => ({
                  ...location,
                  uri: embeddedUriOf(target.roots, location.uri),
                })),
              )
      },
      provideRenameEdits: (document, position, newName) => {
        const target = targetOf(document.uri, document.languageId, document.getText())
        return target === undefined
          ? undefined
          : target.program
              .rename(target.fileName, position, newName)
              .then((edit) =>
                edit === undefined ? edit : remapEdit(target.roots, edit),
              )
      },
      provideCodeActions: (document, range, context) => {
        const target = targetOf(document.uri, document.languageId, document.getText())
        return target === undefined
          ? undefined
          : target.program
              .codeActions(target.fileName, range, context)
              .then((actions) =>
                actions === undefined
                  ? undefined
                  : Promise.all(
                      actions.map((action) =>
                        (action.edit === undefined
                          ? target.program.resolveCodeAction(action)
                          : Promise.resolve(action)
                        ).then((resolved) => remapAction(target.roots, resolved)),
                      ),
                    ),
              )
      },
      dispose: () => programs.forEach((program) => program.dispose()),
    }
  },
})

export const TypescriptService = defineLanguageService({
  id: 'typescript',
  displayName: 'TypeScript',
  extensions: ['.ts', '.tsx'],
  plugins: () =>
    Effect.gen(function* () {
      const ts = yield* TypescriptSdk
      const composition = yield* Composition
      return [productPlugin(ts, composition)]
    }),
})

export default TypescriptService
