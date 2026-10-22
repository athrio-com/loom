import { describe, expect, it as it_ } from 'bun:test'
import { effectify } from '@athrio/effect-test'
const it = effectify(it_)
import { Effect } from 'effect'
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LoomConfig, type ResolvedConfig } from '../src/LoomConfig'

// LoomConfig.resolve reads a workspace's compiled .loom/config.yaml and returns
// the configuration that applies to a given .loom path: the workspace defaults
// merged with the one package whose corpus contains the file.
const run = (path: string): ResolvedConfig =>
  Effect.runSync(
    LoomConfig.pipe(
      Effect.flatMap((config) => config.resolve(path)),
      Effect.provide(LoomConfig.layer),
    ),
  )

const manifest = `
languages:
  typescript: {}
  python:
    service: custom-py
primary: typescript
anchor:
  open: "::["
  close: "]"
`

const workspace = (config?: string): string => {
  const dir = mkdtempSync(join(tmpdir(), 'loom-ws-'))
  mkdirSync(join(dir, '.loom'), { recursive: true })
  if (config !== undefined) writeFileSync(join(dir, '.loom', 'config.yaml'), config)
  return dir
}

describe('LoomConfig.resolve — workspace manifest', () => {
  it('gives the workspace defaults and derives the package root for a corpus file', () => {
    const dir = workspace(manifest)
    expect(run(join(dir, 'packages', 'core', 'corpus', 'node.loom'))).toEqual({
      anchor: { open: '::[', close: ']' },
      primary: 'typescript',
      languages: ['typescript', 'python'],
      settings: {},
      variables: {},
      width: 100,
      services: {
        typescript: '@athrio/loom-service-typescript',
        python: 'custom-py',
      },
      packageRoot: join(dir, 'packages', 'core'),
      workspaceRoot: dir,
      corpusDir: join(dir, 'packages', 'core', 'corpus'),
    })
  })

  it('gives the workspace defaults to a file in no package', () => {
    const dir = workspace(manifest)
    expect(run(join(dir, 'docs', 'intro.loom'))).toEqual({
      anchor: { open: '::[', close: ']' },
      primary: 'typescript',
      languages: ['typescript', 'python'],
      settings: {},
      variables: {},
      width: 100,
      services: {
        typescript: '@athrio/loom-service-typescript',
        python: 'custom-py',
      },
      packageRoot: undefined,
      workspaceRoot: dir,
      corpusDir: join(dir, 'docs'),
    })
  })

  it('resolves to the empty configuration when the manifest is malformed', () => {
    const dir = workspace('languages: : :\n  not yaml')
    const result = run(join(dir, 'a.loom'))
    expect(result.languages).toEqual([])
    expect(result.packageRoot).toBeUndefined()
  })

  it('falls back to the empty configuration outside any workspace', () => {
    const dir = mkdtempSync(join(tmpdir(), 'loom-bare-'))
    expect(run(join(dir, 'a.loom'))).toEqual({
      anchor: undefined,
      primary: undefined,
      languages: [],
      settings: {},
      variables: {},
      width: 100,
      services: {},
      packageRoot: undefined,
      workspaceRoot: undefined,
      corpusDir: undefined,
    })
  })

  it('derives the package root from the corpus directory with no package mapped', () => {
    const dir = workspace(
      'corpus: corpus\nlanguages:\n  typescript: {}\nprimary: typescript\n',
    )
    expect(
      run(join(dir, 'packages', 'loom-ast', 'corpus', 'node.loom')),
    ).toEqual({
      anchor: undefined,
      primary: 'typescript',
      languages: ['typescript'],
      settings: {},
      variables: {},
      width: 100,
      services: { typescript: '@athrio/loom-service-typescript' },
      packageRoot: join(dir, 'packages', 'loom-ast'),
      workspaceRoot: dir,
      corpusDir: join(dir, 'packages', 'loom-ast', 'corpus'),
    })
  })

  it('carries no package root for a file outside any corpus directory', () => {
    const dir = workspace('corpus: corpus\nlanguages:\n  typescript: {}\n')
    expect(run(join(dir, 'notes', 'scratch.loom')).packageRoot).toBeUndefined()
  })
})

// LoomConfig keeps each manifest it reads and reuses it while the file's
// modification time and size match. One service instance resolves twice around a
// rewrite of the file, so the second resolve must read the rewritten manifest.
describe('LoomConfig.resolve — a manifest rewritten while the service runs', () => {
  const resolveTwice = (dir: string, rewrite: () => void) =>
    Effect.runSync(
      LoomConfig.pipe(
        Effect.flatMap((config) =>
          config.resolve(join(dir, 'a.loom')).pipe(
            Effect.tap(() => Effect.sync(rewrite)),
            Effect.flatMap((first) =>
              Effect.map(config.resolve(join(dir, 'a.loom')), (second) => [first, second] as const),
            ),
          ),
        ),
        Effect.provide(LoomConfig.layer),
      ),
    )

  it('reads the new manifest when the file changes size', () => {
    const dir = workspace('primary: typescript\n')
    const [first, second] = resolveTwice(dir, () =>
      writeFileSync(join(dir, '.loom', 'config.yaml'), 'primary: python\n'),
    )
    expect(first.primary).toBe('typescript')
    expect(second.primary).toBe('python')
  })

  it('reads the new manifest when only the modification time changes', () => {
    const dir = workspace('primary: aaaa\n')
    const file = join(dir, '.loom', 'config.yaml')
    const [first, second] = resolveTwice(dir, () => {
      writeFileSync(file, 'primary: bbbb\n')
      utimesSync(file, new Date(), new Date(Date.now() + 60_000))
    })
    expect(first.primary).toBe('aaaa')
    expect(second.primary).toBe('bbbb')
  })
})
