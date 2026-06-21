import { createTypeScriptInferredChecker } from '@volar/kit'
import type { VirtualCode } from '@volar/language-core'
import { Effect } from 'effect'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as ts from 'typescript'
import { create as createTypeScriptServices } from 'volar-service-typescript'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { URI } from 'vscode-uri'
import { DocumentSource, LoomCompiler } from '../src/LoomCompiler'
import { PackageConfig } from '../src/PackageConfig'
import { LoomConfig } from '@athrio/loom-config/LoomConfig'
import { loomLanguagePlugin } from '../src/LoomLanguagePlugin'

// End-to-end through Volar, the path the single-file projection could not take.
// fun.loom imports Neg from sad.loom and transcludes it, so fun's `negd` de re
// document must inline sad.loom's `negate` across the file boundary. The editor
// reads the open file from its snapshot and imports from disk (a passive source),
// then registers fun's corpus as Volar associations so a change to sad re-projects
// fun automatically — Volar's invalidation, driven by Loom's import graph.

const dir = resolve(__dirname, 'fixtures/crossfile')
const fun = resolve(dir, 'fun.loom')
const sad = resolve(dir, 'sad.loom')
const sadOrig = readFileSync(sad, 'utf8')

let checker: ReturnType<typeof createTypeScriptInferredChecker>

beforeAll(async () => {
  const runtime = await Effect.runPromise(
    Effect.runtime<LoomCompiler | LoomConfig>().pipe(
      Effect.provide(LoomCompiler.Default),
      Effect.provide(DocumentSource.Default),
      Effect.provide(PackageConfig.Default),
      Effect.provide(LoomConfig.Default),
    ),
  )
  checker = createTypeScriptInferredChecker(
    [loomLanguagePlugin(runtime)],
    createTypeScriptServices(ts),
    () => [fun, sad],
    {
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      target: ts.ScriptTarget.ES2022,
      strict: true,
      skipLibCheck: true,
      noEmit: true,
    },
  )
})

afterAll(() => {
  writeFileSync(sad, sadOrig)
})

const embedded = (
  root: VirtualCode | undefined,
  id: string,
): VirtualCode | undefined => {
  if (!root) return undefined
  if (root.id === id) return root
  for (const child of root.embeddedCodes ?? []) {
    const found = embedded(child, id)
    if (found) return found
  }
  return undefined
}

// Reading the script re-projects it if Volar marked it association-dirty, so this
// reflects whatever the latest dependency state implies — no explicit re-check.
const negdOf = (path: string): string => {
  const root = checker.language.scripts.get(URI.file(path))?.generated?.root
  const negd = embedded(root, 'negd')
  expect(negd).toBeDefined()
  return negd!.snapshot.getText(0, negd!.snapshot.getLength())
}

describe('cross-file transclusion in the editor', () => {
  it('inlines an imported section into the consuming de re document', async () => {
    await checker.check(fun)
    const code = negdOf(fun)
    expect(code).toContain('const negate = (x: number) => -x') // inlined from sad
    expect(code).toContain('const negDouble') // fun's own
  })

  it('re-projects via the association when the imported file changes', async () => {
    await checker.check(fun) // registers fun's dependency on sad
    expect(negdOf(fun)).toContain('const negate = (x: number) => -x')

    writeFileSync(sad, sadOrig.replace('-x', '-x * 3'))
    checker.fileUpdated(sad)
    await checker.check(sad) // dirties fun via the association; evicts sad's build

    // No checker.check(fun): reading fun re-projects it because Volar marked it
    // association-dirty, and the re-projection inlines the fresh sad.
    expect(negdOf(fun)).toContain('-x * 3')
  })
})
