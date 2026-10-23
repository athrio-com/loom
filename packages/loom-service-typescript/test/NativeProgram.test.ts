import * as ts from 'typescript'
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
  compilerChoiceFor,
  createNativeProgram,
  createUnavailableProgram,
} from '../src/NativeProgram'
import { configNear, servedByCompiler } from '../src/TypescriptService'
import { settled, standInServer, startedIn } from './StandInServer'

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
    expect(compilerChoiceFor(projectAt(root), Option.none())).toEqual(
      expect.objectContaining({ _tag: 'Native', executable: executableIn(root) }),
    )
  })

  it('leaves a project on TypeScript 6 to the TypeScript 6 program', () => {
    const root = folder()
    install(root, '6.0.3')
    expect(compilerChoiceFor(projectAt(root), Option.none())._tag).toBe('Classic')
  })

  it('reports a TypeScript 7 without this platform\'s executable as unavailable', () => {
    const root = folder()
    install(root, '7.0.2', 'none')
    const choice = compilerChoiceFor(projectAt(root), Option.none())
    expect(choice._tag).toBe('Unavailable')
    expect(choice._tag === 'Unavailable' && choice.reason).toContain(`@typescript/${companion}`)
  })

  it('reports an executable that may not be run as unavailable', () => {
    const root = folder()
    install(root, '7.0.2', 'plain')
    expect(compilerChoiceFor(projectAt(root), Option.none())._tag).toBe('Unavailable')
  })

  it('chooses from the loom\'s own folder when no tsconfig.json governs it', () => {
    const root = folder()
    install(root, '7.0.2')
    expect(compilerChoiceFor(looseAt(root), Option.none())._tag).toBe('Native')
  })

  it('chooses the same for the corpus search, whose key is its own', () => {
    const root = folder()
    install(root, '7.0.2')
    const corpus = { ...looseAt(root), key: `corpus of ${join(root, 'chapter.loom')}` }
    expect(compilerChoiceFor(corpus, Option.none())._tag).toBe('Native')
  })
})

describe('compilerChoiceFor follows the nativeCompiler setting', () => {
  it('uses the TypeScript 7 the setting names, over the project\'s own', () => {
    const root = folder()
    install(root, '6.0.3')
    const elsewhere = folder()
    const named = install(elsewhere, '7.0.2')
    expect(compilerChoiceFor(projectAt(root), Option.some(named))).toEqual(
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
      compilerChoiceFor(project, Option.some('tools/node_modules/typescript'))._tag,
    ).toBe('Native')
  })

  it('reports a setting that names no typescript package as unavailable', () => {
    const root = folder()
    const choice = compilerChoiceFor(projectAt(root), Option.some(join(root, 'nothing-here')))
    expect(choice._tag).toBe('Unavailable')
  })

  it('reports a setting that names TypeScript 6 as unavailable', () => {
    const root = folder()
    const named = install(folder(), '6.0.3')
    const choice = compilerChoiceFor(projectAt(root), Option.some(named))
    expect(choice._tag).toBe('Unavailable')
    expect(choice._tag === 'Unavailable' && choice.reason).toContain('TypeScript 6')
  })

  it('reports a setting that names another package as unavailable', () => {
    const root = folder()
    const named = install(folder(), '7.0.2', 'executable', 'not-typescript')
    expect(compilerChoiceFor(projectAt(root), Option.some(named))._tag).toBe('Unavailable')
  })

  it('reports a setting that is not a path as unavailable', () => {
    const root = folder()
    expect(compilerChoiceFor(projectAt(root), Option.some(true))._tag).toBe('Unavailable')
    expect(compilerChoiceFor(projectAt(root), Option.some(''))._tag).toBe('Unavailable')
  })

  it('follows a linked folder to the store it points into', () => {
    const root = folder()
    const store = folder()
    const real = install(store, '7.0.2')
    mkdirSync(join(root, 'node_modules'), { recursive: true })
    symlinkSync(real, join(root, 'node_modules', 'typescript-native'))
    const named = join(root, 'node_modules', 'typescript-native')
    expect(compilerChoiceFor(projectAt(root), Option.some(named))).toEqual(
      expect.objectContaining({ _tag: 'Native', executable: executableIn(store) }),
    )
  })
})

describe('servedByCompiler names the roots a native program serves', () => {
  it('serves the scripts of looms in one folder, not other files or a project on TypeScript 6', () => {
    const root = folder()
    install(root, '7.0.2')
    const legacy = join(root, 'legacy')
    mkdirSync(legacy, { recursive: true })
    install(legacy, '6.0.3')
    writeFileSync(join(legacy, 'tsconfig.json'), '{}')
    const servedBy = servedByCompiler(configNear(ts), Option.none())(executableIn(root))
    const rootOf = (path: string, loom: string) => ({ path: join(root, path), text: '', loom: join(root, loom) })
    expect(servedBy(rootOf('src/a.ts', 'corpus/a.loom'))).toBe(true)
    expect(servedBy(rootOf('src/b.ts', 'corpus/b.loom'))).toBe(true)
    expect(servedBy(rootOf('package.json', 'corpus/a.loom'))).toBe(false)
    expect(servedBy(rootOf('legacy/src/c.ts', 'corpus/c.loom'))).toBe(false)
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
    const program = createNativeProgram(stand.command, stand.folder, (file) => !file.path.endsWith('old.ts'))
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
    expect(messages[messages.length - 1]).toContain('stopped 4 times')
    program.dispose()
  })

  it('keeps giving up on a server that crashes as it starts, however long the wait', async () => {
    const stand = standInServer()
    const program = createNativeProgram(stand.command, stand.folder, () => true, { stableFor: 100 })
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
    expect(messages[messages.length - 1]).toContain('stopped 4 times')
    program.dispose()
  })

  it('counts restarts afresh after a server that ran for a while', async () => {
    const stand = standInServer()
    const program = createNativeProgram(stand.command, stand.folder, () => true, { stableFor: 100 })
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

describe('createUnavailableProgram reports its reason', () => {
  it('reports the reason as an error diagnostic and answers other questions with nothing', async () => {
    const program = createUnavailableProgram('install @typescript/typescript-test')
    expect(await diagnosticsOf(program, '/a.ts')).toContain('install @typescript/typescript-test')
    expect(await program.hover('/a.ts', position)).toBeUndefined()
  })
})
