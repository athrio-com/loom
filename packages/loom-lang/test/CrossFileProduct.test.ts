import { createTypeScriptInferredChecker } from '@volar/kit'
import { Effect, Layer, ManagedRuntime } from 'effect'
import { resolve } from 'node:path'
import * as ts from 'typescript'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DocumentSource, LoomCompiler } from '../src/LoomCompiler'
import { PackageConfig } from '../src/PackageConfig'
import { LoomConfig } from '@athrio/loom-config/LoomConfig'
import { loomLanguagePlugin, loomServicePlugins } from '../src/LoomLanguagePlugin'
import { serviceStore } from './store'

// End-to-end through Volar, across two .loom files. library.loom exports `greet`
// and tangles to library.ts; two callers sit beside it in the same corpus.
// importer.loom imports `greet` from './library.ts' and must type-check clean —
// the product service resolves the import against library.loom's live composition,
// not a file on disk. caller.loom uses `greet` with no import at all and must
// report TS2304, the very hint a missing import should raise. The check proves the
// service surfaces a cross-file resolution and its absence alike. The config is a
// fake, so the corpus is discovered from the fixture directory and no on-disk
// loom.json is needed.

const dir = resolve(__dirname, 'fixtures/xfile')
const importer = resolve(dir, 'importer.loom')
const caller = resolve(dir, 'caller.loom')

// Building a TypeScript checker and running the first check loads the standard
// library cold; under full-suite load that runs past the 5s default, so give these
// the same headroom the other Volar checker tests take.
const SLOW = 30_000

// loadActive imports the built service from a Loom store; serviceStore builds it and
// stands one up under LOOM_HOME for the run.
let teardown: () => void
beforeAll(() => {
  teardown = serviceStore()
})
afterAll(() => teardown())

const checkerFor = async (entry: string) => {
  const configMock = Layer.succeed(LoomConfig, {
    resolve: () =>
      Effect.succeed({
        anchor: undefined,
        primary: 'typescript',
        languages: ['typescript'],
        settings: {},
        services: {},
        packageRoot: undefined,
        workspaceRoot: undefined,
        corpusDir: undefined,
      }),
    manifest: () => Effect.succeed({ languages: { typescript: {} } }),
    materialize: () => Effect.void,
  })
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(LoomCompiler.layer, configMock).pipe(
      Layer.provide(DocumentSource.layer),
      Layer.provide(PackageConfig.layer),
      Layer.provide(configMock),
    ),
  )
  const servicePlugins = await runtime.runPromise(
    loomServicePlugins(runtime, ts, entry),
  )
  return createTypeScriptInferredChecker(
    [loomLanguagePlugin(runtime)],
    [...servicePlugins],
    () => [entry],
    {
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      target: ts.ScriptTarget.ES2022,
      strict: true,
      skipLibCheck: true,
      noEmit: true,
    },
  )
}

describe('e2e — the product service resolves across .loom files', () => {
  it('an import of another loom’s export type-checks clean', async () => {
    const checker = await checkerFor(importer)
    const diagnostics = await checker.check(importer)
    expect(diagnostics.some((d) => /Cannot find module/.test(d.message))).toBe(false)
    expect(diagnostics.some((d) => /Cannot find name 'greet'/.test(d.message))).toBe(false)
  }, SLOW)

  it('using an export with no import raises the missing-name hint', async () => {
    const checker = await checkerFor(caller)
    const diagnostics = await checker.check(caller)
    console.log(
      '\n[expected — not a test failure] caller.loom uses `greet` with no import;\n' +
        'the product service reports the missing name on the .loom:\n\n' +
        checker.printErrors(caller, diagnostics),
    )
    expect(diagnostics.some((d) => /Cannot find name 'greet'/.test(d.message))).toBe(true)
  }, SLOW)
})
