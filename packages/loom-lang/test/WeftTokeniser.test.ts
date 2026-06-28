import { describe, expect, it } from '@effect/vitest'
import { Chunk, Effect, Stream } from 'effect'
import type { LineRange } from '#ast/LineRanges'
import { okHealth } from '@athrio/loom-ast/LoomNode'
import { WeftClassifier } from '#ast/WeftClassifier'
import { WeftTokeniser } from '#ast/WeftTokeniser'
import type { ArrowWeft, HeadingWeft, LoomWeft } from '@athrio/loom-ast/Weft'

// =============================================================================
// Harness — drive lines through Classifier → Tokeniser and collect the
// emitted wefts. Both stages run; the tests assert on the post-Tokeniser
// output, which is what consumers downstream of the Tokeniser see.
// =============================================================================

const tokenise = (lines: ReadonlyArray<string>): ReadonlyArray<LoomWeft> => {
  const text = lines.join('\n')
  const ranges: LineRange[] = []
  let offset = 0
  for (const line of lines) {
    ranges.push([offset, offset + line.length] as const)
    offset += line.length + 1
  }
  return Effect.runSync(
    Effect.gen(function* () {
      const classifier = yield* WeftClassifier
      const tokeniser = yield* WeftTokeniser
      const source = Stream.fromIterable(ranges)
      const classified = classifier.classifyWefts(text)(source)
      const stream = tokeniser.tokeniseWefts(text)(classified)
      const chunk = yield* Stream.runCollect(stream)
      return Chunk.toReadonlyArray(chunk)
    }).pipe(
      Effect.provide(WeftClassifier.Default),
      Effect.provide(WeftTokeniser.Default),
    ),
  )
}

const headingAt = (out: ReadonlyArray<LoomWeft>, idx: number): HeadingWeft => {
  const w = out[idx]
  if (w.type !== 'HeadingWeft') {
    throw new Error(`expected a HeadingWeft at index ${idx}, got ${w.type}`)
  }
  return w
}

// =============================================================================
// Scanning + construction — happy paths. Tag and Specifier tokens are built
// from anchor matches, their subnodes carry real source positions and ok
// health, label values are extracted from the source slice.
// =============================================================================

describe('Tokeniser — scanning + construction (happy paths)', () => {
  it("fills a tag's open/label/close subnodes from a `[Foo]` source", () => {
    const w = headingAt(tokenise(['## Section [Foo]']), 0)
    expect(w.tag?.open.value).toBe('[')
    expect(w.tag?.label.value).toBe('Foo')
    expect(w.tag?.close.value).toBe(']')
    expect(w.tag?.open.health).toEqual(okHealth)
    expect(w.tag?.label.health).toEqual(okHealth)
    expect(w.tag?.close.health).toEqual(okHealth)
  })

  it('places tag subnode positions at real source offsets', () => {
    // "## Section [Foo]" — `[` at index 11, `]` at index 15.
    const w = headingAt(tokenise(['## Section [Foo]']), 0)
    expect(w.tag?.open.position.start.offset).toBe(11)
    expect(w.tag?.open.position.end.offset).toBe(12)
    expect(w.tag?.close.position.start.offset).toBe(15)
    expect(w.tag?.close.position.end.offset).toBe(16)
    expect(w.tag?.label.position.start.offset).toBe(12)
    expect(w.tag?.label.position.end.offset).toBe(15)
  })

  it("fills a specifier's open/label/close subnodes from a `{Lang}` source", () => {
    const w = headingAt(tokenise(['# Title [App]{TypeScript}']), 0)
    expect(w.specifier?.open.value).toBe('{')
    expect(w.specifier?.label.value).toBe('TypeScript')
    expect(w.specifier?.close.value).toBe('}')
    expect(w.specifier?.open.health).toEqual(okHealth)
    expect(w.specifier?.label.health).toEqual(okHealth)
    expect(w.specifier?.close.health).toEqual(okHealth)
  })

  it('aggregates tag/specifier subnode health into the weft', () => {
    expect(tokenise(['# Title [App]{TypeScript}'])[0].health.status).toBe('ok')
  })
})

// =============================================================================
// Faults — a broken label keeps its token but carries the catalog's wording,
// never the internal schema invariant. `[]` is the empty-tag case the editor
// once surfaced as `empty value requires non-ok health.status`.
// =============================================================================

describe('Tokeniser — label faults read from the catalog', () => {
  it('an empty tag label reads "cannot be empty", not the model invariant', () => {
    const w = headingAt(tokenise(['## Section []']), 0)
    expect(w.tag?.label.value).toBe('')
    expect(w.tag?.label.health.status).toBe('error')
    expect(w.tag?.label.health.diagnostics[0]?.message).toBe(
      'Tag label cannot be empty.',
    )
    expect(w.tag?.label.health.diagnostics[0]?.message).not.toMatch(
      /non-ok|health\.status/,
    )
  })

  it('a malformed tag label names the rule it broke', () => {
    const w = headingAt(tokenise(['## Section [a b]']), 0)
    expect(w.tag?.label.health.status).toBe('error')
    expect(w.tag?.label.health.diagnostics[0]?.message).toBe(
      'Tag label may contain only letters, digits, hyphen, and underscore; got `a b`.',
    )
  })
})

// =============================================================================
// Heading — one weft kind for every `#{1,6}` line. Tag and specifier are both
// optional. A tagless heading receives a HASH-SYNTHESISED tag (ok health) — a
// private section, not an error — so every Section has a stable identifier.
// =============================================================================

describe('Tokeniser — Heading tag/specifier filling', () => {
  it('fills the tag and specifier when the source provides them', () => {
    const w = headingAt(tokenise(['# Title [App]{TypeScript}']), 0)
    expect(w.tag?.label.value).toBe('App')
    expect(w.specifier?.label.value).toBe('TypeScript')
    expect(w.tag?.health.status).toBe('ok')
    expect(w.specifier?.health.status).toBe('ok')
  })

  it('a tag only → real tag, specifier undefined, weft ok', () => {
    const w = headingAt(tokenise(['# Title [App]']), 0)
    expect(w.tag?.label.value).toBe('App')
    expect(w.tag?.health.status).toBe('ok')
    expect(w.specifier).toBeUndefined()
    expect(w.health.status).toBe('ok')
  })

  it('no tag → a tag named after the title, ok health, not an error', () => {
    const w = headingAt(tokenise(['# Title']), 0)
    expect(w.tag).toBeDefined()
    expect(w.tag?.health.status).toBe('ok')
    expect(w.tag?.label.value).toBe('Title')
    expect(w.health.status).toBe('ok')
  })

  it('places the synthetic name tag at a zero-width EOL position', () => {
    const w = headingAt(tokenise(['# Title']), 0)
    expect(w.tag?.position.start.offset).toBe(w.position.end.offset)
    expect(w.tag?.position.end.offset).toBe(w.position.end.offset)
  })

  it('the name is the title normalised to an identifier (distinct titles → distinct names)', () => {
    const a = headingAt(tokenise(['# Alpha one']), 0)
    const b = headingAt(tokenise(['# Beta two']), 0)
    expect(a.tag?.label.value).toBe('AlphaOne')
    expect(b.tag?.label.value).toBe('BetaTwo')
    expect(a.tag?.label.value).not.toBe(b.tag?.label.value)
  })

  it('identical heading text yields the same name', () => {
    const a = headingAt(tokenise(['# Glossary']), 0)
    const b = headingAt(tokenise(['# Glossary']), 0)
    expect(a.tag?.label.value).toBe(b.tag?.label.value)
  })

  it('every level (1–6) tokenises as a HeadingWeft, never incomplete', () => {
    for (const line of ['# One', '## Two', '###### Six']) {
      const out = tokenise([line])
      expect(out[0].type).toBe('HeadingWeft')
      expect(out[0].health.status).not.toBe('incomplete')
    }
  })

  it('post-Tokeniser Heading is never `incomplete` across presence/absence', () => {
    for (const line of [
      '# Title',
      '# Title [App]',
      '# Title {TS}',
      '# Title [App]{TS}',
    ]) {
      expect(tokenise([line])[0].health.status).not.toBe('incomplete')
    }
  })
})

// =============================================================================
// Specifier kind — label vs path vs directory. A label without path separators
// (`{Bash}`) builds a `Specifier`; a label carrying `.` or `/` (`{src/x.ts}`)
// builds a `PathSpecifier`, the tangle (file-emission) sink; a label closed by a
// trailing slash (`{pkg/}`) builds a `DirSpecifier`, the higher-order sink.
// =============================================================================

describe('Tokeniser — label vs path specifier', () => {
  it('`{Bash}` is a label Specifier', () => {
    const w = headingAt(tokenise(['# Build [B]{Bash}']), 0)
    expect(w.specifier?.type).toBe('Specifier')
    expect(w.specifier?.label.value).toBe('Bash')
  })

  it('`{Loom}` is a label Specifier (no path separators)', () => {
    const w = headingAt(tokenise(['# Deps {Loom}']), 0)
    expect(w.specifier?.type).toBe('Specifier')
    expect(w.specifier?.label.value).toBe('Loom')
  })

  it('`{src/main/scala/App.scala}` is a PathSpecifier (slashes present)', () => {
    const w = headingAt(tokenise(['# Tangle {src/main/scala/App.scala}']), 0)
    expect(w.specifier?.type).toBe('PathSpecifier')
    expect(w.specifier?.label.value).toBe('src/main/scala/App.scala')
    expect(w.specifier?.health.status).toBe('ok')
  })

  it('`{build.sh}` is a PathSpecifier (dot present)', () => {
    const w = headingAt(tokenise(['# Tangle {build.sh}']), 0)
    expect(w.specifier?.type).toBe('PathSpecifier')
    expect(w.specifier?.label.value).toBe('build.sh')
  })

  it('`{packages/loom-cli/}` is a DirSpecifier (trailing slash)', () => {
    const w = headingAt(tokenise(['# CLI {packages/loom-cli/}']), 0)
    expect(w.specifier?.type).toBe('DirSpecifier')
    expect(w.specifier?.label.value).toBe('packages/loom-cli/')
    expect(w.specifier?.health.status).toBe('ok')
  })

  it('`{lib/}` is a DirSpecifier (single segment, trailing slash)', () => {
    const w = headingAt(tokenise(['# Group {lib/}']), 0)
    expect(w.specifier?.type).toBe('DirSpecifier')
    expect(w.specifier?.label.value).toBe('lib/')
  })

  it('a trailing slash wins over the path reading (`{src/main.ts}` stays a file)', () => {
    const w = headingAt(tokenise(['# File {src/main.ts}']), 0)
    expect(w.specifier?.type).toBe('PathSpecifier')
  })

  it('a path specifier with a space fails its pattern (bad text in unexpected)', () => {
    const w = headingAt(tokenise(['# Tangle {src/bad name.ts}']), 0)
    expect(w.specifier?.type).toBe('PathSpecifier')
    expect(w.specifier?.label.health.status).toBe('error')
    expect(w.specifier?.label.value).toBe('')
    expect(w.specifier?.label.unexpected?.[0].value).toBe('src/bad name.ts')
  })
})

// =============================================================================
// Multi-tag / multi-specifier — extras land on `weft.unexpected[]` and the
// weft's aggregated health flips to error.
// =============================================================================

describe('Tokeniser — multi-tag / multi-specifier', () => {
  it('multi-tag heading captures extras as UnexpectedToken on the weft', () => {
    const w = headingAt(tokenise(['## Multi [D] [T]']), 0)
    expect(w.unexpected).toBeDefined()
    expect(w.unexpected!.length).toBeGreaterThan(0)
  })

  it("first tag still becomes the weft's `tag`; extras go to unexpected", () => {
    const w = headingAt(tokenise(['## Multi [First] [Second]']), 0)
    expect(w.tag?.label.value).toBe('First')
    expect(w.unexpected?.length).toBeGreaterThan(0)
  })

  it('unexpected entries flip weft health to error via aggregation', () => {
    expect(tokenise(['## Multi [D] [T]'])[0].health.status).toBe('error')
  })

  it('multi-specifier captures extras as UnexpectedToken', () => {
    const w = headingAt(tokenise(['# Title [App]{One}{Two}']), 0)
    expect(w.unexpected).toBeDefined()
    expect(w.unexpected!.length).toBeGreaterThan(0)
    expect(w.health.status).toBe('error')
  })
})

// =============================================================================
// Synthetic close — `[` without a matching `]` on the same line. The
// resulting Tag still has structure (open + label + synthetic close at EOL),
// but `close.health.status === "error"` with a "missing `]`" diagnostic, and
// the parent Tag's aggregated health follows.
// =============================================================================

describe('Tokeniser — synthetic close (unclosed bracket)', () => {
  it('unclosed `[` produces a Tag with synthetic close at EOL', () => {
    const w = headingAt(tokenise(['## Section [Foo']), 0)
    // line `## Section [Foo` is 15 chars long; close should be at 15..15.
    expect(w.tag?.close.position.start.offset).toBe(15)
    expect(w.tag?.close.position.end.offset).toBe(15)
  })

  it("synthetic close carries error health with a 'missing `]`' diagnostic", () => {
    const w = headingAt(tokenise(['## Section [Foo']), 0)
    expect(w.tag?.close.health.status).toBe('error')
    expect(w.tag?.close.health.diagnostics[0].message).toMatch(
      /expected closing/i,
    )
  })

  it('Tag with synthetic close has its own health aggregated to error', () => {
    const w = headingAt(tokenise(['## Section [Foo']), 0)
    expect(w.tag?.health.status).toBe('error')
  })

  it('unclosed `{` produces a Specifier with synthetic close + error health', () => {
    const w = headingAt(tokenise(['# Title [App]{Lang']), 0)
    expect(w.specifier?.close.health.status).toBe('error')
    expect(w.specifier?.close.health.diagnostics[0].message).toMatch(
      /expected closing/i,
    )
  })
})

// =============================================================================
// Label validation — malformed label values are kept in the AST via the
// synthetic-empty + UnexpectedToken mechanism. The schema's cross-field
// filter admits empty `value` only when health is NOK.
// =============================================================================

describe('Tokeniser — malformed label values', () => {
  it('label with a space gets error health, value `""`, and bad text in unexpected', () => {
    const w = headingAt(tokenise(['## Section [has space]']), 0)
    expect(w.tag?.label.health.status).toBe('error')
    expect(w.tag?.label.value).toBe('')
    expect(w.tag?.label.unexpected?.[0].value).toBe('has space')
  })

  it('tag label with a dot fails the pattern and lands in unexpected', () => {
    // `.` is a path separator, but the TAG label class never admits it.
    const w = headingAt(tokenise(['## Section [foo.bar]']), 0)
    expect(w.tag?.label.health.status).toBe('error')
    expect(w.tag?.label.unexpected?.[0].value).toBe('foo.bar')
  })

  it('malformed label propagates error to the Tag and to the weft', () => {
    const w = headingAt(tokenise(['## Section [bad space]']), 0)
    expect(w.tag?.health.status).toBe('error')
    expect(w.health.status).toBe('error')
  })

  it('malformed label Specifier routes the bad text to unexpected', () => {
    const w = headingAt(tokenise(['# Title [App]{bad lang}']), 0)
    expect(w.specifier?.type).toBe('Specifier')
    expect(w.specifier?.label.health.status).toBe('error')
    expect(w.specifier?.label.value).toBe('')
    expect(w.specifier?.label.unexpected?.[0].value).toBe('bad lang')
  })
})

// =============================================================================
// Heading title — the single trimmed title token: the text between the
// marker and the first structural token, whitespace stripped. Text after a
// structural token is dropped; a heading that opens straight into a tag has
// no title.
// =============================================================================

describe('Tokeniser — heading title', () => {
  it('captures the title before the tag, trimmed of the trailing space', () => {
    const w = headingAt(tokenise(['## Title here [Tag]']), 0)
    // Marker `## ` ends at offset 3; tag opens at 14. The raw gap [3..14)
    // is "Title here " — the trailing space is trimmed off, so [3..13).
    expect(w.title?.source).toBe('Title here')
    expect(w.title?.position.start.offset).toBe(3)
    expect(w.title?.position.end.offset).toBe(13)
  })

  it('ends the title at the first structural token', () => {
    const w = headingAt(tokenise(['# Title [App]{TypeScript}']), 0)
    // `# ` ends at offset 2; tag is at 8..13. Title is [2..7) = "Title".
    expect(w.title?.source).toBe('Title')
    expect(w.title?.position.start.offset).toBe(2)
    expect(w.title?.position.end.offset).toBe(7)
  })

  it('has no title when the heading is only the marker and a tag', () => {
    const w = headingAt(tokenise(['## [Tag]']), 0)
    expect(w.title).toBeUndefined()
  })
})

// =============================================================================
// Weft-kind pass-through — every classifier-stage weft kind survives the
// Tokeniser with its kind intact. There is no default `Weft` kind: a line
// before the first heading is a Document-Preamble PreambleWeft.
// =============================================================================

describe('Tokeniser — weft kinds preserved', () => {
  it('PreambleWeft, HeadingWeft, ArrowWeft, CodeWeft, TildeWeft, ProseWeft survive their kind', () => {
    const out = tokenise([
      'pre-heading line', // PreambleWeft (Document Preamble)
      '# Title [App]{TS}', // HeadingWeft (tokenised)
      'intro', // PreambleWeft (section preamble)
      '=>', // ArrowWeft
      'x = 1', // CodeWeft
      '~', // TildeWeft
      'prose', // ProseWeft
    ])
    expect(out.map((w) => w.type)).toEqual([
      'PreambleWeft',
      'HeadingWeft',
      'PreambleWeft',
      'ArrowWeft',
      'CodeWeft',
      'TildeWeft',
      'ProseWeft',
    ])
  })
})

// =============================================================================
// Body weft tokenisation — Arrow / Tilde fill optional inline subtokens
// (code / prose) from the source; Preamble / Prose flip health to ok
// (structural-final at this stage). Post-Tokeniser, no body weft should
// remain `incomplete`.
// =============================================================================

describe('Tokeniser — body weft subtoken expansion', () => {
  it('ArrowWeft with inline code fills the `code` subtoken at the right position', () => {
    const out = tokenise(['## A', '=> let x = 1'])
    const w = out[1]
    if (w.type !== 'ArrowWeft') throw new Error('expected ArrowWeft')
    expect(w.code).toBeDefined()
    expect(w.code!.health.status).toBe('ok')
    // Line "=> let x = 1" starts at offset 5 (after "## A\n"); the code
    // segment "let x = 1" starts at offset 5 + 3 = 8.
    expect(w.code!.position.start.offset).toBe(8)
    expect(w.code!.position.end.offset).toBe(17)
  })

  it('ArrowWeft without inline code leaves `code` undefined', () => {
    const out = tokenise(['## A', '=>'])
    const w = out[1]
    if (w.type !== 'ArrowWeft') throw new Error('expected ArrowWeft')
    expect(w.code).toBeUndefined()
  })

  it('TildeWeft with inline prose fills the `prose` subtoken', () => {
    const out = tokenise(['## A', '~ a note'])
    const w = out[1]
    if (w.type !== 'TildeWeft') throw new Error('expected TildeWeft')
    expect(w.prose).toBeDefined()
    expect(w.prose!.health.status).toBe('ok')
  })

  it('TildeWeft without inline prose leaves `prose` undefined', () => {
    const out = tokenise(['## A', '~'])
    const w = out[1]
    if (w.type !== 'TildeWeft') throw new Error('expected TildeWeft')
    expect(w.prose).toBeUndefined()
  })

  it('post-Tokeniser ArrowWeft health is ok', () => {
    expect(tokenise(['## A', '=>'])[1].health.status).toBe('ok')
    expect(tokenise(['## A', '=> let x = 1'])[1].health.status).toBe('ok')
  })

  it('post-Tokeniser TildeWeft health is ok', () => {
    expect(tokenise(['## A', '~'])[1].health.status).toBe('ok')
    expect(tokenise(['## A', '~ note'])[1].health.status).toBe('ok')
  })

  it('post-Tokeniser PreambleWeft health flips from incomplete to ok', () => {
    const out = tokenise(['## A', 'preamble line'])
    expect(out[1].type).toBe('PreambleWeft')
    expect(out[1].health.status).toBe('ok')
  })

  it('post-Tokeniser ProseWeft health flips from incomplete to ok', () => {
    const out = tokenise(['## A', '~', 'prose line'])
    expect(out[2].type).toBe('ProseWeft')
    expect(out[2].health.status).toBe('ok')
  })

  it('post-Tokeniser body wefts are never `incomplete`', () => {
    const out = tokenise([
      '# Title [App]{TS}',
      'intro preamble',
      '=>',
      'x = 1',
      '=> let y',
      '~',
      'trailing prose',
      '~~~ note',
    ])
    for (const w of out) {
      expect(w.health.status).not.toBe('incomplete')
    }
  })
})

// =============================================================================
// Warp tokenisation — PreambleWeft hosts `{{name: annotation [= default]}}`
// declarations; ArrowWeft and CodeWeft host `::[name]` references.
// =============================================================================

describe('Tokeniser — Warp declarations on PreambleWeft', () => {
  const preambleWeft = (line: string) => {
    const out = tokenise(['## A', line])
    const w = out[1]
    if (w.type !== 'PreambleWeft')
      throw new Error(`expected PreambleWeft, got ${w.type}`)
    return w
  }

  it('recognises a service warp `{{name = Service}}`', () => {
    const w = preambleWeft('Uses {{mul = Mul}} to multiply.')
    expect(w.warps).toHaveLength(1)
    expect(w.warps[0].name.value).toBe('mul')
    expect(w.warps[0].annotation).toBeUndefined()
    expect(w.warps[0].default?.value).toBe('Mul')
    expect(w.warps[0].health.status).toBe('ok')
  })

  it('recognises a value warp with a type, `{{name: type = value}}`', () => {
    const w = preambleWeft(`Port {{port: string = "8080"}}.`)
    expect(w.warps[0].name.value).toBe('port')
    expect(w.warps[0].annotation?.value).toBe('string')
    expect(w.warps[0].default?.value).toBe(`"8080"`)
    expect(w.warps[0].health.status).toBe('ok')
  })

  it('recognises a value warp with no type, `{{name = value}}`', () => {
    const w = preambleWeft('{{greeting = "hi"}}')
    expect(w.warps[0].name.value).toBe('greeting')
    expect(w.warps[0].annotation).toBeUndefined()
    expect(w.warps[0].default?.value).toBe('"hi"')
    expect(w.warps[0].health.status).toBe('ok')
  })

  it('recognises multiple warps on one line', () => {
    const w = preambleWeft('first {{a = A}} then {{b = B}}.')
    expect(w.warps).toHaveLength(2)
    expect(w.warps[0].name.value).toBe('a')
    expect(w.warps[1].name.value).toBe('b')
  })

  it('exempts the `{{lang: …}}` directive from the value requirement', () => {
    const w = preambleWeft('{{lang: TypeScript}}')
    expect(w.warps[0].name.value).toBe('lang')
    expect(w.warps[0].annotation?.value).toBe('TypeScript')
    expect(w.warps[0].default).toBeUndefined()
    expect(w.warps[0].health.status).toBe('ok')
  })

  it('preserves nested commas inside `<>` brackets in the type', () => {
    const w = preambleWeft('hold {{r: Record<string, number> = rec}}.')
    expect(w.warps[0].annotation?.value).toBe('Record<string, number>')
    expect(w.warps[0].default?.value).toBe('rec')
  })

  it('top-level `,` in the value surfaces as warp.unexpected[]', () => {
    const w = preambleWeft('multi {{a = B, }}.')
    expect(w.warps[0].default?.value).toBe('B')
    expect(w.warps[0].unexpected).toBeDefined()
    expect(w.warps[0].unexpected![0].value).toBe(', ')
    expect(w.warps[0].health.status).toBe('error')
  })

  it('a warp with no value is a missing-value error', () => {
    const w = preambleWeft('bad {{onlyName}}')
    expect(w.warps[0].name.value).toBe('onlyName')
    expect(w.warps[0].annotation).toBeUndefined()
    expect(w.warps[0].default).toBeUndefined()
    expect(w.warps[0].health.status).toBe('error')
    expect(w.warps[0].health.diagnostics[0].message).toMatch(/has no value/)
  })

  it('a typed warp with no value is also a missing-value error', () => {
    const w = preambleWeft('{{p: string}}')
    expect(w.warps[0].name.value).toBe('p')
    expect(w.warps[0].annotation?.value).toBe('string')
    expect(w.warps[0].default).toBeUndefined()
    expect(w.warps[0].health.status).toBe('error')
    expect(w.warps[0].health.diagnostics[0].message).toMatch(/has no value/)
  })

  it('empty type after `:` is error-health', () => {
    const w = preambleWeft('{{a: = x}}')
    expect(w.warps[0].annotation?.value).toBe('')
    expect(w.warps[0].annotation?.health.status).toBe('error')
    expect(w.warps[0].default?.value).toBe('x')
  })

  it('empty value after `=` is error-health (preserves the `=` evidence)', () => {
    const w = preambleWeft('{{a = }}')
    expect(w.warps[0].default).toBeDefined()
    expect(w.warps[0].default!.value).toBe('')
    expect(w.warps[0].default!.health.status).toBe('error')
  })

  it('invalid name routes the bad text to name.unexpected[]', () => {
    const w = preambleWeft('{{not-an-id = Tag}}')
    expect(w.warps[0].name.value).toBe('')
    expect(w.warps[0].name.health.status).toBe('error')
    expect(w.warps[0].name.unexpected?.[0].value).toBe('not-an-id')
  })

  it('unclosed `{{` produces a synthetic `}}` at EOL with error health', () => {
    const w = preambleWeft('{{a = B')
    expect(w.warps[0].close.health.status).toBe('error')
    expect(w.warps[0].close.health.diagnostics[0].message).toMatch(
      /expected closing/i,
    )
  })

  it('stray `}}` becomes weft.unexpected[]', () => {
    const w = preambleWeft('loose }} pair')
    expect(w.warps).toHaveLength(0)
    expect(w.unexpected).toBeDefined()
    expect(w.unexpected![0].value).toBe('}}')
    expect(w.health.status).toBe('error')
  })

  it('post-Tokeniser PreambleWeft is never `incomplete`', () => {
    expect(preambleWeft('plain text').health.status).not.toBe('incomplete')
    expect(preambleWeft('{{a = B}}').health.status).not.toBe('incomplete')
    expect(preambleWeft('{{bad').health.status).not.toBe('incomplete')
  })
})

describe('Tokeniser — WarpAnchor references on ArrowWeft / CodeWeft', () => {
  const codeWeftFromLines = (lines: ReadonlyArray<string>, idx: number) => {
    const out = tokenise(lines)
    const w = out[idx]
    if (w.type !== 'CodeWeft')
      throw new Error(`expected CodeWeft, got ${w.type}`)
    return w
  }

  const arrowWeftFromLine = (line: string) => {
    const out = tokenise(['## A', line])
    const w = out[1]
    if (w.type !== 'ArrowWeft')
      throw new Error(`expected ArrowWeft, got ${w.type}`)
    return w
  }

  it('CodeWeft recognises a single anchor `::[name]`', () => {
    const w = codeWeftFromLines(['## A', '=>', 'use ::[mul] here'], 2)
    expect(w.anchors).toHaveLength(1)
    expect(w.anchors[0].name.value).toBe('mul')
    expect(w.anchors[0].health.status).toBe('ok')
  })

  it('CodeWeft recognises multiple anchors on one line', () => {
    const w = codeWeftFromLines(['## A', '=>', '::[a] + ::[b]'], 2)
    expect(w.anchors).toHaveLength(2)
    expect(w.anchors.map((a) => a.name.value)).toEqual(['a', 'b'])
  })

  it('recognises a multi-word heading-name anchor `::[Multiplier Function]`', () => {
    const w = codeWeftFromLines(['## A', '=>', '::[Multiplier Function]'], 2)
    expect(w.anchors).toHaveLength(1)
    expect(w.anchors[0].name.value).toBe('Multiplier Function')
    expect(w.anchors[0].health.status).toBe('ok')
  })

  it("ArrowWeft recognises an anchor inline with the arrow's code", () => {
    const w = arrowWeftFromLine('=> ::[x]')
    expect(w.anchors).toHaveLength(1)
    expect(w.anchors[0].name.value).toBe('x')
  })

  it('a warp-shaped run in code is left literal, not an anchor', () => {
    const w = codeWeftFromLines(['## A', '=>', '{{mul = Mul}}'], 2)
    expect(w.anchors).toHaveLength(0)
    expect(w.unexpected).toBeUndefined()
    expect(w.health.status).toBe('ok')
    expect(w.source).toContain('{{mul = Mul}}')
  })

  it('anchor with whitespace around the name is ok', () => {
    const w = codeWeftFromLines(['## A', '=>', '::[ name ]'], 2)
    expect(w.anchors[0].name.value).toBe('name')
    expect(w.anchors[0].health.status).toBe('ok')
  })

  it('unclosed `{{` in code is left literal, not an anchor', () => {
    const w = codeWeftFromLines(['## A', '=>', '{{x'], 2)
    expect(w.anchors).toHaveLength(0)
    expect(w.health.status).toBe('ok')
    expect(w.source).toContain('{{x')
  })

  it('post-Tokeniser CodeWeft is never `incomplete`', () => {
    expect(
      codeWeftFromLines(['## A', '=>', 'plain code'], 2).health.status,
    ).not.toBe('incomplete')
    expect(
      codeWeftFromLines(['## A', '=>', '::[a]'], 2).health.status,
    ).not.toBe('incomplete')
  })

  it('an anchor with no trailing `{…}` has no specifier', () => {
    const w = codeWeftFromLines(['## A', '=>', '::[mul]'], 2)
    expect(w.anchors[0].specifier).toBeUndefined()
  })

  it('attaches a directory specifier `::[A cli module]{packages/loom-cli/}`', () => {
    const w = codeWeftFromLines(['## A', '=>', '::[A cli module]{packages/loom-cli/}'], 2)
    expect(w.anchors).toHaveLength(1)
    expect(w.anchors[0].name.value).toBe('A cli module')
    expect(w.anchors[0].specifier?.type).toBe('DirSpecifier')
    expect(w.anchors[0].specifier?.label.value).toBe('packages/loom-cli/')
    expect(w.anchors[0].health.status).toBe('ok')
    expect(w.anchors[0].source).toBe('::[A cli module]{packages/loom-cli/}')
  })

  it('attaches a file specifier `::[The manifest]{package.json}`', () => {
    const w = codeWeftFromLines(['## A', '=>', '::[The manifest]{package.json}'], 2)
    expect(w.anchors[0].specifier?.type).toBe('PathSpecifier')
    expect(w.anchors[0].specifier?.label.value).toBe('package.json')
  })

  it('attaches a label specifier `::[base]{rust}`', () => {
    const w = codeWeftFromLines(['## A', '=>', '::[base]{rust}'], 2)
    expect(w.anchors[0].specifier?.type).toBe('Specifier')
    expect(w.anchors[0].specifier?.label.value).toBe('rust')
  })

  it('a `{` not adjacent to the close is not a specifier', () => {
    const w = codeWeftFromLines(['## A', '=>', '::[x] {y}'], 2)
    expect(w.anchors[0].specifier).toBeUndefined()
  })

  it('a `{` with no `}` after the close stays product code', () => {
    const w = codeWeftFromLines(['## A', '=>', '::[base]{ override'], 2)
    expect(w.anchors[0].specifier).toBeUndefined()
    expect(w.anchors[0].health.status).toBe('ok')
  })
})

// =============================================================================
// `{Loom}` sections — same grammar as any other Section. The `{Loom}`
// Specifier is just a label token; there is no special body weft re-typing.
// =============================================================================

describe('Tokeniser — `{Loom}` sections behave like any other Section', () => {
  it('`## Deps {Loom}` admits Preamble + Arrow + Code wefts in its body', () => {
    const out = tokenise(['## Deps {Loom}', 'Some preamble.', '=>', 'needs(X)'])
    expect(out.map((w) => w.type)).toEqual([
      'HeadingWeft',
      'PreambleWeft',
      'ArrowWeft',
      'CodeWeft',
    ])
  })

  it('a line before any heading is a Document-Preamble PreambleWeft', () => {
    const out = tokenise(['loose line'])
    expect(out[0].type).toBe('PreambleWeft')
    expect(out[0].health.status).toBe('ok')
  })
})

// =============================================================================
// Health aggregation — the weft's `health.status` is the worst of its
// subnodes' statuses plus any `unexpected[]` entries (which count as error).
// =============================================================================

describe('Tokeniser — health aggregation', () => {
  it('well-formed heading: weft is ok', () => {
    expect(tokenise(['# Title [App]{TS}'])[0].health.status).toBe('ok')
    expect(tokenise(['## Section [Foo]'])[0].health.status).toBe('ok')
  })

  it('any error subnode flips the weft to error', () => {
    // Synthetic close inside the tag → tag.health is error → weft.health is error.
    expect(tokenise(['## Section [Foo'])[0].health.status).toBe('error')
  })

  it('any unexpected entry flips the weft to error even with ok subnodes', () => {
    // [First] is well-formed; [Second] is extra → unexpected → weft is error.
    expect(tokenise(['## Multi [First] [Second]'])[0].health.status).toBe(
      'error',
    )
  })
})

describe('Tokeniser — Arrow inline code', () => {
  const arrowOf = (out: ReadonlyArray<LoomWeft>): ArrowWeft =>
    out.find((w): w is ArrowWeft => w.type === 'ArrowWeft')!

  it('fills `code` from inline content after `=>`, past the line terminator', () => {
    const arrow = arrowOf(tokenise(['## A', '=> export const x = 1']))
    expect(arrow.code?.source).toBe('export const x = 1')
  })

  it('the `code` span excludes the `=>` marker and its trailing whitespace', () => {
    const arrow = arrowOf(tokenise(['## A', '=>   export const x = 1']))
    expect(arrow.code?.source).toBe('export const x = 1')
  })

  it('a bare `=>` has no inline code', () => {
    expect(arrowOf(tokenise(['## A', '=>'])).code).toBeUndefined()
  })
})
