import { describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ManifestBuilder } from '../src/ManifestBuilder'
import { LoomConfig } from '@athrio/loom-config/LoomConfig'

// ManifestBuilder compiles a workspace's one {Config} source into the
// .loom/config.yaml that @athrio/loom-config reads. build shapes the source
// into a manifest; materialize writes it; LoomConfig.resolve then reads it
// back, so the two passes meet end to end.

const workspaceLoom = `# Workspace configuration {Config}

The languages this project activates and the defaults every section inherits.

=>

languages:
  typescript: {}
  python:
    service: custom-py
primary: typescript
anchor:
  open: "::["
  close: "]"
`

const setup = (): string => {
  const ws = mkdtempSync(join(tmpdir(), 'loom-mat-'))
  mkdirSync(join(ws, '.loom'), { recursive: true })
  mkdirSync(join(ws, 'corpus'), { recursive: true })
  writeFileSync(join(ws, 'corpus', 'config.loom'), workspaceLoom)
  return ws
}

const build = (ws: string) =>
  Effect.runPromise(
    ManifestBuilder.pipe(
      Effect.flatMap((m) => m.build(ws)),
      Effect.provide(ManifestBuilder.layer),
    ),
  )

const materialize = (ws: string) =>
  Effect.runPromise(
    ManifestBuilder.pipe(
      Effect.flatMap((m) => m.materialize(ws)),
      Effect.provide(ManifestBuilder.layer),
    ),
  )

const resolve = (path: string) =>
  Effect.runSync(
    LoomConfig.pipe(
      Effect.flatMap((c) => c.resolve(path)),
      Effect.provide(LoomConfig.layer),
    ),
  )

describe('ManifestBuilder — compiling the {Config} source', () => {
  it('shapes the workspace source into a manifest', async () => {
    const manifest = await build(setup())
    expect(manifest.languages).toEqual({
      typescript: {},
      python: { service: 'custom-py' },
    })
    expect(manifest.primary).toBe('typescript')
    expect(manifest.anchor).toEqual({ open: '::[', close: ']' })
  })

  it('materializes a .loom/config.yaml that LoomConfig resolves', async () => {
    const ws = setup()
    await materialize(ws)
    expect(existsSync(join(ws, '.loom', 'config.yaml'))).toBe(true)
    expect(resolve(join(ws, 'corpus', 'node.loom'))).toEqual({
      anchor: { open: '::[', close: ']' },
      primary: 'typescript',
      languages: ['typescript', 'python'],
      settings: {},
      services: {
        typescript: '@athrio/loom-service-typescript',
        python: 'custom-py',
      },
      packageRoot: ws,
      workspaceRoot: ws,
      corpusDir: join(ws, 'corpus'),
    })
  })
})
