import { Effect } from 'effect'
import type { LanguageServicePlugin } from '@volar/language-service'
import { URI } from 'vscode-uri'
import { dirname } from 'node:path'
import type { CompilerOptions } from 'typescript'
import {
  defineLanguageService,
  TypescriptSdk,
} from '@athrio/loom-lang-services/LanguageService'
import { createProductProgram, type ProductProgram } from './ProductProgram'

type TypeScript = typeof import('typescript')

const baselineOptions = (ts: TypeScript): CompilerOptions => ({
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: true,
  skipLibCheck: true,
  noEmit: true,
})

const consumerOptions = (ts: TypeScript, loomPath: string): CompilerOptions => {
  const found = ts.findConfigFile(dirname(loomPath), ts.sys.fileExists, 'tsconfig.json')
  if (found === undefined) return baselineOptions(ts)
  const read = ts.readConfigFile(found, ts.sys.readFile)
  const parsed = ts.parseJsonConfigFileContent(read.config ?? {}, ts.sys, dirname(found))
  return { ...parsed.options, noEmit: true }
}

export interface ProductTarget {
  readonly program: ProductProgram
  readonly fileName: string
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
): ProductTarget | undefined => {
  const extension = tsExtension.get(languageId)
  if (decoded === undefined || extension === undefined) return undefined
  const [loomUri, rootId] = decoded
  const loomPath = loomUri.fsPath
  const program = programFor(loomPath)
  const fileName = `${loomPath}.${rootId}${extension}`
  program.setRoot(fileName, text)
  return { program, fileName }
}

const productPlugin = (ts: TypeScript): LanguageServicePlugin => ({
  name: 'loom-typescript-product',
  capabilities: {
    diagnosticProvider: { interFileDependencies: false, workspaceDiagnostics: false },
    hoverProvider: true,
    completionProvider: { triggerCharacters: ['.'] },
    definitionProvider: true,
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
      )
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
          : target.program.definition(target.fileName, position)
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
      return [productPlugin(ts)]
    }),
})
