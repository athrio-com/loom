import { Array, Data, Match, Option, pipe } from 'effect'
import { accessSync, constants, existsSync, readFileSync } from 'node:fs'
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

const majorVersionOf = (packageJson: string): Option.Option<number> =>
  pipe(
    Option.liftThrowable(() => JSON.parse(readFileSync(packageJson, 'utf8')))(),
    Option.flatMap((manifest) => Option.fromNullishOr(manifest?.version)),
    Option.map((version) => Number(String(version).split('.')[0])),
    Option.filter((major) => Number.isFinite(major)),
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
        Option.filter(majorVersionOf(packageJson), (major) => major >= 7),
        (major) => ({ packageJson, major }),
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
  return Option.match(majorVersionOf(packageJson), {
    onNone: () => CompilerChoice.Unavailable({ reason: `${named}, which holds no typescript package` }),
    onSome: (major) =>
      major < 7
        ? CompilerChoice.Unavailable({ reason: `${named}, which holds TypeScript ${major}, not 7` })
        : Option.match(nativeExecutable(packageJson), {
            onSome: (path) => CompilerChoice.Native({ executable: path }),
            onNone: () =>
              CompilerChoice.Unavailable({
                reason: `${named}, which has no native executable for this platform`,
              }),
          }),
  })
}

export const compilerChoiceFor = (
  project: ProductProject,
  setting: Option.Option<string>,
): CompilerChoice =>
  Option.match(setting, {
    onNone: () => choiceFromProject(project),
    onSome: (named) => choiceFromSetting(project, named),
  })

export class NativeCompilerUnavailable extends Data.TaggedError('NativeCompilerUnavailable')<{
  readonly reason: string
}> {
  get message(): string {
    return `TypeScript 7 is unavailable: ${this.reason}`
  }
}

export const createUnavailableProgram = (reason: string): ProductProgram => {
  const fail = <A>(): Promise<A> => Promise.reject(new NativeCompilerUnavailable({ reason }))
  return {
    sync: () => undefined,
    diagnostics: fail,
    hover: fail,
    completions: fail,
    definition: fail,
    references: fail,
    rename: fail,
    codeActions: fail,
    resolveCodeAction: fail,
    dispose: () => undefined,
  }
}



const isLoose = (path: string): boolean => /\.loom\.[^/\\]+\.(ts|tsx|js|jsx)$/.test(path)

const openSet = (
  before: ReadonlyMap<string, ProductFile>,
  composition: ReadonlyMap<string, ProductFile>,
  listed: ReadonlyArray<ProductFile>,
  warmed: boolean,
): ReadonlyMap<string, ProductFile> => {
  const current = new Set(Array.map(listed, (file) => file.path))
  const kept = Array.filter(
    Array.fromIterable(warmed ? composition.keys() : before.keys()),
    (path) => composition.has(path) && (!isLoose(path) || current.has(path)),
  )
  return new Map([
    ...Array.getSomes(
      Array.map(kept, (path) =>
        Option.map(Option.fromNullishOr(composition.get(path)), (file) => [path, file] as const),
      ),
    ),
    ...Array.map(listed, (file) => [file.path, file] as const),
  ])
}

const maxRestarts = 3
const stableFor = 5 * 60_000

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

export const createNativeProgram = (compiler: string, workspace: string): ProductProgram => {
  const state: {
    open: ReadonlyMap<string, ProductFile>
    composition: ReadonlyMap<string, ProductFile>
    warmed: boolean
    disposed: boolean
    server: Option.Option<LanguageServerProcess>
    restarts: number
    startedAt: number
  } = {
    open: new Map(),
    composition: new Map(),
    warmed: false,
    disposed: false,
    server: Option.none(),
    restarts: 0,
    startedAt: 0,
  }

  const pushOpen = (): void =>
    Option.match(state.server, {
      onNone: () => undefined,
      onSome: (server) => server.keepOpen(Array.fromIterable(state.open.values())),
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
    state.startedAt = Date.now()
    pushOpen()
    return server
  }

  const restart = (): Option.Option<LanguageServerProcess> => {
    if (Date.now() - state.startedAt >= stableFor) state.restarts = 0
    if (state.restarts >= maxRestarts) return Option.none()
    state.restarts += 1
    return Option.some(start())
  }

  const live = (): Option.Option<LanguageServerProcess> =>
    Option.filter(state.server, (server) => !state.disposed && server.alive())

  const running = (): Option.Option<LanguageServerProcess> =>
    state.disposed
      ? Option.none()
      : Option.match(state.server, {
          onNone: () => Option.some(start()),
          onSome: () => Option.orElse(live(), restart),
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
    state.open = openSet(state.open, state.composition, [], true)
    pushOpen()
    void Array.reduce(
      Array.filter(Array.fromIterable(state.composition.keys()), (path) => !isLoose(path)),
      Promise.resolve(true),
      (previous, path) => previous.then((going) => (going ? warmOne(path) : false)),
    )
  }

  const ask = <A>(method: string, params: unknown): Promise<A> =>
    Option.match(running(), {
      onNone: () =>
        Promise.reject(
          state.disposed
            ? new NativeProgramDisposed({ workspace })
            : new NativeServerStopped({ compiler, workspace }),
        ),
      onSome: (server) => {
        const answer = server.request<A>(method, params)
        void answer.then(warm, warm)
        return answer
      },
    })

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
      state.open = openSet(state.open, state.composition, listed, state.warmed)
      pushOpen()
    },
    hover: (fileName, position) =>
      ask<Hover | null>('textDocument/hover', at(fileName, position)).then(
        (hover) => hover ?? undefined,
      ),
    definition: (fileName, position) =>
      ask<ReadonlyArray<Location | LocationLink> | Location | null>(
        'textDocument/definition',
        at(fileName, position),
      ).then(asLinks),
    diagnostics: (fileName) =>
      ask<{ readonly items?: Diagnostic[] }>('textDocument/diagnostic', {
        textDocument: document(fileName),
      }).then((report) => report.items ?? []),
    completions: (fileName, position) =>
      ask<CompletionList | CompletionItem[] | null>(
        'textDocument/completion',
        at(fileName, position),
      ).then(asCompletionList),
    references: (fileName, position) =>
      ask<Location[] | null>('textDocument/references', {
        ...at(fileName, position),
        context: { includeDeclaration: true },
      }).then((found) => found ?? undefined),
    rename: (fileName, position, newName) =>
      ask<WorkspaceEdit | null>('textDocument/rename', { ...at(fileName, position), newName }).then(
        (edit) => edit ?? undefined,
      ),
    codeActions: (fileName, range, context) =>
      ask<ReadonlyArray<CodeAction | Command> | null>('textDocument/codeAction', {
        textDocument: document(fileName),
        range,
        context,
      }).then((found) =>
        Array.filter(found ?? [], (each): each is CodeAction => typeof each.command !== 'string'),
      ),
    resolveCodeAction: (action) =>
      action.edit === undefined
        ? ask<CodeAction>('codeAction/resolve', action)
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
