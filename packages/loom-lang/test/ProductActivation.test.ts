import { createTypeScriptInferredChecker } from '@volar/kit'
import { Effect, Layer, Runtime } from 'effect'
import { resolve } from 'node:path'
import * as ts from 'typescript'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DocumentSource, LoomCompiler } from '../src/LoomCompiler'
import { PackageConfig } from '../src/PackageConfig'
import { LoomConfig } from '@athrio/loom-config/LoomConfig'
import { loomLanguagePlugin, loomServicePlugins } from '../src/LoomLanguagePlugin'
import { serviceStore } from './store'

// End-to-end through Volar: activating `typescript` in loom.json makes loadActive
// load @athrio/loom-service-typescript from the store, whose service checks the
// file's product sections against a program of its own — Volar's frame program
// never holds them. typed.loom carries a
// deliberate de re type error (`const n: number = 'not a number'`). With
// TypeScript activated, the error surfaces on the `.loom`; with nothing activated,
// no product service is registered and only the frame is checked, so it stays
// silent. The config is a fake, so the proof needs no on-disk loom.json — the
// runtime carries LoomConfig and the collect pass reads activation from it.

const fixture = resolve(__dirname, 'fixtures/typed.loom')
const typeMismatch = /not assignable to type 'number'/

// Building a TypeScript checker and running the first check loads the standard
// library cold; under full-suite load that runs past the 5s default, so give
// these the same headroom the other Volar checker tests take.
const SLOW = 30_000

// loadActive imports the built service from a Loom store; serviceStore builds it
// and stands one up under LOOM_HOME for the run.
let teardown: () => void
beforeAll(() => {
  teardown = serviceStore()
})
afterAll(() => teardown())

const checkerActivating = async (languages: ReadonlyArray<string>) => {
  const runtime = await Effect.runtime<LoomCompiler | LoomConfig>().pipe(
    Effect.provide(LoomCompiler.Default),
    Effect.provide(DocumentSource.Default),
    Effect.provide(PackageConfig.Default),
    Effect.provide(
      Layer.succeed(
        LoomConfig,
        new LoomConfig({
          resolve: () =>
            Effect.succeed({
              anchor: undefined,
              primary: 'typescript',
              languages,
              settings: {},
              services: {},
              packageRoot: undefined,
              workspaceRoot: undefined,
              corpusDir: undefined,
            }),
          manifest: () =>
            Effect.succeed({
              languages: Object.fromEntries(languages.map((id) => [id, {}])),
            }),
          materialize: () => Effect.void,
        }),
      ),
    ),
    Effect.runPromise,
  )
  // The real collect-and-register pass: it registers TypescriptService when the
  // config activates typescript; the service checks the file's Products on its own.
  const servicePlugins = await Runtime.runPromise(runtime)(
    loomServicePlugins(ts, fixture),
  )
  return createTypeScriptInferredChecker(
    [loomLanguagePlugin(runtime)],
    [...servicePlugins],
    () => [fixture],
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

describe('e2e — product TypeScript activates through loom.json', () => {
  it('a de re type error surfaces when the package activates TypeScript', async () => {
    const checker = await checkerActivating(['typescript'])
    const diagnostics = await checker.check(fixture)
    console.log(
      '\n[expected — not a test failure] typed.loom holds a deliberate de re type\n' +
        'error; with TypeScript activated TypescriptService surfaces it on the .loom:\n\n' +
        checker.printErrors(fixture, diagnostics),
    )
    expect(diagnostics.some((d) => typeMismatch.test(d.message))).toBe(true)
  }, SLOW)

  it('the same error stays silent when the package activates nothing', async () => {
    const checker = await checkerActivating([])
    const diagnostics = await checker.check(fixture)
    expect(diagnostics.some((d) => typeMismatch.test(d.message))).toBe(false)
  }, SLOW)
})
