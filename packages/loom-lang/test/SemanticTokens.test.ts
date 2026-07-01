import { describe, expect, it } from '@effect/vitest'
import { Effect, Layer, Option } from 'effect'
import { DocumentSource, LoomCompiler } from '../src/LoomCompiler'
import { LoomMemo } from '../src/LoomMemo'
import { PackageConfig } from '../src/PackageConfig'
import { defaultAnchorDelims } from '@athrio/loom-ast/LoomTokens'

// semanticTokens colours every token a .loom declares, reading LoomSymbol's table
// through the compiler. The fixture exercises each kind: the {{lang}} warp, a heading
// title with its {TypeScript} specifier and [., convert.ts] sink, a {{ratio}} value
// warp, a ::[ratio] anchor that names it, and the => and ~ that open and close the code.
const doc = `{{lang: TypeScript}}

# Converting {TypeScript} [., convert.ts]

{{ratio = 1.8}}

The forward direction.

=>

export const scale = ::[ratio]

~

The reverse direction.
`

const files: Record<string, string> = { '/convert.loom': doc }

const TestDocs = Layer.succeed(
  DocumentSource,
  new DocumentSource({
    read: (path: string) => Effect.succeed(files[path] ?? ''),
    list: Option.some(() => Effect.succeed(Object.keys(files))),
  }),
)

const TestConfig = Layer.succeed(
  PackageConfig,
  new PackageConfig({
    resolve: () =>
      Effect.succeed({
        delims: defaultAnchorDelims,
        primaryLanguage: undefined,
        packageRoot: undefined,
        workspaceRoot: undefined,
        corpusDir: undefined,
      }),
  }),
)

const layer = Layer.provide(
  Layer.merge(LoomCompiler.Default, LoomMemo.Default),
  Layer.merge(TestDocs, TestConfig),
)

describe('LoomCompiler — semantic tokens over the source', () => {
  it.effect('draws every colour the legend carries', () =>
    Effect.gen(function* () {
      const c = yield* LoomCompiler
      const tokens = yield* c.semanticTokens('/convert.loom')
      const types = new Set(tokens.map((token) => token.type))
      // heading → namespace, warp → variable, lang and specifier → keyword,
      // sink → string, arrow and tilde → operator
      expect([...types].sort()).toEqual([
        'keyword',
        'namespace',
        'operator',
        'string',
        'variable',
      ])
    }).pipe(Effect.provide(layer)),
  )

  it.effect('colours the arrow and the tilde as operators', () =>
    Effect.gen(function* () {
      const c = yield* LoomCompiler
      const tokens = yield* c.semanticTokens('/convert.loom')
      const operators = tokens.filter((token) => token.type === 'operator')
      // the => that opens the code block and the ~ that closes it
      expect(operators.length).toBe(2)
    }).pipe(Effect.provide(layer)),
  )
})
