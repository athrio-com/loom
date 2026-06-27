import { createTypeScriptInferredChecker } from '@volar/kit'
import { Effect, Layer, Runtime } from 'effect'
import { dirname, resolve } from 'node:path'
import * as ts from 'typescript'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DocumentSource, LoomCompiler } from '../src/LoomCompiler'
import { PackageConfig } from '../src/PackageConfig'
import { LoomConfig } from '@athrio/loom-config/LoomConfig'
import { loomLanguagePlugin, loomServicePlugins } from '../src/LoomLanguagePlugin'
import { serviceStore } from './store'

// End-to-end through Volar: Loom's own health — the grammatical and semantic
// diagnostics Loom finds, which TypeScript knows nothing about — must reach the
// editor. The frame service registers `loomDiagnostics`, which reads a file's health
// from `FrameQuery` and answers Volar's request on the source-mirror root. This proves
// the whole path: an unresolved `::[…]` anchor is a guaranteed piece of Loom health, so
// it must surface on the `.loom`; a clean file must surface none.

const SLOW = 30_000

// The TypeScript service the checker uses is loaded from a Loom store; build it
// and stand one up under LOOM_HOME for the run.
let teardown: () => void
beforeAll(() => {
  teardown = serviceStore()
})
afterAll(() => teardown())

const tsOptions = {
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  target: ts.ScriptTarget.ES2022,
  strict: true,
  skipLibCheck: true,
  noEmit: true,
}

// The checker runs the real Loom service plugins — `loomServicePlugins` collects them
// and builds the `FrameQuery` the frame service reads, exactly as the language server
// does on initialize. The config is a fake, so no on-disk loom.json is needed.
const checkerFor = (fixture: string) =>
  Effect.runtime<LoomCompiler | LoomConfig>()
    .pipe(
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
                languages: ['typescript'],
                settings: {},
                services: {},
                packageRoot: undefined,
              }),
            manifest: () => Effect.succeed({ languages: { typescript: {} } }),
            materialize: () => Effect.void,
          }),
        ),
      ),
      Effect.runPromise,
    )
    .then(async (runtime) => {
      const plugins = await Runtime.runPromise(runtime)(
        loomServicePlugins(ts, dirname(fixture)),
      )
      return createTypeScriptInferredChecker(
        [loomLanguagePlugin(runtime)],
        [...plugins],
        () => [fixture],
        tsOptions,
      )
    })

describe('Loom diagnostics — the editor surfaces Loom health', () => {
  it('an unresolved anchor reports on the .loom', async () => {
    const fixture = resolve(__dirname, 'fixtures/health-anchor.loom')
    const checker = await checkerFor(fixture)
    const diagnostics = await checker.check(fixture)
    const loom = diagnostics.filter((d) => d.source === 'loom')
    console.log(
      '\n[expected — not a test failure] health-anchor.loom anchors a missing\n' +
        'section; Loom surfaces its own diagnostic on the .loom:\n\n' +
        checker.printErrors(fixture, loom),
    )
    expect(loom.length).toBeGreaterThan(0)
  }, SLOW)

  it('a malformed tag reports on the .loom', async () => {
    const fixture = resolve(__dirname, 'fixtures/malformed-tag.loom')
    const checker = await checkerFor(fixture)
    const diagnostics = await checker.check(fixture)
    const loom = diagnostics.filter((d) => d.source === 'loom')
    console.log(
      '\n[expected — not a test failure] malformed-tag.loom has an unclosed `[Tag`;\n' +
        'Loom surfaces its grammatical health on the .loom:\n\n' +
        checker.printErrors(fixture, loom),
    )
    expect(loom.length).toBeGreaterThan(0)
    // The squiggle lands on the `[Tag` label — line 3 (index 2), at or after the
    // `[` (index 9) — not collapsed onto the `#` at character 0.
    expect(
      loom.some((d) => d.range.start.line === 2 && d.range.start.character >= 9),
    ).toBe(true)
    // `Negd` is a valid label value; the only fault is the missing `]`, so the
    // unclosed tag must not also draw a bogus "label value must match" error.
    expect(loom.some((d) => /label value must match/.test(d.message))).toBe(false)
  }, SLOW)

  it('an unclosed anchor reports on its own line, not the next', async () => {
    const fixture = resolve(__dirname, 'fixtures/unclosed-anchor.loom')
    const checker = await checkerFor(fixture)
    const diagnostics = await checker.check(fixture)
    const loom = diagnostics.filter((d) => d.source === 'loom')
    console.log(
      '\n[expected — not a test failure] unclosed-anchor.loom diagnostics:\n' +
        diagnostics
          .map(
            (d) =>
              `  ${d.range.start.line + 1}:${d.range.start.character + 1} [${d.source}] ${d.message.split('\n')[0]}`,
          )
          .join('\n'),
    )
    // `::[n` is on line 7 (index 6); the close error stays there.
    expect(
      loom.some(
        (d) => /expected closing/.test(d.message) && d.range.start.line === 6,
      ),
    ).toBe(true)
    // Nothing bleeds onto the next line (index 7): the old EOL bug captured the
    // newline into the anchor and mangled the following code into a phantom error.
    expect(diagnostics.every((d) => d.range.start.line !== 7)).toBe(true)
  }, SLOW)

  it('a clean file draws no Loom diagnostic', async () => {
    const fixture = resolve(__dirname, 'fixtures/clean-health.loom')
    const checker = await checkerFor(fixture)
    const diagnostics = await checker.check(fixture)
    expect(diagnostics.some((d) => d.source === 'loom')).toBe(false)
  }, SLOW)

  it('an empty anchor reports one fault and leaves the code under it type-checked', async () => {
    const fixture = resolve(__dirname, 'fixtures/empty-anchor.loom')
    const checker = await checkerFor(fixture)
    const diagnostics = await checker.check(fixture)
    const loom = diagnostics.filter((d) => d.source === 'loom')
    console.log(
      '\n[expected — not a test failure] empty-anchor.loom `::[]` diagnostics:\n' +
        diagnostics
          .map(
            (d) =>
              `  ${d.range.start.line + 1}:${d.range.start.character + 1} [${d.source}] ${d.message.split('\n')[0]}`,
          )
          .join('\n'),
    )
    // The single true fault: the anchor's name is empty.
    expect(
      loom.some((d) => /Anchor name cannot be empty/.test(d.message)),
    ).toBe(true)
    // The grammatical fault must not cascade into a semantic unresolved report.
    expect(loom.some((d) => /Unresolved anchor/.test(d.message))).toBe(false)
    // The broken anchor must not disable the product TypeScript under it: the
    // empty fragment keeps the run whole, so the section still has a de re and
    // TypeScript still checks `negDouble` — `negate` is undefined, so it reports.
    expect(
      diagnostics.some(
        (d) => d.source === 'ts' && /Cannot find name 'negate'/.test(d.message),
      ),
    ).toBe(true)
  }, SLOW)

  it('an unresolved anchor reports the miss but still type-checks the code under it', async () => {
    const fixture = resolve(__dirname, 'fixtures/unresolved-keeps-ts.loom')
    const checker = await checkerFor(fixture)
    const diagnostics = await checker.check(fixture)
    console.log(
      '\n[expected — not a test failure] unresolved-keeps-ts.loom `::[Missing]` diagnostics:\n' +
        diagnostics
          .map(
            (d) =>
              `  ${d.range.start.line + 1}:${d.range.start.character + 1} [${d.source}] ${d.message.split('\n')[0]}`,
          )
          .join('\n'),
    )
    // Loom reports the unresolved anchor — the author's miss.
    expect(
      diagnostics.some(
        (d) => d.source === 'loom' && /Unresolved anchor/.test(d.message),
      ),
    ).toBe(true)
    // The product TypeScript under it stays active: the inert fragment keeps the
    // run whole, so the section still has a de re and `negate` is reported.
    expect(
      diagnostics.some(
        (d) => d.source === 'ts' && /Cannot find name 'negate'/.test(d.message),
      ),
    ).toBe(true)
  }, SLOW)

  it('a value warp templates its value as text, so `::[kw]` becomes `const`', async () => {
    const fixture = resolve(__dirname, 'fixtures/value-warp.loom')
    const checker = await checkerFor(fixture)
    const diagnostics = await checker.check(fixture)
    console.log(
      '\n[expected — not a test failure] value-warp.loom `{{kw = "const"}}` + `::[kw] doubled = …`:\n' +
        diagnostics
          .map(
            (d) =>
              `  ${d.range.start.line + 1}:${d.range.start.character + 1} [${d.source}] ${d.message.split('\n')[0]}`,
          )
          .join('\n'),
    )
    // The value warp resolves — no unresolved-anchor miss.
    expect(
      diagnostics.some(
        (d) => d.source === 'loom' && /Unresolved anchor/.test(d.message),
      ),
    ).toBe(false)
    // `::[kw]` templates the value `const` in, so the line composes to
    // `const doubled = …` and `doubled` is in scope where `result` uses it. Had
    // it composed `"const"`, `doubled` would be undeclared — "Cannot find name".
    expect(
      diagnostics.some((d) => /Cannot find name 'doubled'/.test(d.message)),
    ).toBe(false)
  }, SLOW)

  it('a value warp is type-checked where it lands — a number in a string slot', async () => {
    const fixture = resolve(__dirname, 'fixtures/value-typed.loom')
    const checker = await checkerFor(fixture)
    const diagnostics = await checker.check(fixture)
    console.log(
      '\n[expected — not a test failure] value-typed.loom `{{port = 8080}}` in a string slot:\n' +
        diagnostics
          .map(
            (d) =>
              `  ${d.range.start.line + 1}:${d.range.start.character + 1} [${d.source}] ${d.message.split('\n')[0]}`,
          )
          .join('\n'),
    )
    // `8080` templates into a `string` slot, so TypeScript rejects it at the anchor.
    expect(
      diagnostics.some(
        (d) =>
          d.source === 'ts' && /not assignable to type 'string'/.test(d.message),
      ),
    ).toBe(true)
  }, SLOW)
})
