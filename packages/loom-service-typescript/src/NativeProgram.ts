import { Array, Option, pipe } from 'effect'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
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
import { type LanguageServerProcess, startLanguageServer } from './LanguageServerProcess'
import type { ProductFile, ProductProgram } from './ProductProgram'
import type { ProductProject } from './TypescriptService'

const majorVersionOf = (packageJson: string): number =>
  Number(String(JSON.parse(readFileSync(packageJson, 'utf8')).version ?? '0').split('.')[0])

const nativeExecutable = (typescriptPackageJson: string): Option.Option<string> =>
  pipe(
    Option.liftThrowable(() =>
      createRequire(typescriptPackageJson).resolve(
        `@typescript/typescript-${process.platform}-${process.arch}/package.json`,
      ),
    )(),
    Option.map((companion) =>
      join(dirname(companion), 'lib', process.platform === 'win32' ? 'tsc.exe' : 'tsc'),
    ),
    Option.filter(existsSync),
  )

const typescriptPackageFrom = (folder: string): Option.Option<string> =>
  Option.liftThrowable(() =>
    createRequire(join(folder, 'package.json')).resolve('typescript/package.json'),
  )()

export const nativeCompilerFor = (
  project: ProductProject,
  setting: Option.Option<string>,
): Option.Option<string> =>
  pipe(
    Option.map(setting, (folder) => join(folder, 'package.json')),
    Option.orElse(() =>
      typescriptPackageFrom(
        Option.match(project.config, { onNone: () => dirname(project.key), onSome: dirname }),
      ),
    ),
    Option.filter((packageJson) => majorVersionOf(packageJson) >= 7),
    Option.flatMap(nativeExecutable),
  )

const maxRestarts = 3

export const createNativeProgram = (compiler: string, workspace: string): ProductProgram => {
  const held: {
    open: ReadonlyMap<string, ProductFile>
    latest: ReadonlyMap<string, ProductFile>
    warmed: boolean
  } = { open: new Map(), latest: new Map(), warmed: false }
  const started: { server: Option.Option<LanguageServerProcess>; restarts: number } = {
    server: Option.none(),
    restarts: 0,
  }

  const start = (): LanguageServerProcess => {
    const server = startLanguageServer(compiler, ['--lsp', '--stdio'], workspace, 'typescript', {
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
    started.server = Option.some(server)
    server.keepOpen(Array.fromIterable(held.open.values()))
    return server
  }

  const restart = (): Option.Option<LanguageServerProcess> => {
    if (started.restarts >= maxRestarts) return Option.none()
    started.restarts += 1
    return Option.some(start())
  }

  const running = (): Option.Option<LanguageServerProcess> =>
    Option.match(started.server, {
      onNone: () => Option.some(start()),
      onSome: (server) =>
        Option.orElse(Option.liftPredicate(server, (live) => live.alive()), restart),
    })

  const openAll = (): void => {
    held.open = held.latest
    Option.map(started.server, (server) => server.keepOpen(Array.fromIterable(held.open.values())))
  }

  const warmOne = (path: string): Promise<void> =>
    Option.match(running(), {
      onNone: () => Promise.resolve(),
      onSome: (server) =>
        server
          .request('textDocument/diagnostic', { textDocument: { uri: URI.file(path).toString() } })
          .then(
            () => undefined,
            () => undefined,
          ),
    })

  const warm = (): void => {
    if (held.warmed) return
    held.warmed = true
    openAll()
    void Array.reduce(Array.fromIterable(held.latest.keys()), Promise.resolve(), (previous, path) =>
      previous.then(() => warmOne(path)),
    )
  }

  const ask = <A>(method: string, params: unknown): Promise<A> =>
    Option.match(running(), {
      onNone: () =>
        Promise.reject(
          new Error(
            `TypeScript 7 (${compiler}) stopped ${maxRestarts + 1} times in ${workspace}; ` +
              'its features are off until the Loom language server restarts',
          ),
        ),
      onSome: (server) => {
        const answer = server.request<A>(method, params)
        void answer.then(warm, warm)
        return answer
      },
    })

  const document = (fileName: string) => ({ uri: URI.file(fileName).toString() })
  const at = (fileName: string, position: Position) => ({ textDocument: document(fileName), position })

  const asLinks = (found: ReadonlyArray<Location | LocationLink> | Location | null): LocationLink[] =>
    Array.map(found === null ? [] : globalThis.Array.isArray(found) ? found : [found], (each) =>
      'targetUri' in each
        ? each
        : { targetUri: each.uri, targetRange: each.range, targetSelectionRange: each.range },
    )

  const asCompletionList = (found: CompletionList | CompletionItem[] | null): CompletionList =>
    found === null
      ? { isIncomplete: false, items: [] }
      : globalThis.Array.isArray(found)
        ? { isIncomplete: false, items: found }
        : found

  return {
    sync: (listed, others = []) => {
      const latest = new Map(Array.map([...listed, ...others], (file) => [file.path, file] as const))
      held.latest = latest
      if (held.warmed) return openAll()
      held.open = new Map([
        ...Array.getSomes(
          Array.map(Array.fromIterable(held.open.keys()), (path) =>
            Option.map(Option.fromNullishOr(latest.get(path)), (file) => [path, file] as const),
          ),
        ),
        ...Array.map(listed, (file) => [file.path, file] as const),
      ])
      Option.map(started.server, (server) => server.keepOpen(Array.fromIterable(held.open.values())))
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
      Option.map(started.server, (server) => server.dispose())
    },
  }
}
