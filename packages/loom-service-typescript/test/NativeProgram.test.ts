import { describe, expect, it } from 'bun:test'
import { Option } from 'effect'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import {
  asOpened,
  compilerChoiceFor,
  createNativeProgram,
  createUnavailableProgram,
  inferredProject,
} from '../src/NativeProgram'
import { configNear, nativeProjectsOf } from '../src/TypescriptService'
import { settled, standInServer, startedIn } from './StandInServer'

const fetched = {
  version: '7.0.0-test',
  executable: '/nowhere/tsc',
  fetch: () => Promise.reject(new Error('the tests fetch nothing')),
}

const executableName = process.platform === 'win32' ? 'tsc.exe' : 'tsc'
const companion = `typescript-${process.platform}-${process.arch}`

const install = (
  folder: string,
  version: string,
  companionPackage: 'executable' | 'plain' | 'none' = 'executable',
  name = 'typescript',
): string => {
  const typescript = join(folder, 'node_modules', name)
  mkdirSync(typescript, { recursive: true })
  writeFileSync(join(typescript, 'package.json'), JSON.stringify({ name, version }))
  if (version.startsWith('7') && companionPackage !== 'none') {
    const lib = join(folder, 'node_modules', '@typescript', companion, 'lib')
    mkdirSync(lib, { recursive: true })
    writeFileSync(join(lib, '..', 'package.json'), JSON.stringify({ name: `@typescript/${companion}`, version }))
    writeFileSync(join(lib, executableName), '')
    chmodSync(join(lib, executableName), companionPackage === 'executable' ? 0o755 : 0o644)
  }
  return typescript
}

const folder = (): string => realpathSync(mkdtempSync(join(tmpdir(), 'loom-native-')))

const executableIn = (root: string): string =>
  join(root, 'node_modules', '@typescript', companion, 'lib', executableName)

const projectAt = (root: string) => {
  writeFileSync(join(root, 'tsconfig.json'), '{}')
  return {
    key: join(root, 'tsconfig.json'),
    config: Option.some(join(root, 'tsconfig.json')),
    loom: join(root, 'corpus', 'chapter.loom'),
  }
}

const looseAt = (root: string) => ({
  key: join(root, 'chapter.loom'),
  config: Option.none<string>(),
  loom: join(root, 'chapter.loom'),
})

describe('compilerChoiceFor chooses TypeScript 7 for a project that installs it', () => {
  it('chooses the native executable of a project on TypeScript 7', () => {
    const root = folder()
    install(root, '7.0.2')
    expect(compilerChoiceFor(projectAt(root), Option.none(), fetched)).toEqual(
      expect.objectContaining({ _tag: 'Native', executable: executableIn(root) }),
    )
  })

  it('leaves a project on TypeScript 6 to the TypeScript 6 program', () => {
    const root = folder()
    install(root, '6.0.3')
    expect(compilerChoiceFor(projectAt(root), Option.none(), fetched)._tag).toBe('Classic')
  })

  it('gives a project with no TypeScript the TypeScript 7 Loom fetches', () => {
    const root = folder()
    expect(compilerChoiceFor(projectAt(root), Option.none(), fetched)).toEqual(
      expect.objectContaining({ _tag: 'Fetched', version: fetched.version, executable: fetched.executable }),
    )
  })

  it('reports a TypeScript 7 without this platform\'s executable as unavailable', () => {
    const root = folder()
    install(root, '7.0.2', 'none')
    const choice = compilerChoiceFor(projectAt(root), Option.none(), fetched)
    expect(choice._tag).toBe('Unavailable')
    expect(choice._tag === 'Unavailable' && choice.reason).toContain(`@typescript/${companion}`)
  })

  it('reports an executable that may not be run as unavailable', () => {
    const root = folder()
    install(root, '7.0.2', 'plain')
    expect(compilerChoiceFor(projectAt(root), Option.none(), fetched)._tag).toBe('Unavailable')
  })

  it('chooses from the loom\'s own folder when no tsconfig.json governs it', () => {
    const root = folder()
    install(root, '7.0.2')
    expect(compilerChoiceFor(looseAt(root), Option.none(), fetched)._tag).toBe('Native')
  })

  it('chooses the same for the corpus search, whose key is its own', () => {
    const root = folder()
    install(root, '7.0.2')
    const corpus = { ...looseAt(root), key: `corpus of ${join(root, 'chapter.loom')}` }
    expect(compilerChoiceFor(corpus, Option.none(), fetched)._tag).toBe('Native')
  })
})

describe('compilerChoiceFor follows the nativeCompiler setting', () => {
  it('uses the TypeScript 7 the setting names, over the project\'s own', () => {
    const root = folder()
    install(root, '6.0.3')
    const elsewhere = folder()
    const named = install(elsewhere, '7.0.2')
    expect(compilerChoiceFor(projectAt(root), Option.some(named), fetched)).toEqual(
      expect.objectContaining({ _tag: 'Native', executable: executableIn(elsewhere) }),
    )
  })

  it('reads a relative setting from the workspace', () => {
    const root = folder()
    mkdirSync(join(root, '.loom'), { recursive: true })
    writeFileSync(join(root, '.loom', 'config.yaml'), 'languages: {}\n')
    install(join(root, 'tools'), '7.0.2')
    const project = { ...projectAt(root), loom: join(root, 'corpus', 'part', 'chapter.loom') }
    expect(
      compilerChoiceFor(project, Option.some('tools/node_modules/typescript'), fetched)._tag,
    ).toBe('Native')
  })

  it('reports a setting that names no typescript package as unavailable', () => {
    const root = folder()
    const choice = compilerChoiceFor(projectAt(root), Option.some(join(root, 'nothing-here')), fetched)
    expect(choice._tag).toBe('Unavailable')
  })

  it('reports a setting that names TypeScript 6 as unavailable', () => {
    const root = folder()
    const named = install(folder(), '6.0.3')
    const choice = compilerChoiceFor(projectAt(root), Option.some(named), fetched)
    expect(choice._tag).toBe('Unavailable')
    expect(choice._tag === 'Unavailable' && choice.reason).toContain('TypeScript 6')
  })

  it('reports a setting that names another package as unavailable', () => {
    const root = folder()
    const named = install(folder(), '7.0.2', 'executable', 'not-typescript')
    expect(compilerChoiceFor(projectAt(root), Option.some(named), fetched)._tag).toBe('Unavailable')
  })

  it('reports a setting that is not a path as unavailable', () => {
    const root = folder()
    expect(compilerChoiceFor(projectAt(root), Option.some(true), fetched)._tag).toBe('Unavailable')
    expect(compilerChoiceFor(projectAt(root), Option.some(''), fetched)._tag).toBe('Unavailable')
  })

  it('follows a linked folder to the store it points into', () => {
    const root = folder()
    const store = folder()
    const real = install(store, '7.0.2')
    mkdirSync(join(root, 'node_modules'), { recursive: true })
    symlinkSync(real, join(root, 'node_modules', 'typescript-native'))
    const named = join(root, 'node_modules', 'typescript-native')
    expect(compilerChoiceFor(projectAt(root), Option.some(named), fetched)).toEqual(
      expect.objectContaining({ _tag: 'Native', executable: executableIn(store) }),
    )
  })
})

describe('nativeProjectsOf names the project TypeScript 7 places a root in', () => {
  it('puts looms with no tsconfig.json in the inferred project, and leaves other files and TypeScript 6 out', () => {
    const root = folder()
    install(root, '7.0.2')
    const legacy = join(root, 'legacy')
    mkdirSync(legacy, { recursive: true })
    install(legacy, '6.0.3')
    writeFileSync(join(legacy, 'tsconfig.json'), '{}')
    const app = join(root, 'app')
    mkdirSync(app, { recursive: true })
    writeFileSync(join(app, 'tsconfig.json'), '{}')
    const projectOf = nativeProjectsOf(configNear(), Option.none(), fetched)(executableIn(root))
    const projectOfRoot = (path: string, loom: string) =>
      Option.getOrUndefined(projectOf({ path: join(root, path), text: '', loom: join(root, loom) }))
    expect(projectOfRoot('src/a.ts', 'corpus/a.loom')).toBe(inferredProject)
    expect(projectOfRoot('src/b.ts', 'corpus/b.loom')).toBe(inferredProject)
    expect(projectOfRoot('app/src/c.ts', 'corpus/c.loom')).toBe(join(app, 'tsconfig.json'))
    expect(projectOfRoot('package.json', 'corpus/a.loom')).toBeUndefined()
    expect(projectOfRoot('legacy/src/d.ts', 'corpus/d.loom')).toBeUndefined()
  })
})

const position = { line: 0, character: 0 }

const diagnosticsOf = async (
  program: ReturnType<typeof createUnavailableProgram>,
  path: string,
): Promise<string> => (await program.diagnostics(path)).map((d) => d.message).join(' | ')

const diagnosticPaths = (lines: ReadonlyArray<string>): ReadonlyArray<string> =>
  lines.filter((line) => line.startsWith('textDocument/diagnostic')).sort()

describe('createNativeProgram warms the workspace', () => {
  it('asks for every served root\'s diagnostics after the first answer, keeping the edited loose root', async () => {
    const stand = standInServer()
    const loose = join(stand.folder, 'chapter.loom.aside.ts')
    const program = createNativeProgram(stand.command, stand.folder, (file) =>
      file.path.endsWith('old.ts') ? Option.none() : Option.some(inferredProject),
    )
    program.sync(
      [{ path: loose, text: 'aside', loose: true }],
      [
        { path: join(stand.folder, 'b.ts'), text: 'b' },
        { path: join(stand.folder, 'old.ts'), text: 'old' },
      ],
    )
    await program.hover(loose, position)
    await settled(600)
    const lines = stand.lines()
    expect(diagnosticPaths(lines)).toEqual(['textDocument/diagnostic b.ts'])
    expect(lines).not.toContain('textDocument/didClose chapter.loom.aside.ts')
    expect(lines).not.toContain('textDocument/didOpen old.ts v1')
    program.dispose()
  })

  it('closes one loom\'s loose roots when another loom is asked about', async () => {
    const stand = standInServer()
    const program = createNativeProgram(stand.command, stand.folder)
    const first = join(stand.folder, 'first.loom.aside.ts')
    const second = join(stand.folder, 'second.loom.aside.ts')
    program.sync([{ path: first, text: 'one', loose: true }])
    await program.hover(first, position)
    program.sync([{ path: second, text: 'two', loose: true }])
    await program.hover(second, position)
    await settled()
    const lines = stand.lines()
    expect(lines).toContain('textDocument/didClose first.loom.aside.ts')
    expect(lines.indexOf('textDocument/didClose first.loom.aside.ts')).toBeLessThan(
      lines.indexOf('textDocument/didOpen second.loom.aside.ts v1'),
    )
    program.dispose()
  })

  it('stops the warm-up when the server dies, and warms a restarted server again', async () => {
    const stand = standInServer()
    const program = createNativeProgram(stand.command, stand.folder)
    const a = join(stand.folder, 'a.ts')
    program.sync([{ path: a, text: 'a' }], [{ path: join(stand.folder, 'crash-late.ts'), text: 'x' }])
    await program.hover(a, position)
    await settled(600)
    expect(startedIn(stand.lines())).toHaveLength(1)
    program.sync([{ path: a, text: 'a' }])
    await program.hover(a, position)
    await settled(600)
    expect(startedIn(stand.lines())).toHaveLength(2)
    expect(diagnosticPaths(stand.lines())).toContain('textDocument/diagnostic a.ts')
    program.dispose()
  })

  it('starts no new server once disposed, even mid warm-up', async () => {
    const stand = standInServer()
    const program = createNativeProgram(stand.command, stand.folder)
    const roots = Array.from({ length: 20 }, (_, index) => ({
      path: join(stand.folder, `r${index}.ts`),
      text: `export const r${index} = ${index}`,
    }))
    program.sync(roots.slice(0, 1), roots.slice(1))
    await program.hover(roots[0]!.path, position)
    program.dispose()
    await settled(800)
    expect(startedIn(stand.lines())).toHaveLength(1)
    expect(await diagnosticsOf(program, roots[0]!.path)).toContain('was shut down')
  })
})

describe('createNativeProgram opens what TypeScript 7 checks together', () => {
  it('opens the roots that share the asked root\'s native project before the first answer', async () => {
    const stand = standInServer()
    const program = createNativeProgram(stand.command, stand.folder, (file) =>
      Option.some(file.path.endsWith('c.ts') ? join(stand.folder, 'app', 'tsconfig.json') : inferredProject),
    )
    const a = join(stand.folder, 'a.ts')
    program.sync(
      [{ path: a, text: 'a' }],
      [
        { path: join(stand.folder, 'b.ts'), text: 'b' },
        { path: join(stand.folder, 'c.ts'), text: 'c' },
      ],
    )
    await program.hover(a, position)
    await settled(600)
    const lines = stand.lines()
    const hover = lines.indexOf('textDocument/hover a.ts')
    expect(lines.indexOf('textDocument/didOpen b.ts v1')).toBeLessThan(hover)
    expect(lines.indexOf('textDocument/didOpen c.ts v1')).toBeGreaterThan(hover)
    program.dispose()
  })

  it('keeps open only the loose root being edited', async () => {
    const stand = standInServer()
    const program = createNativeProgram(stand.command, stand.folder)
    const loom = join(stand.folder, 'chapter.loom')
    const x = { path: `${loom}.x.ts`, text: 'x', loose: true, loom }
    const y = { path: `${loom}.y.ts`, text: 'y', loose: true, loom }
    program.sync([x])
    await program.hover(x.path, position)
    program.sync([y])
    await program.hover(y.path, position)
    await settled()
    const lines = stand.lines()
    expect(lines).toContain('textDocument/didClose chapter.loom.x.ts')
    expect(lines.indexOf('textDocument/didClose chapter.loom.x.ts')).toBeLessThan(
      lines.indexOf('textDocument/hover chapter.loom.y.ts'),
    )
    program.dispose()
  })

  it('opens the roots of a loose root\'s native project before the first answer', async () => {
    const stand = standInServer()
    const program = createNativeProgram(stand.command, stand.folder)
    const loom = join(stand.folder, 'chapter.loom')
    const aside = { path: `${loom}.aside.ts`, text: "import { b } from './b'", loose: true, loom }
    program.sync([aside], [{ path: join(stand.folder, 'b.ts'), text: 'export const b = 1' }])
    await program.hover(aside.path, position)
    const lines = stand.lines()
    expect(lines.indexOf('textDocument/didOpen b.ts v1')).toBeLessThan(
      lines.indexOf('textDocument/hover chapter.loom.aside.ts'),
    )
    program.dispose()
  })

  it('resolves an action about the root it was listed for, open again', async () => {
    const stand = standInServer()
    const program = createNativeProgram(stand.command, stand.folder)
    const loom = join(stand.folder, 'chapter.loom')
    const x = { path: `${loom}.x.ts`, text: 'x', loose: true, loom }
    const y = { path: `${loom}.y.ts`, text: 'y', loose: true, loom }
    program.sync([x])
    await program.codeActions(x.path, { start: position, end: position }, { diagnostics: [] })
    program.sync([y])
    await program.hover(y.path, position)
    program.sync([x])
    const action = { title: 'Extract to constant', kind: 'refactor.extract', data: { at: 'x' } }
    expect(await program.resolveCodeAction(action, x.path)).toEqual(action)
    const lines = stand.lines()
    expect(lines.lastIndexOf('textDocument/didOpen chapter.loom.x.ts v1')).toBeLessThan(
      lines.indexOf('codeAction/resolve'),
    )
    program.dispose()
  })

  it('keeps a root open until the question about it is answered', async () => {
    const stand = standInServer()
    const program = createNativeProgram(stand.command, stand.folder)
    const first = join(stand.folder, 'first.loom')
    const second = join(stand.folder, 'second.loom')
    const slow = { path: `${first}.slow.ts`, text: 'slow', loose: true, loom: first }
    const aside = { path: `${second}.aside.ts`, text: 'aside', loose: true, loom: second }
    program.sync([slow])
    const waiting = program.hover(slow.path, position)
    await settled(50)
    program.sync([aside])
    await program.hover(aside.path, position)
    expect(await waiting).toBeDefined()
    await settled()
    const lines = stand.lines()
    expect(lines).toContain('textDocument/didClose first.loom.slow.ts')
    expect(lines.indexOf('answered first.loom.slow.ts')).toBeLessThan(
      lines.indexOf('textDocument/didClose first.loom.slow.ts'),
    )
    program.dispose()
  })
})

describe('createNativeProgram holds the text the last question was about', () => {
  it('keeps the newer text of a held root once an older question is answered', async () => {
    const stand = standInServer()
    const program = createNativeProgram(stand.command, stand.folder)
    const first = join(stand.folder, 'first.loom')
    const second = join(stand.folder, 'second.loom')
    const slow = (text: string) => ({ path: `${first}.slow.ts`, text, loose: true, loom: first })
    const aside = { path: `${second}.aside.ts`, text: 'aside', loose: true, loom: second }
    program.sync([slow('one')])
    const older = program.hover(slow('one').path, position)
    await settled(50)
    program.sync([slow('two')])
    const newer = program.hover(slow('two').path, position)
    await older
    program.sync([aside])
    await program.hover(aside.path, position)
    await newer
    await settled()
    expect(stand.lines()).not.toContain('textDocument/didChange first.loom.slow.ts v3')
    program.dispose()
  })
})

describe('createNativeProgram makes the folders its roots need', () => {
  const workspaceIn = (folder: string): string => {
    mkdirSync(join(folder, '.loom'), { recursive: true })
    writeFileSync(join(folder, '.loom', 'config.yaml'), 'languages: {}\n')
    return join(folder, 'corpus', 'chapter.loom')
  }

  it('makes a served root\'s missing folder, and none for a loose root or outside the workspace', async () => {
    const stand = standInServer()
    const loom = workspaceIn(stand.folder)
    const program = createNativeProgram(stand.command, stand.folder)
    const tangled = join(stand.folder, 'never', 'tangled', 'a.ts')
    const loose = join(stand.folder, 'elsewhere', 'chapter.loom.aside.ts')
    const escape = join(stand.folder, '..', `${basename(stand.folder)}-escape`, 'e.ts')
    program.sync([
      { path: tangled, text: 'a', loom },
      { path: loose, text: 'aside', loose: true, loom },
      { path: escape, text: 'e', loom },
    ])
    await program.hover(tangled, position)
    expect(existsSync(join(stand.folder, 'never', 'tangled'))).toBe(true)
    expect(existsSync(join(stand.folder, 'elsewhere'))).toBe(false)
    expect(existsSync(join(stand.folder, '..', `${basename(stand.folder)}-escape`))).toBe(false)
    program.dispose()
  })

  it('keeps answering when a root\'s folder cannot be made', async () => {
    const stand = standInServer()
    const loom = workspaceIn(stand.folder)
    const locked = join(stand.folder, 'locked')
    mkdirSync(locked)
    chmodSync(locked, 0o555)
    const program = createNativeProgram(stand.command, stand.folder)
    const a = join(stand.folder, 'a.ts')
    const blocked = join(locked, 'deep', 'b.ts')
    const roots = [
      { path: a, text: 'a', loom },
      { path: blocked, text: 'b', loom },
    ]
    program.sync(roots)
    expect(await program.hover(a, position)).toBeDefined()
    await settled(600)
    expect(() => program.sync(roots)).not.toThrow()
    expect(stand.lines()).toContain('textDocument/didOpen b.ts v1')
    expect(diagnosticPaths(stand.lines())).toContain('textDocument/diagnostic a.ts')
    program.dispose()
    chmodSync(locked, 0o755)
  })
})

describe('createNativeProgram restarts a crashed server a few times', () => {
  it('gives up after three restarts of a server that crashes as it starts', async () => {
    const stand = standInServer()
    const program = createNativeProgram(stand.command, stand.folder)
    const crash = join(stand.folder, 'crash.ts')
    program.sync([{ path: crash, text: 'boom' }])
    const messages = await Array.from({ length: 5 }).reduce<Promise<ReadonlyArray<string>>>(
      (previous) =>
        previous.then(async (found) => {
          const message = await diagnosticsOf(program, crash)
          await settled(150)
          return [...found, message]
        }),
      Promise.resolve([]),
    )
    expect(startedIn(stand.lines())).toHaveLength(4)
    expect(messages[messages.length - 1]).toContain('after 4 attempts')
    program.dispose()
  })

  it('keeps giving up on a server that crashes as it starts, however long the wait', async () => {
    const stand = standInServer()
    const program = createNativeProgram(stand.command, stand.folder, () => Option.some(inferredProject), {
      stableFor: 100,
    })
    const crash = join(stand.folder, 'crash.ts')
    program.sync([{ path: crash, text: 'boom' }])
    const messages = await Array.from({ length: 6 }).reduce<Promise<ReadonlyArray<string>>>(
      (previous) =>
        previous.then(async (found) => {
          const message = await diagnosticsOf(program, crash)
          await settled(300)
          return [...found, message]
        }),
      Promise.resolve([]),
    )
    expect(startedIn(stand.lines())).toHaveLength(4)
    expect(messages[messages.length - 1]).toContain('after 4 attempts')
    program.dispose()
  })

  it('counts restarts afresh after a server that ran for a while', async () => {
    const stand = standInServer()
    const program = createNativeProgram(stand.command, stand.folder, () => Option.some(inferredProject), {
      stableFor: 100,
    })
    const a = join(stand.folder, 'a.ts')
    const boom = join(stand.folder, 'boom.ts')
    program.sync([{ path: a, text: 'a' }], [{ path: boom, text: 'boom' }])
    await Array.from({ length: 5 }).reduce<Promise<void>>(
      (previous) =>
        previous.then(async () => {
          await program.hover(a, position)
          await settled(200)
          await program.hover(boom, position)
          await settled(100)
        }),
      Promise.resolve(),
    )
    expect(startedIn(stand.lines())).toHaveLength(5)
    expect(await diagnosticsOf(program, a)).not.toContain('stopped')
    program.dispose()
  })
})

describe('createNativeProgram waits for its compiler', () => {
  it('starts the server only once its compiler is ready', async () => {
    const stand = standInServer()
    const gate = Promise.withResolvers<void>()
    const program = createNativeProgram(stand.command, stand.folder, () => Option.some(inferredProject), {
      ready: () => gate.promise,
    })
    const a = join(stand.folder, 'a.ts')
    program.sync([{ path: a, text: 'a' }])
    const hover = program.hover(a, position)
    await settled(200)
    expect(startedIn(stand.lines())).toHaveLength(0)
    gate.resolve()
    expect(await hover).toBeDefined()
    expect(startedIn(stand.lines())).toHaveLength(1)
    program.dispose()
  })

  it('reports a compiler it could not fetch, and starts nothing', async () => {
    const stand = standInServer()
    const program = createNativeProgram(stand.command, stand.folder, () => Option.some(inferredProject), {
      ready: () => Promise.reject(new Error('could not fetch TypeScript 7.0.0-test')),
    })
    const a = join(stand.folder, 'a.ts')
    program.sync([{ path: a, text: 'a' }])
    expect(await diagnosticsOf(program, a)).toContain('could not fetch TypeScript 7.0.0-test')
    expect(startedIn(stand.lines())).toHaveLength(0)
    program.dispose()
  })
})

describe('createNativeProgram asks the server about the code\'s shape', () => {
  it('forwards the outline, folding and selection questions', async () => {
    const stand = standInServer()
    const program = createNativeProgram(stand.command, stand.folder)
    const a = join(stand.folder, 'a.ts')
    program.sync([{ path: a, text: 'export const a = 1' }])
    await program.documentSymbols(a)
    await program.foldingRanges(a)
    await program.selectionRanges(a, [position])
    expect(stand.lines()).toEqual(
      expect.arrayContaining([
        'textDocument/documentSymbol a.ts',
        'textDocument/foldingRange a.ts',
        'textDocument/selectionRange a.ts',
      ]),
    )
    program.dispose()
  })
})

describe('createNativeProgram gives up at once on a server that cannot start', () => {
  it('reports the reason, and tries no restart', async () => {
    const stand = standInServer()
    const program = createNativeProgram(join(stand.folder, 'missing'), stand.folder)
    const a = join(stand.folder, 'a.ts')
    program.sync([{ path: a, text: 'a' }])
    const first = await diagnosticsOf(program, a)
    await settled(150)
    const second = await diagnosticsOf(program, a)
    expect(first).toContain('could not start')
    expect(second).toContain('after one attempt')
    expect(second).toContain('could not start')
    program.dispose()
  })
})

describe('createNativeProgram holds a root from the moment it is asked about', () => {
  it('keeps the root open through the wait for ready', async () => {
    const stand = standInServer()
    const program = createNativeProgram(stand.command, stand.folder, () => Option.some(inferredProject), {
      ready: () => settled(300),
    })
    const first = join(stand.folder, 'first.loom')
    const second = join(stand.folder, 'second.loom')
    const x = { path: `${first}.x.ts`, text: 'x', loose: true, loom: first }
    const y = { path: `${second}.y.ts`, text: 'y', loose: true, loom: second }
    program.sync([x])
    const asked = program.hover(x.path, position)
    program.sync([y])
    await Promise.all([asked, program.hover(y.path, position)])
    await settled()
    const lines = stand.lines()
    expect(lines.indexOf('textDocument/hover first.loom.x.ts')).toBeLessThan(
      lines.indexOf('textDocument/didClose first.loom.x.ts'),
    )
    program.dispose()
  })
})

describe('createNativeProgram repeats why a server would not start', () => {
  it('reports the refusal, and repeats it once it gives up', async () => {
    const stand = standInServer()
    const refusing = join(stand.folder, 'refusing')
    writeFileSync(refusing, `#!/bin/sh\nexec ${JSON.stringify(stand.command)} --refuse "$@"\n`, { mode: 0o755 })
    const program = createNativeProgram(refusing, stand.folder)
    const a = join(stand.folder, 'a.ts')
    program.sync([{ path: a, text: 'a' }])
    const messages = await Array.from({ length: 5 }).reduce<Promise<ReadonlyArray<string>>>(
      (previous) =>
        previous.then(async (found) => {
          const message = await diagnosticsOf(program, a)
          await settled(150)
          return [...found, message]
        }),
      Promise.resolve([]),
    )
    expect(messages[0]).toContain('refused to start: cannot read tsconfig.json')
    expect(messages[messages.length - 1]).toContain('after 4 attempts')
    expect(messages[messages.length - 1]).toContain('cannot read tsconfig.json')
    program.dispose()
  })
})

describe('asOpened sends a TypeScript loose root as a module', () => {
  it('ends a TypeScript loose root with ;export {}, and leaves every other root as written', () => {
    const loose = { path: '/w/chapter.loom.aside.ts', text: 'const a = 1', loose: true }
    expect(asOpened(loose).text).toBe('const a = 1\n;export {}\n')
    expect(asOpened({ ...loose, path: '/w/chapter.loom.aside.js' }).text).toBe('const a = 1')
    expect(asOpened({ path: '/w/src/a.ts', text: 'const a = 1' }).text).toBe('const a = 1')
  })
})

describe('createUnavailableProgram reports its reason', () => {
  it('reports the compiler and the reason as an error diagnostic and answers other questions with nothing', async () => {
    const program = createUnavailableProgram('TypeScript 7', 'install @typescript/typescript-test')
    const message = await diagnosticsOf(program, '/a.ts')
    expect(message).toContain('TypeScript 7 is unavailable')
    expect(message).toContain('install @typescript/typescript-test')
    expect(await program.hover('/a.ts', position)).toBeUndefined()
    expect(await program.documentSymbols('/a.ts')).toBeUndefined()
  })
})
