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
import { loomLanguagePlugin } from '../src/LoomLanguagePlugin'

// Q1 check: does the import-association registration survive a frame TYPE error?
// `funtype` imports Neg from sad and transcludes it, AND carries a {Loom} type
// error (`const bad: number = "oops"`). tsc rejects the frame; the run strips types
// and produces the de re anyway. The claim under test: the frame's type error does
// not gate the registration — editing sad must still re-project funtype, because
// `associate` reads the import graph from the (total) build, not from the run.

const dir = mkdtempSync(join(tmpdir(), 'loom-typeerr-'))
const sad = join(dir, 'sad.loom')
const fun = join(dir, 'funtype.loom')
const sadOrig = `{{lang: TypeScript}}\n\n# Negate [Neg]\n\n=>\n\nconst negate = (x: number) => -x\n`
const funSrc = `{{lang: TypeScript}}

# Imports {Loom}

=>

import { Neg } from "./sad.loom"

# Typed badly {Loom}

=>

const bad: number = "oops"

# Negated double [Negd]

{{n: Neg}}

=>

::[n]
const negDouble = (x: number) => negate(x) * 2
`

let checker: ReturnType<typeof createTypeScriptInferredChecker>

beforeAll(async () => {
  writeFileSync(sad, sadOrig)
  writeFileSync(fun, funSrc)
  const runtime = await Effect.runPromise(
    Effect.runtime<LoomCompiler>().pipe(
      Effect.provide(LoomCompiler.Default),
      Effect.provide(DocumentSource.Default),
      Effect.provide(PackageConfig.Default),
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

const negdOf = (path: string): string | undefined => {
  const root = checker.language.scripts.get(URI.file(path))?.generated?.root
  const negd = embedded(root, 'negd')
  return negd?.snapshot.getText(0, negd.snapshot.getLength())
}

describe('a frame type error does not break the import association', () => {
  it('surfaces the frame type error, yet still produces the de re', async () => {
    const diagnostics = await checker.check(fun)
    console.log(
      '\n[expected — not a test failure] funtype.loom carries a deliberate {Loom}\n' +
        'type error; the diagnostic below is the asserted de dicto result:\n\n' +
        checker.printErrors(fun, diagnostics),
    )
    // de dicto: tsc rejects the frame and the diagnostic maps back to the .loom
    expect(diagnostics.some((d) => /not assignable|number/.test(d.message))).toBe(true)
    // de re: the run strips types, so the section still composes — sad inlined
    expect(negdOf(fun)).toContain('const negate = (x: number) => -x')
  })

  it('re-projects when the dependency changes, despite the frame type error', async () => {
    await checker.check(fun) // projects funtype → registers funtype depends on sad
    expect(negdOf(fun)).toContain('-x')

    writeFileSync(sad, sadOrig.replace('-x', '-x * 7'))
    checker.fileUpdated(sad)
    await checker.check(sad) // dirties funtype via the association; evicts sad's build

    // The association held even though funtype's frame has a type error: reading
    // funtype re-projects it, and the re-projection inlines the fresh sad.
    expect(negdOf(fun)).toContain('-x * 7')
  })
})
