import { Array, Effect, Option, pipe } from 'effect'
import type {
  CodeAction,
  LanguageServicePlugin,
  LocationLink,
  Range,
  WorkspaceEdit,
} from '@volar/language-service'
import { URI } from 'vscode-uri'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { CompilerOptions } from 'typescript'
import {
  Composition,
  type ComposedFile,
  type CompositionApi,
  defineLanguageService,
  type FormatRequest,
  ServiceError,
  TypescriptSdk,
} from '@athrio/loom-lang-services/LanguageService'
import { createProductProgram, type ProductFile, type ProductProgram } from './ProductProgram'
import {
  CompilerChoice,
  compilerChoiceFor,
  createNativeProgram,
  createUnavailableProgram,
  inferredProject,
  type NativeProjectOf,
  projectFolder,
} from './NativeProgram'

type TypeScript = typeof import('typescript')

const loomOverrides = (options: CompilerOptions): CompilerOptions => ({
  ...options,
  noEmit: true,
  allowImportingTsExtensions: true,
  composite: false,
})

const baselineOptions = (ts: TypeScript): CompilerOptions =>
  loomOverrides({
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    skipLibCheck: true,
  })

export const consumerOptions = (ts: TypeScript, config: Option.Option<string>): CompilerOptions =>
  Option.match(config, {
    onNone: () => baselineOptions(ts),
    onSome: (found) =>
      loomOverrides(
        ts.parseJsonConfigFileContent(
          ts.readConfigFile(found, ts.sys.readFile).config ?? {},
          ts.sys,
          dirname(found),
        ).options,
      ),
  })

export const configNear = (ts: TypeScript): ((path: string) => Option.Option<string>) => {
  const found = new Map<string, Option.Option<string>>()
  return (path) => {
    const folder = dirname(path)
    return Option.getOrElse(Option.fromNullishOr(found.get(folder)), () => {
      const config = Option.fromNullishOr(
        ts.findConfigFile(folder, ts.sys.fileExists, 'tsconfig.json'),
      )
      found.set(folder, config)
      return config
    })
  }
}

export type Reach = 'project' | 'corpus'

export interface ProductProject {
  readonly key: string
  readonly config: Option.Option<string>
  readonly loom: string
}

export const projectOf = (
  configOf: (path: string) => Option.Option<string>,
  path: string,
  loom: string,
): ProductProject => {
  const config = configOf(path)
  return { key: Option.getOrElse(config, () => loom), config, loom }
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
  programFor: (project: ProductProject) => ProductProgram,
  rootsFor: (loomPath: string) => ReadonlyArray<ComposedFile>,
  configOf: (path: string) => Option.Option<string>,
  reach: Reach,
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
    heading: {
      path: loomPath,
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
    },
  }))
  const roots = Option.match(sink, {
    onNone: () => Array.append(composed, edited),
    onSome: () => composed,
  })
  const project = projectOf(configOf, edited.path, edited.loomPath)
  const listed = (file: ComposedFile): boolean =>
    reach === 'corpus' || projectOf(configOf, file.path, file.loomPath).key === project.key
  const program = programFor(
    reach === 'corpus' ? { ...project, key: `corpus of ${project.key}` } : project,
  )
  const asFile = (file: ComposedFile): ProductFile => ({
    path: file.path,
    text: file === edited ? text : file.content,
    loose: file === edited && Option.isNone(sink),
    loom: file.loomPath,
  })
  program.sync(
    Array.map(Array.filter(roots, listed), asFile),
    Array.map(
      Array.filter(roots, (file) => !listed(file)),
      asFile,
    ),
  )
  return { program, fileName: edited.path, roots }
}

export const nativeProjectsOf = (
  configOf: (path: string) => Option.Option<string>,
  nativeSetting: Option.Option<unknown>,
): ((executable: string) => NativeProjectOf) => {
  const scriptExtension = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/
  const choices = new Map<string, CompilerChoice>()
  const choiceOf = (file: ProductFile): CompilerChoice => {
    const project = projectOf(configOf, file.path, file.loom ?? file.path)
    return Option.getOrElse(Option.fromNullishOr(choices.get(project.key)), () => {
      const chosen = compilerChoiceFor(project, nativeSetting)
      choices.set(project.key, chosen)
      return chosen
    })
  }
  return (executable) => (file) => {
    const choice = choiceOf(file)
    return scriptExtension.test(file.path) &&
      CompilerChoice.$is('Native')(choice) &&
      choice.executable === executable
      ? Option.some(Option.getOrElse(configOf(file.path), () => inferredProject))
      : Option.none()
  }
}

interface ActionOrigin {
  readonly document: string
  readonly original: unknown
}

export const productPlugin = (
  ts: TypeScript,
  composition: CompositionApi,
  nativeSetting: Option.Option<unknown> = Option.none(),
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
      resolveProvider: true,
    },
  },
  create: (context) => {
    const configOf = configNear(ts)
    const programs = new Map<string, ProductProgram>()
    const nativePrograms = new Map<string, ProductProgram>()
    const actionTargets = new Map<string, ProductTarget>()
    const nativeProjectFor = nativeProjectsOf(configOf, nativeSetting)
    const programFor = (project: ProductProject): ProductProgram => {
      const existing = programs.get(project.key)
      if (existing !== undefined) return existing
      const program = CompilerChoice.$match(compilerChoiceFor(project, nativeSetting), {
        Classic: () => createProductProgram(ts, consumerOptions(ts, project.config)),
        Native: ({ executable }) =>
          Option.getOrElse(Option.fromNullishOr(nativePrograms.get(executable)), () => {
            const shared = createNativeProgram(
              executable,
              projectFolder(project),
              nativeProjectFor(executable),
            )
            nativePrograms.set(executable, shared)
            return shared
          }),
        Unavailable: ({ reason }) => createUnavailableProgram(reason),
      })
      programs.set(project.key, program)
      return program
    }
    const targetOf = (
      uri: string,
      languageId: string,
      text: string,
      reach: Reach,
    ): ProductTarget | undefined =>
      productTarget(
        context.decodeEmbeddedDocumentUri(URI.parse(uri)),
        languageId,
        text,
        programFor,
        composition.rootsFor,
        configOf,
        reach,
      )

    const embeddedUriOf = (roots: ReadonlyArray<ComposedFile>, uri: string): string =>
      Option.match(
        Array.findFirst(roots, (file) => file.path === URI.parse(uri).fsPath),
        {
          onNone: () => uri,
          onSome: (file) =>
            context.encodeEmbeddedDocumentUri(URI.file(file.loomPath), file.rootId).toString(),
        },
      )

    const remapEdit = (roots: ReadonlyArray<ComposedFile>, edit: WorkspaceEdit): WorkspaceEdit => ({
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

    const remapAction = (roots: ReadonlyArray<ComposedFile>, action: CodeAction): CodeAction =>
      action.edit === undefined ? action : { ...action, edit: remapEdit(roots, action.edit) }

    const atFileStart = (range: Range): boolean =>
      range.start.line === 0 &&
      range.start.character === 0 &&
      range.end.line === 0 &&
      range.end.character === 0

    const remapDefinition = (
      roots: ReadonlyArray<ComposedFile>,
      link: LocationLink,
    ): LocationLink =>
      pipe(
        Array.findFirst(roots, (file) => file.path === URI.parse(link.targetUri).fsPath),
        Option.filter(() => atFileStart(link.targetRange)),
        Option.match({
          onNone: () => ({ ...link, targetUri: embeddedUriOf(roots, link.targetUri) }),
          onSome: (file) => ({
            ...link,
            targetUri: URI.file(file.heading.path).toString(),
            targetRange: file.heading.range,
            targetSelectionRange: file.heading.range,
          }),
        }),
      )

    return {
      provideDiagnostics: (document) => {
        const target = targetOf(document.uri, document.languageId, document.getText(), 'project')
        return target === undefined ? undefined : target.program.diagnostics(target.fileName)
      },
      provideHover: (document, position) => {
        const target = targetOf(document.uri, document.languageId, document.getText(), 'project')
        return target === undefined ? undefined : target.program.hover(target.fileName, position)
      },
      provideCompletionItems: (document, position) => {
        const target = targetOf(document.uri, document.languageId, document.getText(), 'project')
        return target === undefined
          ? undefined
          : target.program.completions(target.fileName, position)
      },
      provideDefinition: (document, position) => {
        const target = targetOf(document.uri, document.languageId, document.getText(), 'project')
        return target === undefined
          ? undefined
          : target.program
              .definition(target.fileName, position)
              .then((links) => links?.map((link) => remapDefinition(target.roots, link)))
      },
      provideReferences: (document, position) => {
        const target = targetOf(document.uri, document.languageId, document.getText(), 'corpus')
        return target === undefined
          ? undefined
          : target.program.references(target.fileName, position).then((locations) =>
              locations?.map((location) => ({
                ...location,
                uri: embeddedUriOf(target.roots, location.uri),
              })),
            )
      },
      provideRenameEdits: (document, position, newName) => {
        const target = targetOf(document.uri, document.languageId, document.getText(), 'corpus')
        return target === undefined
          ? undefined
          : target.program
              .rename(target.fileName, position, newName)
              .then((edit) => (edit === undefined ? edit : remapEdit(target.roots, edit)))
      },
      provideCodeActions: (document, range, context) => {
        const target = targetOf(document.uri, document.languageId, document.getText(), 'project')
        if (target === undefined) return undefined
        actionTargets.set(document.uri, target)
        return target.program.codeActions(target.fileName, range, context).then((actions) =>
          actions?.map((action) =>
            action.edit === undefined
              ? {
                  ...action,
                  data: { document: document.uri, original: action.data } satisfies ActionOrigin,
                }
              : remapAction(target.roots, action),
          ),
        )
      },
      resolveCodeAction: (action) =>
        pipe(
          Option.fromNullishOr(action.data as ActionOrigin | undefined),
          Option.flatMap((origin) =>
            Option.map(
              Option.fromNullishOr(actionTargets.get(origin.document)),
              (target) => [origin, target] as const,
            ),
          ),
          Option.match({
            onNone: () => action,
            onSome: ([origin, target]) =>
              target.program
                .resolveCodeAction({ ...action, data: origin.original })
                .then((resolved) => remapAction(target.roots, resolved)),
          }),
        ),
      dispose: () => new Set(programs.values()).forEach((program) => program.dispose()),
    }
  },
})

type Prettier = typeof import('prettier')

const projectPrettier = (path: string): Option.Option<string> =>
  Option.liftThrowable(() => createRequire(path).resolve('prettier'))()

const loadPrettier = (path: string): Effect.Effect<Prettier, ServiceError> =>
  Effect.tryPromise({
    try: async (): Promise<Prettier> => {
      const loaded: Prettier & { readonly default?: Prettier } = await Option.match(
        projectPrettier(path),
        {
          onNone: () => import('prettier'),
          onSome: (resolved) => import(pathToFileURL(resolved).href),
        },
      )
      return loaded.default ?? loaded
    },
    catch: (cause) =>
      new ServiceError({
        service: 'typescript',
        reason: `Prettier did not load: ${String(cause)}`,
      }),
  })

const formatProduct = (request: FormatRequest): Effect.Effect<string, ServiceError> =>
  Effect.gen(function* () {
    const prettier = yield* loadPrettier(request.path)
    const failed = (cause: unknown) =>
      new ServiceError({ service: 'typescript', reason: String(cause) })
    const options = yield* Effect.tryPromise({
      try: () => prettier.resolveConfig(request.path),
      catch: failed,
    })
    return yield* Effect.tryPromise({
      try: () =>
        prettier.format(request.code, {
          ...options,
          parser: 'typescript',
          filepath: request.path,
          printWidth: options?.printWidth ?? request.width,
        }),
      catch: failed,
    })
  })

export const TypescriptService = defineLanguageService({
  id: 'typescript',
  displayName: 'TypeScript',
  extensions: ['.ts', '.tsx'],
  plugins: ({ settings }) =>
    Effect.gen(function* () {
      const ts = yield* TypescriptSdk
      const composition = yield* Composition
      return [productPlugin(ts, composition, Option.fromNullishOr(settings.nativeCompiler))]
    }),
  format: formatProduct,
})

export default TypescriptService
