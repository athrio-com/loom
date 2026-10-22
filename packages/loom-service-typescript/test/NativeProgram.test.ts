import { describe, expect, it } from 'bun:test'
import { Option } from 'effect'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compilerChoiceFor } from '../src/NativeProgram'

const executableName = process.platform === 'win32' ? 'tsc.exe' : 'tsc'
const companion = `typescript-${process.platform}-${process.arch}`

const install = (
  folder: string,
  version: string,
  companionPackage: 'executable' | 'plain' | 'none' = 'executable',
): string => {
  const typescript = join(folder, 'node_modules', 'typescript')
  mkdirSync(typescript, { recursive: true })
  writeFileSync(join(typescript, 'package.json'), JSON.stringify({ name: 'typescript', version }))
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
    const elsewhere = folder()
    const named = install(elsewhere, '6.0.3')
    const choice = compilerChoiceFor(projectAt(root), Option.some(named))
    expect(choice._tag).toBe('Unavailable')
    expect(choice._tag === 'Unavailable' && choice.reason).toContain('TypeScript 6')
  })
})

import { describe as describeProgram, expect as expectProgram, it as itProgram } from 'bun:test'
import { join as joinPath } from 'node:path'
import {
  createNativeProgram,
  createUnavailableProgram,
  NativeCompilerUnavailable,
  NativeProgramDisposed,
  NativeServerStopped,
} from '../src/NativeProgram'
import { settled, standInServer } from './StandInServer'

const position = { line: 0, character: 0 }

describeProgram('createNativeProgram warms the workspace once', () => {
  itProgram('asks for every non-loose root\'s diagnostics after the first answer, once', async () => {
    const stand = standInServer()
    const program = createNativeProgram(stand.command, stand.folder)
    const a = joinPath(stand.folder, 'a.ts')
    const b = joinPath(stand.folder, 'b.ts')
    const loose = joinPath(stand.folder, 'chapter.loom.aside.ts')
    program.sync([{ path: a, text: 'a' }], [
      { path: b, text: 'b' },
      { path: loose, text: 'aside' },
    ])
    await program.hover(a, position)
    await program.hover(a, position)
    await settled(600)
    const diagnostics = stand.lines().filter((line) => line.startsWith('textDocument/diagnostic'))
    expectProgram(diagnostics.sort()).toEqual([
      'textDocument/diagnostic a.ts',
      'textDocument/diagnostic b.ts',
    ])
    expectProgram(stand.lines()).not.toContain('textDocument/didOpen chapter.loom.aside.ts v1')
    program.dispose()
  })

  itProgram('closes one loom\'s loose roots when another loom is asked about', async () => {
    const stand = standInServer()
    const program = createNativeProgram(stand.command, stand.folder)
    const first = joinPath(stand.folder, 'first.loom.aside.ts')
    const second = joinPath(stand.folder, 'second.loom.aside.ts')
    program.sync([{ path: first, text: 'one' }], [{ path: second, text: 'two' }])
    await program.hover(first, position)
    program.sync([{ path: second, text: 'two' }], [{ path: first, text: 'one' }])
    await program.hover(second, position)
    await settled()
    const lines = stand.lines()
    expectProgram(lines).toContain('textDocument/didClose first.loom.aside.ts')
    expectProgram(lines.indexOf('textDocument/didClose first.loom.aside.ts')).toBeLessThan(
      lines.indexOf('textDocument/didOpen second.loom.aside.ts v1'),
    )
    program.dispose()
  })

  itProgram('starts no new server once disposed, even mid warm-up', async () => {
    const stand = standInServer()
    const program = createNativeProgram(stand.command, stand.folder)
    const roots = Array.from({ length: 20 }, (_, index) => ({
      path: joinPath(stand.folder, `r${index}.ts`),
      text: `export const r${index} = ${index}`,
    }))
    program.sync(roots.slice(0, 1), roots.slice(1))
    await program.hover(roots[0]!.path, position)
    program.dispose()
    await settled(800)
    expectProgram(stand.lines().filter((line) => line === 'started')).toEqual(['started'])
    const failure = await program.hover(roots[0]!.path, position).then(
      () => undefined,
      (error: unknown) => error,
    )
    expectProgram(failure).toBeInstanceOf(NativeProgramDisposed)
  })
})

describeProgram('createNativeProgram restarts a crashed server a few times', () => {
  itProgram('restarts three times, then fails with NativeServerStopped', async () => {
    const stand = standInServer()
    const program = createNativeProgram(stand.command, stand.folder)
    const crash = joinPath(stand.folder, 'crash.ts')
    program.sync([{ path: crash, text: 'boom' }])
    const failures = await Array.from({ length: 5 }).reduce<Promise<ReadonlyArray<unknown>>>(
      (previous) =>
        previous.then(async (found) => {
          const failure = await program.hover(crash, position).then(
            () => undefined,
            (error: unknown) => error,
          )
          await settled(150)
          return [...found, failure]
        }),
      Promise.resolve([]),
    )
    expectProgram(stand.lines().filter((line) => line === 'started')).toHaveLength(4)
    expectProgram(failures[failures.length - 1]).toBeInstanceOf(NativeServerStopped)
    program.dispose()
  })
})

describeProgram('createUnavailableProgram fails every question with its reason', () => {
  itProgram('rejects with NativeCompilerUnavailable carrying the reason', async () => {
    const program = createUnavailableProgram('install @typescript/typescript-test')
    const failure = await program.hover('/a.ts', position).then(
      () => undefined,
      (error: unknown) => error,
    )
    expectProgram(failure).toBeInstanceOf(NativeCompilerUnavailable)
    expectProgram(String((failure as Error).message)).toContain('install @typescript/typescript-test')
  })
})
