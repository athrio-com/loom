import { describe, expect, it as it_ } from 'bun:test'
import { effectify } from '@athrio/effect-test'
const it = effectify(it_)
import { Effect, Layer, Option } from 'effect'
import { DocumentSource, LoomCompiler, type TangledFile } from '../src/LoomCompiler'
import { LoomMemo } from '../src/LoomMemo'
import { PackageConfig } from '../src/PackageConfig'
import { defaultAnchorDelims } from '@athrio/loom-ast/LoomTokens'

// One loom with three sink sections, each a different language: a TypeScript
// file that takes a block banner, a JSON file that has no comment to take one,
// and a shell script whose shebang must stay first. Driven over an in-memory
// DocumentSource so the tangle never touches disk.
const files: Record<string, string> = {
  '/greeter.loom': `---
Language: TypeScript
---

# Greeter [greeter.ts]

=>

export const hi = 'hello'

# Data [data.json]

=>

{ "x": 1 }

# Script [run.sh]

=>

#!/bin/sh
echo hi
`,
}

const TestDocs = Layer.succeed(DocumentSource, {
  read: (path: string) => Effect.succeed(files[path] ?? ''),
  list: Option.some(() => Effect.succeed(Object.keys(files))),
})

const configWith = (header: { readonly ascii: boolean } | undefined) =>
  Layer.succeed(PackageConfig, {
    resolve: () =>
      Effect.succeed({
        delims: defaultAnchorDelims,
        primaryLanguage: undefined,
        variables: {},
        header,
        packageRoot: undefined,
        workspaceRoot: undefined,
        corpusDir: undefined,
      }),
  })

const layerWith = (header: { readonly ascii: boolean } | undefined) =>
  Layer.provide(
    Layer.merge(LoomCompiler.layer, LoomMemo.layer),
    Layer.merge(TestDocs, configWith(header)),
  )

const contentOf = (out: ReadonlyArray<TangledFile>, suffix: string): string =>
  Option.getOrThrow(
    Option.fromNullishOr(out.find((file) => file.path.endsWith(suffix))),
  ).content

describe('tangle — the generated-file banner', () => {
  it.effect('stamps a block banner with the wordmark on a TypeScript file', () =>
    Effect.gen(function* () {
      const out = yield* (yield* LoomCompiler).tangle('/greeter.loom')
      const ts = contentOf(out, 'greeter.ts')
      expect(ts.startsWith('/*\n')).toBe(true)
      expect(ts).toContain('LLLL OOOO OOOO M   M')
      expect(ts).toContain('Tangled by Loom from greeter.loom')
      expect(ts).toContain("export const hi = 'hello'")
    }).pipe(Effect.provide(layerWith({ ascii: true }))),
  )

  it.effect('leaves a JSON file unstamped, since JSON has no comment', () =>
    Effect.gen(function* () {
      const out = yield* (yield* LoomCompiler).tangle('/greeter.loom')
      const json = contentOf(out, 'data.json')
      expect(json.startsWith('{')).toBe(true)
      expect(json).not.toContain('Tangled by Loom')
    }).pipe(Effect.provide(layerWith({ ascii: true }))),
  )

  it.effect('slips the banner below a shebang so the interpreter line stays first', () =>
    Effect.gen(function* () {
      const out = yield* (yield* LoomCompiler).tangle('/greeter.loom')
      const sh = contentOf(out, 'run.sh')
      expect(sh.startsWith('#!/bin/sh\n')).toBe(true)
      expect(sh).toContain('# Tangled by Loom from greeter.loom')
    }).pipe(Effect.provide(layerWith({ ascii: true }))),
  )

  it.effect('draws no wordmark when the header omits ascii', () =>
    Effect.gen(function* () {
      const out = yield* (yield* LoomCompiler).tangle('/greeter.loom')
      const ts = contentOf(out, 'greeter.ts')
      expect(ts.startsWith('/*\n')).toBe(true)
      expect(ts).toContain('Tangled by Loom from greeter.loom')
      expect(ts).not.toContain('LLLL OOOO OOOO M   M')
    }).pipe(Effect.provide(layerWith({ ascii: false }))),
  )

  it.effect('omits the banner entirely when no header is configured', () =>
    Effect.gen(function* () {
      const out = yield* (yield* LoomCompiler).tangle('/greeter.loom')
      const ts = contentOf(out, 'greeter.ts')
      expect(ts.startsWith("export const hi")).toBe(true)
      expect(ts).not.toContain('Tangled by Loom')
    }).pipe(Effect.provide(layerWith(undefined))),
  )
})
