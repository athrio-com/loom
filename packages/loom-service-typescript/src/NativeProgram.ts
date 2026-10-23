import { Array, Data, Match, Option, pipe } from 'effect'
import { accessSync, constants, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type {
  CodeAction,
  Command,
  CompletionItem,
  CompletionList,
  Diagnostic,
  Hover,
  Location,
  LocationLink,
  Position,
  WorkspaceEdit,
} from '@volar/language-service'
import { URI } from 'vscode-uri'
import { type LanguageServerProcess, spawnLanguageServer } from './LanguageServerProcess'
import type { ProductFile, ProductProgram } from './ProductProgram'
import type { ProductProject } from './TypescriptService'

export type CompilerChoice = Data.TaggedEnum<{
  Classic: {}
  Native: { readonly executable: string }
  Unavailable: { readonly reason: string }
}>

export const CompilerChoice = Data.taggedEnum<CompilerChoice>()

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

const choiceFromProject = (project: ProductProject): CompilerChoice =>
  pipe(
    typescriptPackageFrom(projectFolder(project)),
    Option.flatMap((packageJson) =>
      Option.map(
        Option.filter(manifestOf(packageJson), (manifest) => manifest.major >= 7),
        ({ major }) => ({ packageJson, major }),
      ),
    ),
    Option.match({
      onNone: () => CompilerChoice.Classic(),
      onSome: ({ packageJson, major }) =>
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
  const packageJson = join(folder, 'package.json')
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
): CompilerChoice =>
  Option.match(setting, {
    onNone: () => choiceFromProject(project),
    onSome: (named) =>
      typeof named === 'string' && named.trim() !== ''
        ? choiceFromSetting(project, named)
        : CompilerChoice.Unavailable({
            reason: 'the nativeCompiler setting must be the path of a TypeScript 7 folder',
          }),
  })

export class NativeCompilerUnavailable extends Data.TaggedError('NativeCompilerUnavailable')<{
  readonly reason: string
}> {
  get message(): string {
    return `TypeScript 7 is unavailable: ${this.reason}`
  }
}

const failureDiagnostic = (message: string): Diagnostic => ({
  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
  severity: 1,
  source: 'loom',
  message,
})

const reportOnce = (reported: Set<string>, message: string): void => {
  if (reported.has(message)) return
  reported.add(message)
  console.warn(`loom: ${message}`)
}

export const createUnavailableProgram = (reason: string): ProductProgram => {
  const failure = new NativeCompilerUnavailable({ reason })
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
    dispose: () => undefined,
  }
}

const openSet = (
  before: ReadonlyMap<string, ProductFile>,
  composition: ReadonlyMap<string, ProductFile>,
  listed: ReadonlyArray<ProductFile>,
  warmed: boolean,
  servedBy: (file: ProductFile) => boolean,
): ReadonlyMap<string, ProductFile> => {
  const fromBefore = Array.getSomes(
    Array.map(Array.fromIterable(before.keys()), (path) => Option.fromNullishOr(composition.get(path))),
  )
  const fromWarmUp = warmed
    ? Array.filter(Array.fromIterable(composition.values()), servedBy)
    : []
  return new Map([
    ...Array.map(
      Array.filter([...fromBefore, ...fromWarmUp], (file) => !file.loose),
      (file) => [file.path, file] as const,
    ),
    ...Array.map(
      Array.filter(listed, (file) => file.loose === true || servedBy(file)),
      (file) => [file.path, file] as const,
    ),
  ])
}

const maxRestarts = 3

export interface NativeProgramOptions {
  readonly stableFor: number
}

const defaultOptions: NativeProgramOptions = { stableFor: 5 * 60_000 }

export class NativeServerStopped extends Data.TaggedError('NativeServerStopped')<{
  readonly compiler: string
  readonly workspace: string
}> {
  get message(): string {
    return (
      `TypeScript 7 (${this.compiler}) stopped ${maxRestarts + 1} times in ${this.workspace}; ` +
      'its features are off until the Loom language server restarts'
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
  servedBy: (file: ProductFile) => boolean = () => true,
  options: NativeProgramOptions = defaultOptions,
): ProductProgram => {
  const state: {
    open: ReadonlyMap<string, ProductFile>
    composition: ReadonlyMap<string, ProductFile>
    listed: ReadonlyArray<ProductFile>
    warmed: boolean
    disposed: boolean
    server: Option.Option<LanguageServerProcess>
    restarts: number
  } = {
    open: new Map(),
    composition: new Map(),
    listed: [],
    warmed: false,
    disposed: false,
    server: Option.none(),
    restarts: 0,
  }
  const reported = new Set<string>()

  const makeFolders = (files: ReadonlyArray<ProductFile>): void =>
    Array.dedupe(
      Array.map(
        Array.filter(files, (file) => !file.loose && servedBy(file)),
        (file) => dirname(file.path),
      ),
    ).forEach((folder) => {
      if (!existsSync(folder)) mkdirSync(folder, { recursive: true })
    })

  const pushOpen = (): void =>
    Option.match(state.server, {
      onNone: () => undefined,
      onSome: (server) => {
        const files = Array.fromIterable(state.open.values())
        makeFolders(files)
        server.keepOpen(files)
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
      },
    })
    state.server = Option.some(server)
    pushOpen()
    return server
  }

  const restart = (previous: LanguageServerProcess): Option.Option<LanguageServerProcess> => {
    if (previous.uptime() >= options.stableFor) state.restarts = 0
    if (state.restarts >= maxRestarts) return Option.none()
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
    state.open = openSet(state.open, state.composition, state.listed, true, servedBy)
    pushOpen()
    void Array.reduce(
      Array.filter(
        Array.fromIterable(state.composition.values()),
        (file) => !file.loose && servedBy(file),
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

  const ask = <A>(fileName: string, method: string, params: unknown): Promise<A> => {
    openForQuestion(fileName)
    return Option.match(running(), {
      onNone: () =>
        Promise.reject(
          state.disposed
            ? new NativeProgramDisposed({ workspace })
            : new NativeServerStopped({ compiler, workspace }),
        ),
      onSome: (server) => {
        const answer = server.request<A>(method, params)
        void answer.then(warm, () => undefined)
        return answer
      },
    })
  }

  const orNothing =
    <A>(empty: A) =>
    (failure: unknown): A => {
      reportOnce(reported, String((failure as Error)?.message ?? failure))
      return empty
    }

  const orFailureDiagnostic = (failure: unknown): Diagnostic[] => {
    const message = String((failure as Error)?.message ?? failure)
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
      state.open = openSet(state.open, state.composition, listed, state.warmed, servedBy)
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
    completions: (fileName, position) =>
      ask<CompletionList | CompletionItem[] | null>(
        fileName,
        'textDocument/completion',
        at(fileName, position),
      )
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
    resolveCodeAction: (action) =>
      action.edit === undefined
        ? ask<CodeAction | null>('', 'codeAction/resolve', action)
            .then((resolved) => resolved ?? action)
            .catch(orNothing(action))
        : Promise.resolve(action),
    dispose: () => {
      state.disposed = true
      Option.match(state.server, {
        onNone: () => undefined,
        onSome: (server) => server.dispose(),
      })
    },
  }
}
