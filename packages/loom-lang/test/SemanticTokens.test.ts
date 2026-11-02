import { describe, expect, it as it_ } from 'bun:test'
import { effectify } from '@athrio/effect-test'
import { Effect, Layer, Option } from 'effect'
import { DocumentSource, LoomCompiler } from '../src/LoomCompiler'
import { LoomMemo } from '../src/LoomMemo'
import { PackageConfig } from '../src/PackageConfig'
import { defaultAnchorDelims } from '@athrio/loom-ast/LoomTokens'

const it = effectify(it_)

const lines = (...rows: ReadonlyArray<string>): string => `${rows.join('\n')}\n`

const anchor = (name: string): string => `::${'['}${name}]`

const doc = lines(
  '---',
  'Language: TypeScript',
  '---',
  '',
  '# Converting {TypeScript} [., convert.ts]',
  '',
  '{{ratio = 1.8}}',
  '',
  'The forward direction.',
  '',
  '=>',
  '',
  `export const scale = ${anchor('ratio')}`,
  '',
  '~',
  '',
  'The reverse direction.',
)

const files: Record<string, string> = { '/convert.loom': doc }

const TestDocs = Layer.succeed(DocumentSource, {
  read: (path: string) => Effect.succeed(files[path] ?? ''),
  list: Option.some(() => Effect.succeed(Object.keys(files))),
  hold: () => Effect.void,
})

const TestConfig = Layer.succeed(PackageConfig, {
  resolve: () =>
    Effect.succeed({
      delims: defaultAnchorDelims,
      primaryLanguage: undefined,
      variables: {},
      width: 100,
      packageRoot: undefined,
      workspaceRoot: undefined,
      corpusDir: undefined,
    }),
})

const layer = Layer.provide(
  Layer.merge(LoomCompiler.layer, LoomMemo.layer),
  Layer.merge(TestDocs, TestConfig),
)

describe('LoomCompiler — semantic tokens over the source', () => {
  it.effect('draws every colour the legend carries', () =>
    Effect.gen(function* () {
      const c = yield* LoomCompiler
      const tokens = yield* c.semanticTokens('/convert.loom')
      const types = new Set(tokens.map((token) => token.type))
      expect([...types].sort()).toEqual(['keyword', 'namespace', 'operator', 'string', 'variable'])
    }).pipe(Effect.provide(layer)),
  )

  it.effect('colours the arrow and the tilde as operators', () =>
    Effect.gen(function* () {
      const c = yield* LoomCompiler
      const tokens = yield* c.semanticTokens('/convert.loom')
      const operators = tokens.filter((token) => token.type === 'operator')
      expect(operators.length).toBe(2)
    }).pipe(Effect.provide(layer)),
  )
})
