import { describe, expect, it as it_ } from 'bun:test'
import { effectify } from '@athrio/effect-test'
import { Effect, Layer, Option } from 'effect'
import { defaultAnchorDelims } from '@athrio/loom-ast/LoomTokens'
import { profileOf, SymbolKindSchema, symbolsOf } from '@athrio/loom-ast/LoomSymbol'
import { symbolMappings } from '#ast/LoomVirtualCodeBuilder'
import { DocumentSource, LoomCompiler } from '../src/LoomCompiler'
import { LoomMemo } from '../src/LoomMemo'
import { LoomConfig } from '@athrio/loom-config/LoomConfig'
import { PackageConfig } from '../src/PackageConfig'
import { parseDocument, ParseLayer } from './parse'

const it = effectify(it_)

const lines = (...rows: ReadonlyArray<string>): string => `${rows.join('\n')}\n`

const anchor = (name: string): string => `::${'['}${name}]`

const fixture = lines(
  '---',
  'Language: TypeScript',
  '---',
  '',
  '# Converting {TypeScript} [., convert.ts]',
  '',
  '{{ratio = 1.8}}',
  '',
  '=>',
  '',
  `export const scale = ${anchor('ratio')}`,
  '',
  '~',
  '',
  '# Doubling',
  '',
  '=>',
  '',
  anchor('Converting'),
  'export const twice = (n: number) => n * 2',
)

const parse = (src: string) => Effect.runSync(parseDocument(src).pipe(Effect.provide(ParseLayer)))

const files: Record<string, string> = { '/convert.loom': fixture }

const layer = Layer.provide(
  Layer.merge(LoomCompiler.layer, LoomMemo.layer),
  Layer.mergeAll(
    LoomConfig.layer,
    Layer.succeed(DocumentSource, {
      read: (path: string) => Effect.succeed(files[path] ?? ''),
      list: Option.some(() => Effect.succeed(Object.keys(files))),
      hold: () => Effect.void,
      forget: () => Effect.void,
    }),
    Layer.succeed(PackageConfig, {
      resolve: () =>
        Effect.succeed({
          delims: defaultAnchorDelims,
          primaryLanguage: undefined,
          variables: {},
          width: 100,
          packageRoot: undefined,
        }),
    }),
  ),
)

describe('the capability table drives the editor', () => {
  it('profileOf covers every symbol kind', () => {
    const unprofiled = SymbolKindSchema.literals.filter(
      (kind) => typeof profileOf(kind).features !== 'object',
    )
    expect(unprofiled).toEqual([])
  })

  it('the mappings lay one span per symbol, carrying its kind', () => {
    const doc = parse(fixture)
    const symbols = symbolsOf(doc)
    const mappings = symbolMappings(doc)
    expect(mappings.map((m) => m.kind)).toEqual(symbols.map((s) => s.kind))
  })

  it.effect('the colours are exactly the colours the table assigns', () =>
    Effect.gen(function* () {
      const doc = parse(fixture)
      const fromTable = new Set(
        symbolsOf(doc).flatMap((s) => Option.toArray(profileOf(s.kind).semantic)),
      )
      const compiler = yield* LoomCompiler
      const emitted = new Set((yield* compiler.semanticTokens('/convert.loom')).map((t) => t.type))
      expect(emitted).toEqual(fromTable)
    }).pipe(Effect.provide(layer)),
  )

  it.effect('a rename range appears only where the table marks a kind navigable', () =>
    Effect.gen(function* () {
      const compiler = yield* LoomCompiler
      const atTitle = yield* compiler.renameRange('/convert.loom', fixture.indexOf('Converting'))
      expect(atTitle).not.toBeUndefined()
      const atSink = yield* compiler.renameRange('/convert.loom', fixture.indexOf('convert.ts'))
      expect(atSink).toBeUndefined()
    }).pipe(Effect.provide(layer)),
  )
})
