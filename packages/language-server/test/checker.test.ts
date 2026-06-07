import { createTypeScriptInferredChecker } from '@volar/kit'
import { Effect, Layer } from 'effect'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as ts from 'typescript'
import { create as createTypeScriptServices } from 'volar-service-typescript'
import { beforeAll, describe, expect, it } from 'vitest'
import { Loom } from '#ast/Loom'
import { FrameAstBuilder } from '#ast/FrameAstBuilder'
import { loomLanguagePlugin } from '../src/LoomLanguagePlugin'

// End-to-end through Volar: drive a `.loom` through a TypeScript-aware language
// service built from the *same* loom language plugin VS Code will use, and
// confirm a frame type error maps back to the `.loom` line that caused it.
//
// The fixture's `{{x: Ghost}}` Warp names a section that does not exist, so the
// generated frame emits `const x = yield* Ghost` — which tsc rejects with
// "Cannot find name 'Ghost'". The whole point of the virtual-code mapping is
// that Volar surfaces that on the `Ghost` token in the `.loom`, not on
// generated frame code the author never sees.

const fixture = resolve(__dirname, 'fixtures/checker.loom')
const fixtureText = readFileSync(fixture, 'utf8')

let checker: ReturnType<typeof createTypeScriptInferredChecker>

beforeAll(async () => {
  const layer = Layer.mergeAll(Loom.Default, FrameAstBuilder.Default)
  // A warm runtime: the loom plugin runs the projection synchronously on it.
  const runtime = await Effect.runPromise(
    Effect.runtime<Loom | FrameAstBuilder>().pipe(
      Effect.provide(layer),
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
  it('a Warp to a missing section errors on the .loom annotation', async () => {
    const diagnostics = await checker.check(fixture)
    // Show the mapped result — printed against the .loom file, not the frame.
    console.log(checker.printErrors(fixture, diagnostics))

    const ghost = diagnostics.find((d) => /Ghost/.test(d.message))
    expect(ghost).toBeDefined()

    // The diagnostic lands on the `{{x: Ghost}}` line in the .loom.
    const ghostLine = fixtureText
      .split('\n')
      .findIndex((line) => line.includes('Ghost'))
    expect(ghost!.range.start.line).toBe(ghostLine)
  })
})
