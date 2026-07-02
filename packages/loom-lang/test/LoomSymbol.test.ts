import { describe, expect, it } from '@effect/vitest'
import { Effect, Option } from 'effect'
import { parseDocument, ParseLayer } from './parse'
import { profileOf, symbolAt, symbolsOf } from '@athrio/loom-ast/LoomSymbol'

// The declarative table drives colour and editor features per token kind, and the
// classification pass reads every symbol a document declares. `::[ratio]` names a
// warp the section declares, so it is a warpAnchor; `::[Other]` names no warp, so it
// is a sectionAnchor. The lang warp, heading title, specifier, sink, warp def, and
// the code delimiters each classify on their own.
const source = `---
Language: TypeScript
---

# Converting {TypeScript} [., convert.ts]

{{ratio = 1.8}}

The forward direction.

=>

export const x = ::[ratio] + ::[Other]

~

More prose.
`

describe('LoomSymbol — the capability table', () => {
  it('profileOf gives each kind its colour and its editor features', () => {
    expect(Option.getOrNull(profileOf('arrow').semantic)).toBe('operator')
    expect(profileOf('arrow').features).toEqual({})
    expect(Option.getOrNull(profileOf('warpAnchor').semantic)).toBe('variable')
    expect(profileOf('warpAnchor').features.navigation).toBe(true)
    expect(Option.getOrNull(profileOf('sink').semantic)).toBe('string')
    // prose folds and outlines but is not a navigation target
    expect(profileOf('prose').features.structure).toBe(true)
    expect(profileOf('prose').features.navigation).toBeUndefined()
  })

  it.effect('symbolsOf classifies every token a document declares', () =>
    Effect.gen(function* () {
      const doc = yield* parseDocument(source)
      const kinds = new Set<string>(symbolsOf(doc).map((symbol) => symbol.kind))
      const expected = [
        'headingTitle',
        'specifier',
        'sink',
        'warpDef',
        'warpAnchor',
        'sectionAnchor',
        'arrow',
        'tilde',
      ]
      expect(expected.filter((kind) => !kinds.has(kind))).toEqual([])
    }).pipe(Effect.provide(ParseLayer)),
  )

  it.effect('symbolAt reads the kind under a cursor', () =>
    Effect.gen(function* () {
      const doc = yield* parseDocument(source)
      const inWarpAnchor = source.indexOf('::[ratio]') + 4 // inside "ratio"
      const inSectionAnchor = source.indexOf('::[Other]') + 4 // inside "Other"
      expect(
        Option.getOrNull(symbolAt(doc, inWarpAnchor))?.kind,
      ).toBe('warpAnchor')
      expect(
        Option.getOrNull(symbolAt(doc, inSectionAnchor))?.kind,
      ).toBe('sectionAnchor')
    }).pipe(Effect.provide(ParseLayer)),
  )
})
