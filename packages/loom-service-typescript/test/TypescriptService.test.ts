import * as ts from 'typescript'
import { describe, expect, it } from 'bun:test'
import { Option } from 'effect'
import { URI } from 'vscode-uri'
import type { ComposedFile } from '@athrio/loom-lang-services/LanguageService'
import { createProductProgram } from '../src/ProductProgram'
import type { LanguageServiceContext } from '@volar/language-service'
import { productPlugin, productTarget } from '../src/TypescriptService'

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
    const configOf = configNear(ts)
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
    const configOf = configNear(ts)
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

describe('productPlugin resolves a refactor only when it is picked', () => {
  const actPath = '/project/act.ts'
  const actLoom = '/project/act.loom'
  const actCode = 'export const total = 1 + 2\n'

  const standInContext = {
    decodeEmbeddedDocumentUri: (uri: URI): readonly [URI, string] | undefined =>
      uri.scheme === 'loom-embedded' ? [URI.file(uri.path), uri.fragment] : undefined,
    encodeEmbeddedDocumentUri: (uri: URI, id: string): URI =>
      URI.from({ scheme: 'loom-embedded', path: uri.path, fragment: id }),
  } as unknown as LanguageServiceContext

  const plugin = () =>
    productPlugin(ts, {
      rootsFor: () => [
        { path: actPath, content: actCode, loomPath: actLoom, rootId: 'main', heading: headOf(actLoom) },
      ],
    }).create(standInContext)

  const embedded = standInContext.encodeEmbeddedDocumentUri(URI.file(actLoom), 'main').toString()

  const documentOf = () =>
    ({ uri: embedded, languageId: 'typescript', version: 1, getText: () => actCode }) as unknown as Parameters<
      NonNullable<ReturnType<ReturnType<typeof productPlugin>['create']>['provideCodeActions']>
    >[0]

  const sum = { start: { line: 0, character: 21 }, end: { line: 0, character: 26 } }

  const refactorsAt = async (instance: ReturnType<typeof plugin>) =>
    ((await instance.provideCodeActions!(documentOf(), sum, { diagnostics: [] }, never)) ?? []).filter(
      (action) => action.kind?.startsWith('refactor'),
    )

  const never = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) }

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
