import { Array, Data, Match, Option, pipe, Result } from 'effect'
import { accessSync, constants, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type {
  CodeAction,
  Command,
  CompletionItem,
  CompletionList,
  Diagnostic,
  DocumentSymbol,
  FoldingRange,
  Hover,
  Location,
  LocationLink,
  Position,
  SelectionRange,
  WorkspaceEdit,
} from '@volar/language-service'
import { URI } from 'vscode-uri'
import type { FetchedTypeScript } from '@athrio/loom-lang-services/LanguageService'
import {
  FailureReason,
  LanguageServerFailed,
  type LanguageServerProcess,
  spawnLanguageServer,
} from './LanguageServerProcess'
import type { ProductFile, ProductProgram } from './ProductProgram'
import type { ProductProject } from './TypescriptService'

export type CompilerChoice = Data.TaggedEnum<{
  Classic: {}
  Native: { readonly executable: string }
  Fetched: { readonly version: string; readonly executable: string }
  Unavailable: { readonly reason: string }
}>

export const CompilerChoice = Data.taggedEnum<CompilerChoice>()

export const executableOf = (choice: CompilerChoice): Option.Option<string> =>
  CompilerChoice.$match(choice, {
    Classic: () => Option.none(),
    Native: ({ executable }) => Option.some(executable),
    Fetched: ({ executable }) => Option.some(executable),
    Unavailable: () => Option.none(),
  })

const executableName = process.platform === 'win32' ? 'tsc.exe' : 'tsc'
const companionPackage = `@typescript/typescript-${process.platform}-${process.arch}`

interface PackageManifest {
  readonly name: string
  readonly major: number
}

const manifestOf = (packageJson: string): Option.Option<PackageManifest> =>
  pipe(
    Option.liftThrowable(() => JSON.parse(readFileSync(packageJson, 'utf8')))(),
    Option.map((manifest) => ({
      name: String(manifest?.name ?? ''),
      major: Number(String(manifest?.version ?? '').split('.')[0]),
    })),
    Option.filter((manifest) => Number.isFinite(manifest.major)),
  )

const executable = (path: string): boolean =>
  Option.isSome(Option.liftThrowable(() => accessSync(path, constants.X_OK))())

const nativeExecutable = (typescriptPackageJson: string): Option.Option<string> =>
  pipe(
    Option.liftThrowable(() =>
      createRequire(typescriptPackageJson).resolve(`${companionPackage}/package.json`),
    )(),
    Option.map((companion) => join(dirname(companion), 'lib', executableName)),
    Option.filter(executable),
  )

const typescriptPackageFrom = (folder: string): Option.Option<string> =>
  Option.liftThrowable(() =>
    createRequire(join(folder, 'package.json')).resolve('typescript/package.json'),
  )()

export const projectFolder = (project: ProductProject): string =>
  Option.match(project.config, { onNone: () => dirname(project.loom), onSome: dirname })

const choiceFromPackage = (project: ProductProject, packageJson: string): CompilerChoice =>
  pipe(
    manifestOf(packageJson),
    Option.filter((manifest) => manifest.major >= 7),
    Option.match({
      onNone: () => CompilerChoice.Classic(),
      onSome: ({ major }) =>
        Option.match(nativeExecutable(packageJson), {
          onSome: (path) => CompilerChoice.Native({ executable: path }),
          onNone: () =>
            CompilerChoice.Unavailable({
              reason:
                `the project at ${projectFolder(project)} installs TypeScript ${major}, ` +
                `but not its native executable for this platform; install ${companionPackage}`,
            }),
        }),
    }),
  )

const choiceFromProject = (project: ProductProject, fetched: FetchedTypeScript): CompilerChoice =>
  Option.match(typescriptPackageFrom(projectFolder(project)), {
    onNone: () =>
      CompilerChoice.Fetched({ version: fetched.version, executable: fetched.executable }),
    onSome: (packageJson) => choiceFromPackage(project, packageJson),
  })

const workspaceRootOf = (loom: string): string => {
  const climb = (folder: string): Option.Option<string> => {
    if (existsSync(join(folder, '.loom', 'config.yaml'))) return Option.some(folder)
    const parent = dirname(folder)
    return parent === folder ? Option.none() : climb(parent)
  }
  return Option.getOrElse(climb(dirname(loom)), () => dirname(loom))
}

const choiceFromSetting = (project: ProductProject, setting: string): CompilerChoice => {
  const folder = isAbsolute(setting) ? setting : resolve(workspaceRootOf(project.loom), setting)
  const real = Option.getOrElse(Option.liftThrowable(() => realpathSync(folder))(), () => folder)
  const packageJson = join(real, 'package.json')
  const named = `the nativeCompiler setting names ${folder}`
  return Option.match(
    Option.filter(manifestOf(packageJson), (manifest) => manifest.name === 'typescript'),
    {
      onNone: () =>
        CompilerChoice.Unavailable({ reason: `${named}, which holds no typescript package` }),
      onSome: ({ major }) =>
        major < 7
          ? CompilerChoice.Unavailable({ reason: `${named}, which holds TypeScript ${major}, not 7` })
          : Option.match(nativeExecutable(packageJson), {
              onSome: (path) => CompilerChoice.Native({ executable: path }),
              onNone: () =>
                CompilerChoice.Unavailable({
                  reason: `${named}, which has no native executable for this platform`,
                }),
            }),
    },
  )
}

export const compilerChoiceFor = (
  project: ProductProject,
  setting: Option.Option<unknown>,
  fetched: FetchedTypeScript,
): CompilerChoice =>
  Option.match(setting, {
    onNone: () => choiceFromProject(project, fetched),
    onSome: (named) =>
      typeof named === 'string' && named.trim() !== ''
        ? choiceFromSetting(project, named)
        : CompilerChoice.Unavailable({
            reason: 'the nativeCompiler setting must be the path of a TypeScript 7 folder',
          }),
  })

export class CompilerUnavailable extends Data.TaggedError('CompilerUnavailable')<{
  readonly compiler: string
  readonly reason: string
}> {
  get message(): string {
    return `${this.compiler} is unavailable: ${this.reason}`
  }
}

const failureDiagnostic = (message: string): Diagnostic => ({
  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
  severity: 1,
  source: 'loom',
  message,
})

const messageOf = (failure: unknown): string => String((failure as Error)?.message ?? failure)

const reportOnce = (reported: Set<string>, message: string): void => {
  if (reported.has(message)) return
  reported.add(message)
  console.warn(`loom: ${message}`)
}

export const createUnavailableProgram = (compiler: string, reason: string): ProductProgram => {
  const failure = new CompilerUnavailable({ compiler, reason })
  const reported = new Set<string>()
  const nothing = <A>(empty: A): Promise<A> => {
    reportOnce(reported, failure.message)
    return Promise.resolve(empty)
  }
  return {
    sync: () => undefined,
    diagnostics: () => nothing([failureDiagnostic(failure.message)]),
    hover: () => nothing(undefined),
    completions: () => nothing({ isIncomplete: false, items: [] }),
    definition: () => nothing(undefined),
    references: () => nothing(undefined),
    rename: () => nothing(undefined),
    codeActions: () => nothing([]),
    resolveCodeAction: (action) => nothing(action),
    documentSymbols: () => nothing(undefined),
    foldingRanges: () => nothing(undefined),
    selectionRanges: () => nothing(undefined),
    dispose: () => undefined,
  }
}

export type NativeProjectOf = (file: ProductFile) => Option.Option<string>

export const inferredProject = 'the inferred project'

const asOpened = (file: ProductFile): ProductFile =>
  file.loose === true ? { ...file, text: `${file.text}\nexport {}\n` } : file

const openSet = (
  before: ReadonlyMap<string, ProductFile>,
  composition: ReadonlyMap<string, ProductFile>,
  listed: ReadonlyArray<ProductFile>,
  warmed: boolean,
  nativeProjectOf: NativeProjectOf,
): ReadonlyMap<string, ProductFile> => {
  const served = (file: ProductFile): boolean => Option.isSome(nativeProjectOf(file))
  const sunk = (files: Iterable<ProductFile>): ReadonlyArray<ProductFile> =>
    Array.filter(Array.fromIterable(files), (file) => file.loose !== true)
  const asked = new Set(Array.getSomes(Array.map(listed, nativeProjectOf)))
  const fromProjects = Array.filter(sunk(composition.values()), (file) =>
    Option.exists(nativeProjectOf(file), (project) => asked.has(project)),
  )
  const fromBefore = Array.getSomes(
    Array.map(sunk(before.values()), (file) => Option.fromNullishOr(composition.get(file.path))),
  )
  const fromWarmUp = warmed ? Array.filter(sunk(composition.values()), served) : []
  const fromListed = Array.filter(listed, (file) => file.loose === true || served(file))
  return new Map(
    Array.map(
      [...fromBefore, ...fromProjects, ...fromWarmUp, ...fromListed],
      (file) => [file.path, file] as const,
    ),
  )
}

const maxRestarts = 3

export interface NativeProgramOptions {
  readonly stableFor: number
  readonly ready: () => Promise<void>
}

const defaultOptions: NativeProgramOptions = {
  stableFor: 5 * 60_000,
  ready: () => Promise.resolve(),
}

const incurable = (failure: unknown): boolean =>
  failure instanceof LanguageServerFailed &&
  (FailureReason.$is('CouldNotStart')(failure.reason) || FailureReason.$is('Unreachable')(failure.reason))

export class NativeServerStopped extends Data.TaggedError('NativeServerStopped')<{
  readonly compiler: string
  readonly workspace: string
  readonly starts: number
  readonly lastFailure: Option.Option<string>
}> {
  get message(): string {
    const times = this.starts === 1 ? 'once' : `${this.starts} times`
    return (
      `TypeScript 7 (${this.compiler}) stopped ${times} in ${this.workspace}; ` +
      'its features are off until the Loom language server restarts' +
      Option.match(this.lastFailure, { onNone: () => '', onSome: (last) => `. The last failure: ${last}` })
    )
  }
}

export class NativeProgramDisposed extends Data.TaggedError('NativeProgramDisposed')<{
  readonly workspace: string
}> {
  get message(): string {
    return `the TypeScript 7 program for ${this.workspace} was shut down`
  }
}

export const createNativeProgram = (
  compiler: string,
  workspace: string,
  nativeProjectOf: NativeProjectOf = () => Option.some(inferredProject),
  chosen: Partial<NativeProgramOptions> = {},
): ProductProgram => {
  const options: NativeProgramOptions = { ...defaultOptions, ...chosen }
  const state: {
    open: ReadonlyMap<string, ProductFile>
    waiting: ReadonlyMap<string, { readonly file: ProductFile; readonly count: number }>
    composition: ReadonlyMap<string, ProductFile>
    listed: ReadonlyArray<ProductFile>
    warmed: boolean
    disposed: boolean
    server: Option.Option<LanguageServerProcess>
    restarts: number
    incurable: boolean
    lastFailure: Option.Option<string>
  } = {
    open: new Map(),
    waiting: new Map(),
    composition: new Map(),
    listed: [],
    warmed: false,
    disposed: false,
    server: Option.none(),
    restarts: 0,
    incurable: false,
    lastFailure: Option.none(),
  }
  const reported = new Set<string>()
  const served = (file: ProductFile): boolean => Option.isSome(nativeProjectOf(file))

  const insideWorkspace = (folder: string, loom: string): boolean => {
    const path = relative(workspaceRootOf(loom), folder)
    return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
  }

  const makeFolder = (folder: string, loom: string): void => {
    if (existsSync(folder)) return
    if (!insideWorkspace(folder, loom)) {
      reportOnce(reported, `${folder} lies outside the workspace, so the editor leaves it to the tangle`)
      return
    }
    Result.match(Result.try(() => mkdirSync(folder, { recursive: true })), {
      onSuccess: () => undefined,
      onFailure: (cause) => reportOnce(reported, `could not make ${folder}: ${messageOf(cause)}`),
    })
  }

  const makeFolders = (files: ReadonlyArray<ProductFile>): void =>
    new Map(
      Array.getSomes(
        Array.map(
          Array.filter(files, (file) => !file.loose && served(file)),
          (file) => Option.map(Option.fromNullishOr(file.loom), (loom) => [dirname(file.path), loom] as const),
        ),
      ),
    ).forEach((loom, folder) => makeFolder(folder, loom))

  const pushOpen = (): void =>
    Option.match(state.server, {
      onNone: () => undefined,
      onSome: (server) => {
        const files = Array.fromIterable(
          new Map([
            ...Array.map(Array.fromIterable(state.waiting.values()), ({ file }) => [file.path, file] as const),
            ...state.open,
          ]).values(),
        )
        makeFolders(files)
        server.keepOpen(Array.map(files, asOpened))
      },
    })

  const start = (): LanguageServerProcess => {
    const server = spawnLanguageServer(compiler, ['--lsp', '--stdio'], workspace, 'typescript', {
      textDocument: {
        hover: { contentFormat: ['markdown', 'plaintext'] },
        definition: { linkSupport: true },
        diagnostic: {},
        completion: { completionItem: { documentationFormat: ['markdown', 'plaintext'] } },
        codeAction: {
          codeActionLiteralSupport: {
            codeActionKind: { valueSet: ['quickfix', 'refactor', 'source'] },
          },
          resolveSupport: { properties: ['edit'] },
          dataSupport: true,
        },
        rename: {},
        references: {},
        documentSymbol: { hierarchicalDocumentSymbolSupport: true },
        foldingRange: {},
        selectionRange: {},
      },
    })
    state.server = Option.some(server)
    pushOpen()
    return server
  }

  const restart = (previous: LanguageServerProcess): Option.Option<LanguageServerProcess> => {
    if (previous.uptime() >= options.stableFor) state.restarts = 0
    if (state.incurable || state.restarts >= maxRestarts) return Option.none()
    state.restarts += 1
    previous.dispose()
    state.warmed = false
    return Option.some(start())
  }

  const live = (): Option.Option<LanguageServerProcess> =>
    Option.filter(state.server, (server) => !state.disposed && server.alive())

  const running = (): Option.Option<LanguageServerProcess> =>
    state.disposed
      ? Option.none()
      : Option.match(state.server, {
          onNone: () => Option.some(start()),
          onSome: (previous) => Option.orElse(live(), () => restart(previous)),
        })

  const warmOne = (path: string): Promise<boolean> =>
    Option.match(live(), {
      onNone: () => Promise.resolve(false),
      onSome: (server) =>
        server
          .request('textDocument/diagnostic', { textDocument: { uri: URI.file(path).toString() } })
          .then(
            () => true,
            () => server.alive(),
          ),
    })

  const warm = (): void => {
    if (state.warmed || state.disposed) return
    state.warmed = true
    state.open = openSet(state.open, state.composition, state.listed, true, nativeProjectOf)
    pushOpen()
    void Array.reduce(
      Array.filter(
        Array.fromIterable(state.composition.values()),
        (file) => !file.loose && served(file),
      ),
      Promise.resolve(true),
      (previous, file) => previous.then((going) => (going ? warmOne(file.path) : false)),
    )
  }

  const openForQuestion = (fileName: string): void =>
    Option.match(Option.fromNullishOr(state.composition.get(fileName)), {
      onNone: () => undefined,
      onSome: (file) => {
        if (state.open.has(fileName)) return
        state.open = new Map([...state.open, [fileName, file] as const])
        pushOpen()
      },
    })

  const waitingCount = (fileName: string): number =>
    Option.match(Option.fromNullishOr(state.waiting.get(fileName)), {
      onNone: () => 0,
      onSome: ({ count }) => count,
    })

  const hold = (fileName: string): (() => void) =>
    Option.match(Option.fromNullishOr(state.open.get(fileName)), {
      onNone: () => () => undefined,
      onSome: (file) => {
        state.waiting = new Map([
          ...state.waiting,
          [fileName, { file, count: waitingCount(fileName) + 1 }] as const,
        ])
        return () => {
          const count = waitingCount(fileName) - 1
          state.waiting = new Map(
            count > 0
              ? Array.map(
                  Array.fromIterable(state.waiting),
                  ([path, entry]) => [path, path === fileName ? { ...entry, count } : entry] as const,
                )
              : Array.filter(Array.fromIterable(state.waiting), ([path]) => path !== fileName),
          )
          if (count === 0 && !state.open.has(fileName)) pushOpen()
        }
      },
    })

  const ask = <A>(fileName: string, method: string, params: unknown): Promise<A> => {
    openForQuestion(fileName)
    const release = hold(fileName)
    const answered: Promise<A> = Promise.resolve().then(options.ready).then(() =>
      Option.match(running(), {
        onNone: () =>
          Promise.reject(
            state.disposed
              ? new NativeProgramDisposed({ workspace })
              : new NativeServerStopped({
                  compiler,
                  workspace,
                  starts: state.restarts + 1,
                  lastFailure: state.lastFailure,
                }),
          ),
        onSome: (server) => {
          const answer = server.request<A>(method, params)
          void answer
            .then(warm, (failure) => {
              state.lastFailure = Option.some(messageOf(failure))
              state.incurable = state.incurable || incurable(failure)
            })
            .catch(orNothing(undefined))
          return answer
        },
      }),
    )
    void answered.then(release, release)
    return answered
  }

  const orNothing =
    <A>(empty: A) =>
    (failure: unknown): A => {
      reportOnce(reported, messageOf(failure))
      return empty
    }

  const orFailureDiagnostic = (failure: unknown): Diagnostic[] => {
    const message = messageOf(failure)
    reportOnce(reported, message)
    return [failureDiagnostic(message)]
  }

  const document = (fileName: string) => ({ uri: URI.file(fileName).toString() })
  const at = (fileName: string, position: Position) => ({ textDocument: document(fileName), position })

  const asLink = (each: Location | LocationLink): LocationLink =>
    'targetUri' in each
      ? each
      : { targetUri: each.uri, targetRange: each.range, targetSelectionRange: each.range }

  const asLinks = (found: ReadonlyArray<Location | LocationLink> | Location | null): LocationLink[] =>
    Array.map(
      Match.value(found).pipe(
        Match.when(Match.null, () => []),
        Match.when(
          (value: unknown): value is ReadonlyArray<Location | LocationLink> =>
            globalThis.Array.isArray(value),
          (all) => all,
        ),
        Match.orElse((one) => [one as Location]),
      ),
      asLink,
    )

  const asCompletionList = (found: CompletionList | CompletionItem[] | null): CompletionList =>
    Match.value(found).pipe(
      Match.when(Match.null, (): CompletionList => ({ isIncomplete: false, items: [] })),
      Match.when(
        (value: unknown): value is CompletionItem[] => globalThis.Array.isArray(value),
        (items): CompletionList => ({ isIncomplete: false, items }),
      ),
      Match.orElse((list) => list as CompletionList),
    )

  return {
    sync: (listed, others = []) => {
      state.composition = new Map(
        Array.map([...listed, ...others], (file) => [file.path, file] as const),
      )
      state.listed = listed
      state.open = openSet(state.open, state.composition, listed, state.warmed, nativeProjectOf)
      pushOpen()
    },
    hover: (fileName, position) =>
      ask<Hover | null>(fileName, 'textDocument/hover', at(fileName, position))
        .then((hover) => hover ?? undefined)
        .catch(orNothing<Hover | undefined>(undefined)),
    definition: (fileName, position) =>
      ask<ReadonlyArray<Location | LocationLink> | Location | null>(
        fileName,
        'textDocument/definition',
        at(fileName, position),
      )
        .then(asLinks)
        .catch(orNothing<LocationLink[] | undefined>(undefined)),
    diagnostics: (fileName) =>
      ask<{ readonly items?: Diagnostic[] }>(fileName, 'textDocument/diagnostic', {
        textDocument: document(fileName),
      })
        .then((report) => report.items ?? [])
        .catch(orFailureDiagnostic),
    completions: (fileName, position, context) =>
      ask<CompletionList | CompletionItem[] | null>(fileName, 'textDocument/completion', {
        ...at(fileName, position),
        context,
      })
        .then(asCompletionList)
        .catch(orNothing<CompletionList>({ isIncomplete: false, items: [] })),
    references: (fileName, position) =>
      ask<Location[] | null>(fileName, 'textDocument/references', {
        ...at(fileName, position),
        context: { includeDeclaration: true },
      })
        .then((found) => found ?? undefined)
        .catch(orNothing<Location[] | undefined>(undefined)),
    rename: (fileName, position, newName) =>
      ask<WorkspaceEdit | null>(fileName, 'textDocument/rename', { ...at(fileName, position), newName })
        .then((edit) => edit ?? undefined)
        .catch(orNothing<WorkspaceEdit | undefined>(undefined)),
    codeActions: (fileName, range, context) =>
      ask<ReadonlyArray<CodeAction | Command> | null>(fileName, 'textDocument/codeAction', {
        textDocument: document(fileName),
        range,
        context,
      })
        .then((found) =>
          Array.filter(found ?? [], (each): each is CodeAction => typeof each.command !== 'string'),
        )
        .catch(orNothing<CodeAction[]>([])),
    resolveCodeAction: (action, fileName) =>
      action.edit === undefined
        ? ask<CodeAction | null>(fileName, 'codeAction/resolve', action)
            .then((resolved) => resolved ?? action)
            .catch(orNothing(action))
        : Promise.resolve(action),
    documentSymbols: (fileName) =>
      ask<DocumentSymbol[] | null>(fileName, 'textDocument/documentSymbol', {
        textDocument: document(fileName),
      })
        .then((found) => found ?? undefined)
        .catch(orNothing<DocumentSymbol[] | undefined>(undefined)),
    foldingRanges: (fileName) =>
      ask<FoldingRange[] | null>(fileName, 'textDocument/foldingRange', {
        textDocument: document(fileName),
      })
        .then((found) => found ?? undefined)
        .catch(orNothing<FoldingRange[] | undefined>(undefined)),
    selectionRanges: (fileName, positions) =>
      ask<SelectionRange[] | null>(fileName, 'textDocument/selectionRange', {
        textDocument: document(fileName),
        positions,
      })
        .then((found) => found ?? undefined)
        .catch(orNothing<SelectionRange[] | undefined>(undefined)),
    dispose: () => {
      state.disposed = true
      Option.match(state.server, {
        onNone: () => undefined,
        onSome: (server) => server.dispose(),
      })
    },
  }
}
