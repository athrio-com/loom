import { describe, expect, it } from '@effect/vitest'
import { Effect, Layer, Option } from 'effect'
import { parseDocument, ParseLayer } from './parse'
import {
  profileOf,
  symbolsOf,
  SymbolKindSchema,
} from '@athrio/loom-ast/LoomSymbol'
import { symbolMappings } from '#ast/LoomVirtualCodeBuilder'
import { DocumentSource, LoomCompiler } from '../src/LoomCompiler'
import { LoomMemo } from '../src/LoomMemo'
import { PackageConfig } from '../src/PackageConfig'
import { defaultAnchorDelims } from '@athrio/loom-ast/LoomTokens'

// LoomSymbol.profileOf is the one table; three consumers read it, and this file guards
// that they cannot drift from it. The fixture exercises every kind symbolsOf emits: the
// {{ratio}} warp, two heading titles, a {TypeScript} specifier and a [., convert.ts]
// sink, a ::[ratio] warp anchor and a ::[Converting] section anchor, the => arrows and
// the ~ tilde.
const fixture = `---
Language: TypeScript
---

# Converting {TypeScript} [., convert.ts]

{{ratio = 1.8}}

=>

export const scale = ::[ratio]

~

# Doubling

=>

::[Converting]
export const twice = (n: number) => n * 2
`

const parse = (src: string) =>
  Effect.runSync(parseDocument(src).pipe(Effect.provide(ParseLayer)))

const files: Record<string, string> = { '/convert.loom': fixture }

const layer = Layer.provide(
  Layer.merge(LoomCompiler.Default, LoomMemo.Default),
  Layer.merge(
    Layer.succeed(
      DocumentSource,
      new DocumentSource({
        read: (path: string) => Effect.succeed(files[path] ?? ''),
        list: Option.some(() => Effect.succeed(Object.keys(files))),
      }),
    ),
    Layer.succeed(
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
    ),
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
      const c = yield* LoomCompiler
      const emitted = new Set(
        (yield* c.semanticTokens('/convert.loom')).map((t) => t.type),
      )
      expect(emitted).toEqual(fromTable)
    }).pipe(Effect.provide(layer)),
  )

  it.effect('a rename range appears only where the table marks a kind navigable', () =>
    Effect.gen(function* () {
      const c = yield* LoomCompiler
      // heading title — profileOf marks it navigable
      const atTitle = yield* c.renameRange('/convert.loom', fixture.indexOf('Converting'))
      expect(atTitle).not.toBeUndefined()
      // sink — profileOf grants it verification only, no navigation
      const atSink = yield* c.renameRange('/convert.loom', fixture.indexOf('convert.ts'))
      expect(atSink).toBeUndefined()
    }).pipe(Effect.provide(layer)),
  )
})
