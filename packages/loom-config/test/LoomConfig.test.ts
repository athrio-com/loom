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
      Effect.provide(LoomConfig.Default),
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
packages:
  core:
    corpus: packages/core/corpus
    output: packages/core
    primary: python
    anchor:
      open: "<<"
      close: ">>"
`

const workspace = (config?: string): string => {
  const dir = mkdtempSync(join(tmpdir(), 'loom-ws-'))
  mkdirSync(join(dir, '.loom'), { recursive: true })
  if (config !== undefined) writeFileSync(join(dir, '.loom', 'config.yaml'), config)
  return dir
}

describe('LoomConfig.resolve — workspace manifest', () => {
  it("merges a package's overrides over the workspace defaults", () => {
    const dir = workspace(manifest)
    expect(run(join(dir, 'packages', 'core', 'corpus', 'node.loom'))).toEqual({
      anchor: { open: '<<', close: '>>' },
      primary: 'python',
      languages: ['typescript', 'python'],
      settings: {},
      services: {
        typescript: '@athrio/loom-service-typescript',
        python: 'custom-py',
      },
      packageRoot: 'packages/core',
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
    })
  })
})
