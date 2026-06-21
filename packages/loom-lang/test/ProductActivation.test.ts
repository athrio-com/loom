import { createTypeScriptInferredChecker } from '@volar/kit'
import { Effect, Layer } from 'effect'
import { resolve } from 'node:path'
import * as ts from 'typescript'
import { create as createTypeScriptServices } from 'volar-service-typescript'
import { describe, expect, it } from 'vitest'
import { DocumentSource, LoomCompiler } from '../src/LoomCompiler'
import { PackageConfig } from '../src/PackageConfig'
import { LoomConfig } from '@athrio/loom-config/LoomConfig'
import { loomLanguagePlugin } from '../src/LoomLanguagePlugin'

// End-to-end through Volar: getExtraServiceScripts hands a package's de re
// TypeScript sections to the TypeScript program, but only when the package
// activates TypeScript. typed.loom holds a deliberate de re type error
// (`const n: number = 'not a number'`). With a config that activates typescript
// the error surfaces on the `.loom`; with one that activates nothing only the
// frame is checked and the error stays silent. The config is a fake, so the proof
// needs no on-disk loom.json — the runtime carries LoomConfig and the plugin reads
// activation from it.

const fixture = resolve(__dirname, 'fixtures/typed.loom')
const typeMismatch = /not assignable to type 'number'/

// Building a TypeScript checker and running the first check loads the standard
// library cold; under full-suite load that runs past the 5s default, so give
// these the same headroom the other Volar checker tests take.
const SLOW = 30_000

const checkerActivating = (languages: ReadonlyArray<string>) =>
  Effect.runtime<LoomCompiler | LoomConfig>().pipe(
    Effect.provide(LoomCompiler.Default),
    Effect.provide(DocumentSource.Default),
    Effect.provide(PackageConfig.Default),
    Effect.provide(
      Layer.succeed(
        LoomConfig,
        new LoomConfig({
          resolve: () =>
            Effect.succeed({ anchor: undefined, language: 'typescript', languages }),
          write: () => Effect.void,
        }),
      ),
    ),
    Effect.runPromise,
  ).then((runtime) =>
    createTypeScriptInferredChecker(
      [loomLanguagePlugin(runtime)],
      createTypeScriptServices(ts),
      () => [fixture],
      {
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        target: ts.ScriptTarget.ES2022,
        strict: true,
        skipLibCheck: true,
        noEmit: true,
      },
    ),
  )

describe('e2e — product TypeScript activates through loom.json', () => {
  it('a de re type error surfaces when the package activates TypeScript', async () => {
    const checker = await checkerActivating(['typescript'])
    const diagnostics = await checker.check(fixture)
    console.log(
      '\n[expected — not a test failure] typed.loom holds a deliberate de re type\n' +
        'error; with TypeScript activated it surfaces on the .loom:\n\n' +
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
