import { describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
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
      services: {},
      packageRoot: undefined,
      workspaceRoot: undefined,
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
