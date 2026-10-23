import * as ts from 'typescript'
import { describe, expect, it } from 'bun:test'
import { Option } from 'effect'
import { URI } from 'vscode-uri'
import type { ComposedFile } from '@athrio/loom-lang-services/LanguageService'
import { createProductProgram } from '../src/ProductProgram'
import type { LanguageServiceContext } from '@volar/language-service'
import { knownEdit, productPlugin, productTarget } from '../src/TypescriptService'

const options: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: true,
  skipLibCheck: true,
  noEmit: true,
}

const noConfig = (): Option.Option<string> => Option.none()

const loomPath = '/project/doc.loom'
const decoded = (id: string): readonly [URI, string] => [URI.file(loomPath), id]

const headOf = (path: string): ComposedFile['heading'] => ({
  path,
  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
})

describe('productTarget routes a Product to its program', () => {
  it('serves a TypeScript Product at its tangle path, the live buffer overriding disk', async () => {
    const program = createProductProgram(ts, options)
    const roots: ReadonlyArray<ComposedFile> = [
      {
        path: '/project/doc.ts',
        content: 'export const x = 1\n',
        loomPath,
        rootId: 'main',
        heading: headOf(loomPath),
      },
    ]
    const target = productTarget(
      decoded('main'),
      'typescript',
      'export const x: string = 123\n',
      () => program,
      () => roots,
      noConfig,
      'project',
    )
    expect(target?.fileName).toBe('/project/doc.ts')
    const diagnostics = await target!.program.diagnostics(target!.fileName)
    program.dispose()
    expect(diagnostics.some((d) => /not assignable/.test(d.message))).toBe(true)
  })

  it('resolves an import across roots against their composition', async () => {
    const program = createProductProgram(ts, options)
    const roots: ReadonlyArray<ComposedFile> = [
      {
        path: '/project/a.ts',
        content: '',
        loomPath: '/project/a.loom',
        rootId: 'a',
        heading: headOf('/project/a.loom'),
      },
      {
        path: '/project/b.ts',
        content: 'export const b = 2\n',
        loomPath: '/project/b.loom',
        rootId: 'b',
        heading: headOf('/project/b.loom'),
      },
    ]
    const target = productTarget(
      [URI.file('/project/a.loom'), 'a'],
      'typescript',
      "import { b } from './b.js'\nexport const a: number = b + 1\n",
      () => program,
      () => roots,
      noConfig,
      'project',
    )
    expect(target?.fileName).toBe('/project/a.ts')
    const diagnostics = await target!.program.diagnostics(target!.fileName)
    program.dispose()
    expect(diagnostics.some((d) => /Cannot find module/.test(d.message))).toBe(false)
    expect(diagnostics.some((d) => d.severity === 1)).toBe(false)
  })

  it('names a tsx Product by its tangle path', () => {
    const program = createProductProgram(ts, options)
    const roots: ReadonlyArray<ComposedFile> = [
      {
        path: '/project/view.tsx',
        content: 'export const v = 1\n',
        loomPath,
        rootId: 'view',
        heading: headOf(loomPath),
      },
    ]
    const target = productTarget(
      decoded('view'),
      'tsx',
      'export const v = 1\n',
      () => program,
      () => roots,
      noConfig,
      'project',
    )
    program.dispose()
    expect(target?.fileName).toBe('/project/view.tsx')
  })

  it('declines a non-TypeScript document', () => {
    const program = createProductProgram(ts, options)
    const target = productTarget(
      decoded('config'),
      'json',
      '{ "a": 1 }\n',
      () => program,
      () => [],
      noConfig,
      'project',
    )
    program.dispose()
    expect(target).toBeUndefined()
  })

  it('declines a uri that is not an embedded document', () => {
    const program = createProductProgram(ts, options)
    const target = productTarget(
      undefined,
      'typescript',
      '',
      () => program,
      () => [],
      noConfig,
      'project',
    )
    program.dispose()
    expect(target).toBeUndefined()
  })

  it('checks a root that tangles nowhere beside its .loom under a synthetic name', async () => {
    const program = createProductProgram(ts, options)
    const roots: ReadonlyArray<ComposedFile> = [
      {
        path: '/project/doc.ts',
        content: 'export const x = 1\n',
        loomPath,
        rootId: 'main',
        heading: headOf(loomPath),
      },
    ]
    const target = productTarget(
      decoded('fresh'),
      'typescript',
      'export const f: string = 1\n',
      () => program,
      () => roots,
      noConfig,
      'project',
    )
    expect(target?.fileName).toBe('/project/doc.loom.fresh.ts')
    const diagnostics = await target!.program.diagnostics(target!.fileName)
    program.dispose()
    expect(diagnostics.some((d) => /not assignable/.test(d.message))).toBe(true)
  })
})

import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProductProgram } from '../src/ProductProgram'
import { configNear, consumerOptions, type ProductProject } from '../src/TypescriptService'

const projectFolder = (): string => {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'loom-projects-')))
  const pkg = (name: string, strict: boolean) => {
    mkdirSync(join(folder, name, 'src'), { recursive: true })
    writeFileSync(
      join(folder, name, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { strict, target: 'ES2022', module: 'Preserve' } }),
    )
  }
  pkg('loose', false)
  pkg('other', true)
  mkdirSync(join(folder, 'corpus'), { recursive: true })
  return folder
}

const programsFor = () => {
  const programs = new Map<string, ProductProgram>()
  const programFor = (project: ProductProject): ProductProgram =>
    Option.getOrElse(Option.fromNullishOr(programs.get(project.key)), () => {
      const program = createProductProgram(ts, consumerOptions(ts, project.config))
      programs.set(project.key, program)
      return program
    })
  return { programFor, dispose: () => programs.forEach((program) => program.dispose()) }
}

const rootAt = (path: string, loom: string, content: string): ComposedFile => ({
  path,
  content,
  loomPath: loom,
  rootId: 'main',
  heading: headOf(loom),
})

describe('productTarget finds a root\'s project', () => {
  it('checks a root under the tsconfig.json nearest the file it tangles to', async () => {
    const folder = projectFolder()
    const loom = join(folder, 'corpus', 'value.loom')
    const source = 'export const value: string = null\n'
    const { programFor, dispose } = programsFor()
    const configOf = configNear()
    const errorsAt = async (path: string) => {
      const target = productTarget(
        [URI.file(loom), 'main'],
        'typescript',
        source,
        programFor,
        () => [rootAt(path, loom, source)],
        configOf,
        'project',
      )
      return target === undefined ? [] : await target.program.diagnostics(target.fileName)
    }
    const nullError = (d: { readonly message: string }): boolean =>
      /not assignable to type 'string'/.test(d.message)
    const inLoose = await errorsAt(join(folder, 'loose', 'src', 'value.ts'))
    const nowhere = await errorsAt(join(folder, 'corpus', 'value.ts'))
    dispose()
    expect(inLoose.some(nullError)).toBe(false)
    expect(nowhere.some(nullError)).toBe(true)
  })

  it('gives the looms one project governs one program', () => {
    const folder = projectFolder()
    const loomOf = (name: string): string => join(folder, 'corpus', `${name}.loom`)
    const roots = [
      rootAt(join(folder, 'loose', 'src', 'first.ts'), loomOf('first'), 'export const one = 1\n'),
      rootAt(join(folder, 'loose', 'src', 'second.ts'), loomOf('second'), 'export const two = 2\n'),
      rootAt(join(folder, 'other', 'src', 'third.ts'), loomOf('third'), 'export const three = 3\n'),
    ]
    const { programFor, dispose } = programsFor()
    const configOf = configNear()
    const programOf = (name: string, reach: 'project' | 'corpus') =>
      productTarget(
        [URI.file(loomOf(name)), 'main'],
        'typescript',
        '',
        programFor,
        () => roots,
        configOf,
        reach,
      )?.program
    const first = programOf('first', 'project')
    const second = programOf('second', 'project')
    const third = programOf('third', 'project')
    const references = programOf('first', 'corpus')
    dispose()
    expect(second).toBe(first)
    expect(third).not.toBe(first)
    expect(references).not.toBe(first)
  })

  it('gives each loom no tsconfig.json governs a program of its own, so its scripts never meet', async () => {
    const { programFor, dispose } = programsFor()
    const script = (name: string) => `const greeting = '${name}'\nconsole.log(greeting)\n`
    const roots = [
      rootAt('/book/src/a.ts', '/book/corpus/a.loom', script('a')),
      rootAt('/book/src/b.ts', '/book/corpus/b.loom', script('b')),
    ]
    const targetOf = (name: string) =>
      productTarget(
        [URI.file(`/book/corpus/${name}.loom`), 'main'],
        'typescript',
        script(name),
        programFor,
        () => roots,
        noConfig,
        'project',
      )!
    const a = targetOf('a')
    const b = targetOf('b')
    const errors = await a.program.diagnostics(a.fileName)
    dispose()
    expect(b.program).not.toBe(a.program)
    expect(errors.some((d) => /Cannot redeclare/.test(d.message))).toBe(false)
  })
})

describe('knownEdit keeps only the places the editor can reach', () => {
  it('drops an edit of a file that is neither a root nor on disk, and keeps a file the edit creates', () => {
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'loom-known-')))
    const onDisk = join(folder, 'disk.ts')
    writeFileSync(onDisk, '')
    const root = join(folder, 'root.ts')
    const held = join(folder, 'chapter.loom.renamed.ts')
    const created = join(folder, 'moved.ts')
    const uri = (path: string) => URI.file(path).toString()
    const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }
    const change = (path: string) => ({
      textDocument: { uri: uri(path), version: null },
      edits: [{ range, newText: 'x' }],
    })
    const kept = knownEdit([rootAt(root, join(folder, 'a.loom'), '')], {
      changes: { [uri(held)]: [], [uri(root)]: [] },
      documentChanges: [
        { kind: 'create', uri: uri(created) },
        change(created),
        change(held),
        change(onDisk),
      ],
    })
    expect(Object.keys(kept.changes ?? {})).toEqual([uri(root)])
    expect(
      (kept.documentChanges ?? []).map((each) =>
        'textDocument' in each ? URI.parse(each.textDocument.uri).fsPath : each.kind,
      ),
    ).toEqual(['create', created, onDisk])
  })
})

import { Result } from 'effect'
import type { CompletionContext } from '@volar/language-service'
import {
  ClassicTypeScriptMissing,
  type TypescriptSdkApi,
} from '@athrio/loom-lang-services/LanguageService'

const actIn = (folder: string, code: string) => ({
  path: join(folder, 'act.ts'),
  loom: join(folder, 'act.loom'),
  code,
})

type Act = ReturnType<typeof actIn>

const act = actIn(
  import.meta.dir,
  'export const total = 1 + 2\n\nexport function twice(n: number): number {\n  return n * 2\n}\n',
)

const standInContext = {
  decodeEmbeddedDocumentUri: (uri: URI): readonly [URI, string] | undefined =>
    uri.scheme === 'loom-embedded' ? [URI.file(uri.path), uri.fragment] : undefined,
  encodeEmbeddedDocumentUri: (uri: URI, id: string): URI =>
    URI.from({ scheme: 'loom-embedded', path: uri.path, fragment: id }),
} as unknown as LanguageServiceContext

const lending = (
  classic: Result.Result<typeof ts, ClassicTypeScriptMissing>,
  fetch: () => Promise<void> = () => Promise.reject(new Error('the tests fetch nothing')),
): TypescriptSdkApi => ({
  classic: () => classic,
  fetched: { version: '7.0.0-test', executable: '/nowhere/tsc', fetch },
})

const pluginWith = (sdk: TypescriptSdkApi, root: Act = act) =>
  productPlugin(sdk, {
    rootsFor: () => [
      { path: root.path, content: root.code, loomPath: root.loom, rootId: 'main', heading: headOf(root.loom) },
    ],
  }).create(standInContext)

const embeddedOf = (root: Act): string =>
  standInContext.encodeEmbeddedDocumentUri(URI.file(root.loom), 'main').toString()

const embedded = embeddedOf(act)

const documentOf = (root: Act = act) =>
  ({ uri: embeddedOf(root), languageId: 'typescript', version: 1, getText: () => root.code }) as unknown as Parameters<
    NonNullable<ReturnType<ReturnType<typeof productPlugin>['create']>['provideCodeActions']>
  >[0]

const never = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) }

describe('productPlugin resolves a refactor only when it is picked', () => {
  const plugin = () => pluginWith(lending(Result.succeed(ts)))

  const sum = { start: { line: 0, character: 21 }, end: { line: 0, character: 26 } }

  const refactorsAt = async (instance: ReturnType<typeof plugin>) =>
    ((await instance.provideCodeActions!(documentOf(), sum, { diagnostics: [] }, never)) ?? []).filter(
      (action) => action.kind?.startsWith('refactor'),
    )

  it('lists a refactor without its edit', async () => {
    const refactors = await refactorsAt(plugin())
    expect(refactors.length).toBeGreaterThan(0)
    expect(refactors.every((action) => action.edit === undefined)).toBe(true)
  })

  it('makes the edit when the refactor is resolved, named by the embedded document', async () => {
    const instance = plugin()
    const extract = (await refactorsAt(instance)).find(
      (action) => action.kind === 'refactor.extract.constant',
    )
    const resolved = await instance.resolveCodeAction!(extract!, never)
    const edit = resolved.edit
    expect(edit).toBeDefined()
    const named = [
      ...Object.keys(edit?.changes ?? {}),
      ...(edit?.documentChanges ?? []).flatMap((change) =>
        'textDocument' in change ? [change.textDocument.uri] : [],
      ),
    ]
    expect(named.length).toBeGreaterThan(0)
    expect(named.every((uri) => uri === embedded)).toBe(true)
  })
})

describe('productPlugin answers about the code\'s shape', () => {
  it('outlines a root, folds its function and grows a selection', async () => {
    const instance = pluginWith(lending(Result.succeed(ts)))
    const symbols = (await instance.provideDocumentSymbols!(documentOf(), never)) ?? []
    const folds = (await instance.provideFoldingRanges!(documentOf(), never)) ?? []
    const selections =
      (await instance.provideSelectionRanges!(documentOf(), [{ line: 0, character: 14 }], never)) ?? []
    expect(symbols.map((symbol) => symbol.name)).toEqual(['total', 'twice'])
    expect(folds.some((fold) => fold.startLine === 2)).toBe(true)
    expect(selections).toHaveLength(1)
  })
})

describe('productPlugin reports a project that cannot have TypeScript 6', () => {
  it('fails each check with the reason, rather than fall back to another compiler', async () => {
    const missing = new ClassicTypeScriptMissing({ folder: '/nowhere', tsdk: Option.none() })
    const instance = pluginWith(lending(Result.fail(missing)))
    const diagnostics = (await instance.provideDiagnostics!(documentOf(), never)) ?? []
    expect(diagnostics.map((diagnostic) => diagnostic.message)).toEqual([
      `TypeScript 6 is unavailable: ${missing.message}`,
    ])
  })
})

describe('productPlugin puts a project with no TypeScript on the fetched TypeScript 7', () => {
  it('waits for the fetch, and reports a fetch that failed', async () => {
    const bare = actIn(realpathSync(mkdtempSync(join(tmpdir(), 'loom-bare-'))), 'export const one = 1\n')
    const fetches: Array<string> = []
    const fetch = () => {
      fetches.push('fetch')
      return Promise.reject(new Error('could not fetch TypeScript 7.0.0-test'))
    }
    const instance = pluginWith(lending(Result.succeed(ts), fetch), bare)
    const diagnostics = (await instance.provideDiagnostics!(documentOf(bare), never)) ?? []
    expect(fetches.length).toBeGreaterThan(0)
    expect(diagnostics.map((diagnostic) => diagnostic.message)).toEqual([
      'could not fetch TypeScript 7.0.0-test',
    ])
  })
})

describe('productPlugin completes as the person types', () => {
  const commented = actIn(
    join(import.meta.dir, 'typed'),
    '/** */\nexport function half(n: number): number {\n  return n / 2\n}\n// @\nexport const product = 2 * 3\n',
  )

  const typed = (character: string): CompletionContext => ({ triggerKind: 2, triggerCharacter: character })

  const labelsAt = async (line: number, character: number, typedCharacter: string) =>
    (
      (await pluginWith(lending(Result.succeed(ts)), commented).provideCompletionItems!(
        documentOf(commented),
        { line, character },
        typed(typedCharacter),
        never,
      ))?.items ?? []
    ).map((item) => item.label)

  it('offers a doc comment\'s template, the directives, and nothing for a product', async () => {
    expect(await labelsAt(0, 3, '*')).toContain('/** */')
    expect(await labelsAt(4, 4, '@')).toContain('@ts-expect-error')
    expect(await labelsAt(5, 26, '*')).toEqual([])
  })
})
