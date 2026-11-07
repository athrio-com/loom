import { describe, expect, it as it_ } from 'bun:test'
import { effectify } from '@athrio/effect-test'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect, Layer } from 'effect'
import { LoomConfig } from '@athrio/loom-config/LoomConfig'
import { serviceVersion, tropeDir } from '@athrio/loom-lang-services/LoomStore'
import { DocumentSource, LoomCompiler } from '../src/LoomCompiler'
import { TropePackages } from '../src/TropePackages'
import { FileSystemEnvironment } from '../src/WorkspaceSource'

const it = effectify(it_)

const lines = (...rows: ReadonlyArray<string>): string => `${rows.join('\n')}\n`

const onDisk = LoomCompiler.layer.pipe(
  Layer.provideMerge(TropePackages.layer),
  Layer.provideMerge(DocumentSource.layer),
  Layer.provideMerge(FileSystemEnvironment),
  Layer.provideMerge(LoomConfig.layer),
)

const rootOf = (trope: string) =>
  lines(
    '---',
    'Part XIV: Diagrams',
    'Chapter 1: Declaring the kind',
    `Trope: ${trope}`,
    '---',
    '',
    '# Declaring the kind',
    '',
    '## What the trope declares {Manifest}',
    '',
    '=>',
    '{ "contract": "1", "contributes": { "kinds": { "box": [{ "kind": "Mermaid", "body": "mermaid" }] } } }',
  )

const cells = lines(
  '---',
  'Part I, Chapter 1: Cells',
  '---',
  '',
  '# Cells',
  '',
  '::: The passes {Mermaid}',
  'flowchart LR',
  ':::',
)

const workspaceWith = (config: ReadonlyArray<string>, looms: Record<string, string>): string => {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'loom-tropes-')))
  mkdirSync(join(workspace, '.loom'), { recursive: true })
  mkdirSync(join(workspace, 'corpus'), { recursive: true })
  writeFileSync(join(workspace, '.loom', 'config.yaml'), lines('corpus: corpus', ...config))
  Object.entries(looms).forEach(([name, text]) =>
    writeFileSync(join(workspace, 'corpus', name), text),
  )
  const folder = tropeDir('mermaid', workspace)
  mkdirSync(join(folder, 'looms'), { recursive: true })
  writeFileSync(
    join(folder, 'package.json'),
    JSON.stringify({ name: '@athrio/loom-trope-mermaid', version: serviceVersion }),
  )
  writeFileSync(join(folder, 'looms', 'declaring.loom'), rootOf('Mermaid diagrams'))
  return workspace
}

const diagnosed = (workspace: string, loom: string) =>
  LoomCompiler.pipe(
    Effect.flatMap((compiler) => compiler.diagnose(join(workspace, 'corpus', loom))),
    Effect.map((found) => found.map((d) => d.message)),
  )

const faultsOf = (found: ReadonlyArray<string>) =>
  found.filter(
    (message) => message.startsWith('Unknown kind') || message.startsWith('Trope refused'),
  )

const installing = ['tropes:', '  mermaid: {}']

describe('a kind a workspace installs', () => {
  it.effect('lets a book write a box of a kind an installed trope declares', () =>
    Effect.gen(function* () {
      const workspace = workspaceWith(installing, { 'cells.loom': cells })
      expect(faultsOf(yield* diagnosed(workspace, 'cells.loom'))).toEqual([])
    }).pipe(Effect.provide(onDisk)),
  )

  it.effect('reads no package the configuration does not name', () =>
    Effect.gen(function* () {
      const workspace = workspaceWith([], { 'cells.loom': cells })
      expect(faultsOf(yield* diagnosed(workspace, 'cells.loom'))).toEqual([
        'Unknown kind: a box takes no kind `Mermaid`. It takes `Note`, `Chapter`, `Discussion`, `Trope`, and `Conclusion`.',
      ])
    }).pipe(Effect.provide(onDisk)),
  )

  it.effect('refuses a trope of the book that declares an installed kind', () =>
    Effect.gen(function* () {
      const workspace = workspaceWith(installing, {
        'cells.loom': cells,
        'charts.loom': rootOf('Charts'),
      })
      expect(faultsOf(yield* diagnosed(workspace, 'charts.loom'))).toEqual([
        'Trope refused: it declares the box kind `Mermaid`, which the trope `Mermaid diagrams` declares already, so Loom applies none of what this root declares.',
      ])
      expect(faultsOf(yield* diagnosed(workspace, 'cells.loom'))).toEqual([])
    }).pipe(Effect.provide(onDisk)),
  )
})

describe('the tropes a workspace installs, kept', () => {
  it.effect('reads the store again once the configuration names a new trope', () =>
    Effect.gen(function* () {
      const workspace = workspaceWith([], { 'cells.loom': cells })
      expect(faultsOf(yield* diagnosed(workspace, 'cells.loom'))).toHaveLength(1)
      writeFileSync(join(workspace, '.loom', 'config.yaml'), lines('corpus: corpus', ...installing))
      expect(faultsOf(yield* diagnosed(workspace, 'cells.loom'))).toEqual([])
    }).pipe(Effect.provide(onDisk)),
  )

  it.effect('gives the kinds the installed tropes declare', () =>
    Effect.gen(function* () {
      const workspace = workspaceWith(installing, { 'cells.loom': cells })
      const installed = yield* TropePackages
      const kinds = yield* installed.kindsFor(join(workspace, 'corpus', 'cells.loom'))
      expect(kinds.map((declared) => [declared.kind, declared.trope])).toEqual([
        ['Mermaid', 'Mermaid diagrams'],
      ])
    }).pipe(Effect.provide(onDisk)),
  )
})
