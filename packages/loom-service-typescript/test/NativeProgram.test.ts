import { describe, expect, it } from 'bun:test'
import { Option } from 'effect'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nativeCompilerFor } from '../src/NativeProgram'

const executableName = process.platform === 'win32' ? 'tsc.exe' : 'tsc'
const companion = `typescript-${process.platform}-${process.arch}`

const install = (folder: string, version: string, withCompanion = true): string => {
  const typescript = join(folder, 'node_modules', 'typescript')
  mkdirSync(typescript, { recursive: true })
  writeFileSync(join(typescript, 'package.json'), JSON.stringify({ name: 'typescript', version }))
  if (version.startsWith('7') && withCompanion) {
    const lib = join(folder, 'node_modules', '@typescript', companion, 'lib')
    mkdirSync(lib, { recursive: true })
    writeFileSync(join(lib, '..', 'package.json'), JSON.stringify({ name: `@typescript/${companion}`, version }))
    writeFileSync(join(lib, executableName), '')
  }
  return typescript
}

const folder = (): string => realpathSync(mkdtempSync(join(tmpdir(), 'loom-native-')))

const projectAt = (root: string) => {
  writeFileSync(join(root, 'tsconfig.json'), '{}')
  return { key: join(root, 'tsconfig.json'), config: Option.some(join(root, 'tsconfig.json')) }
}

describe('nativeCompilerFor chooses TypeScript 7 for a project that installs it', () => {
  it('finds the native executable of a project on TypeScript 7', () => {
    const root = folder()
    install(root, '7.0.2')
    const found = nativeCompilerFor(projectAt(root), Option.none())
    expect(Option.getOrUndefined(found)).toBe(
      join(root, 'node_modules', '@typescript', companion, 'lib', executableName),
    )
  })

  it('leaves a project on TypeScript 6 to the TypeScript 6 program', () => {
    const root = folder()
    install(root, '6.0.3')
    expect(Option.isNone(nativeCompilerFor(projectAt(root), Option.none()))).toBe(true)
  })

  it('leaves a TypeScript 7 without this platform\'s executable to TypeScript 6', () => {
    const root = folder()
    install(root, '7.0.2', false)
    expect(Option.isNone(nativeCompilerFor(projectAt(root), Option.none()))).toBe(true)
  })

  it('uses the TypeScript 7 the setting names, over the project\'s own', () => {
    const root = folder()
    install(root, '6.0.3')
    const elsewhere = folder()
    const named = install(elsewhere, '7.0.2')
    const found = nativeCompilerFor(projectAt(root), Option.some(named))
    expect(Option.getOrUndefined(found)).toBe(
      join(elsewhere, 'node_modules', '@typescript', companion, 'lib', executableName),
    )
  })
})
