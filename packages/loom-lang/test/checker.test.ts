import { createTypeScriptInferredChecker } from '@volar/kit'
import { Effect } from 'effect'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as ts from 'typescript'
import { create as createTypeScriptServices } from 'volar-service-typescript'
import { beforeAll, describe, expect, it } from 'vitest'
import { DocumentSource, LoomCompiler } from '../src/LoomCompiler'
import { PackageConfig } from '../src/PackageConfig'
import { LoomConfig } from '@athrio/loom-config/LoomConfig'
import { loomLanguagePlugin } from '../src/LoomLanguagePlugin'

// End-to-end through Volar: drive a `.loom` through a TypeScript-aware language
// service built from the *same* loom language plugin VS Code will use, and
// confirm a frame type error maps back to the `.loom` line that caused it.
//
// The fixture's `{{x = Ghost}}` Warp binds a value naming nothing in scope, so the
// generated frame emits `dsl.referValue(Ghost, …)` — which tsc rejects with
// "Cannot find name 'Ghost'". The whole point of the virtual-code mapping is
// that Volar surfaces that on the `Ghost` token in the `.loom`, not on
// generated frame code the author never sees.

const fixture = resolve(__dirname, 'fixtures/checker.loom')
const fixtureText = readFileSync(fixture, 'utf8')

let checker: ReturnType<typeof createTypeScriptInferredChecker>

beforeAll(async () => {
  // A warm runtime: the loom plugin runs the projection synchronously on it.
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
})

describe('e2e — frame diagnostics map back to the .loom via Volar', () => {
  it('a Warp to a missing name errors on the .loom value', async () => {
    const diagnostics = await checker.check(fixture)
    // The fixture Warps to a missing `Ghost` section on purpose, so the checker
    // emits real tsc diagnostics. Print them under a banner — in one call, so the
    // label can never drift from the output — marking them as the expected,
    // asserted result, not a defect in the test run.
    console.log(
      '\n[expected — not a test failure] checker.loom intentionally Warps to a\n' +
        'missing `Ghost` section; the diagnostics below are the asserted result,\n' +
        'mapped from the generated frame back onto the `.loom`:\n\n' +
        checker.printErrors(fixture, diagnostics),
    )

    const ghost = diagnostics.find((d) => /Ghost/.test(d.message))
    expect(ghost).toBeDefined()

    // The diagnostic lands on the `{{x = Ghost}}` line in the .loom.
    const ghostLine = fixtureText
      .split('\n')
      .findIndex((line) => line.includes('Ghost'))
    expect(ghost!.range.start.line).toBe(ghostLine)
  })
})
