import { createTypeScriptInferredChecker } from '@volar/kit'
import type { VirtualCode } from '@volar/language-core'
import { Effect } from 'effect'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as ts from 'typescript'
import { create as createTypeScriptServices } from 'volar-service-typescript'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { URI } from 'vscode-uri'
import { DocumentSource, LoomCompiler } from '../src/LoomCompiler'
import { PackageConfig } from '../src/PackageConfig'
import { LoomConfig } from '@athrio/loom-config/LoomConfig'
import { loomLanguagePlugin } from '../src/LoomLanguagePlugin'

// Does a frame TYPE error gate the de re? `funtype` carries a {Loom} type error
// (`const bad: number = "oops"`) alongside a normal section. tsc rejects the frame
// and the diagnostic maps back to the .loom; the run strips types and produces the
// section's de re anyway. The claim under test: the de dicto (the type-checked
// frame) and the de re (the stripped, composed product) are independent — a frame
// type error surfaces in the editor, yet the section still composes.

const dir = mkdtempSync(join(tmpdir(), 'loom-typeerr-'))
const fun = join(dir, 'funtype.loom')
const funSrc = `{{lang: TypeScript}}

# Typed badly {Loom}

=>

const bad: number = "oops"

# Negated double

=>

const negate = (x: number) => -x
const negDouble = (x: number) => negate(x) * 2
`

let checker: ReturnType<typeof createTypeScriptInferredChecker>

beforeAll(async () => {
  writeFileSync(fun, funSrc)
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
    () => [fun],
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

afterAll(() => rmSync(dir, { recursive: true, force: true }))

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

// `# Negated double` normalises to the section name NegatedDouble, so its de re
// product virtual code is keyed by that name lowercased.
const negdOf = (path: string): string | undefined => {
  const root = checker.language.scripts.get(URI.file(path))?.generated?.root
  const negd = embedded(root, 'negateddouble')
  return negd?.snapshot.getText(0, negd.snapshot.getLength())
}

describe('a frame type error does not gate the de re', () => {
  it('surfaces the frame type error, yet still produces the de re', async () => {
    const diagnostics = await checker.check(fun)
    console.log(
      '\n[expected — not a test failure] funtype.loom carries a deliberate {Loom}\n' +
        'type error; the diagnostic below is the asserted de dicto result:\n\n' +
        checker.printErrors(fun, diagnostics),
    )
    // de dicto: tsc rejects the frame and the diagnostic maps back to the .loom
    expect(diagnostics.some((d) => /not assignable|number/.test(d.message))).toBe(true)
    // de re: the run strips types, so the section still composes
    expect(negdOf(fun)).toContain('const negate = (x: number) => -x')
    expect(negdOf(fun)).toContain('const negDouble')
  })
})
