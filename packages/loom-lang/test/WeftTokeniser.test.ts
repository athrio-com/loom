import { describe, expect, it } from '@effect/vitest'
import { Chunk, Effect, Stream } from 'effect'
import type { LineRange } from '#ast/LineRanges'
import { okHealth } from '@athrio/loom-ast/LoomNode'
import { WeftClassifier } from '#ast/WeftClassifier'
import { normaliseTitle, WeftTokeniser } from '#ast/WeftTokeniser'
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
// Scanning + construction — happy paths. A Specifier token is built from its
// `{…}` match, its subnodes carry real source positions and ok health, and the
// label value is extracted from the source slice.
// =============================================================================

describe('Tokeniser — scanning + construction (happy paths)', () => {
  it("fills a specifier's open/label/close subnodes from a `{Lang}` source", () => {
    const w = headingAt(tokenise(['# Title {TypeScript}']), 0)
    expect(w.specifier?.open.value).toBe('{')
    expect(w.specifier?.label.value).toBe('TypeScript')
    expect(w.specifier?.close.value).toBe('}')
    expect(w.specifier?.open.health).toEqual(okHealth)
    expect(w.specifier?.label.health).toEqual(okHealth)
    expect(w.specifier?.close.health).toEqual(okHealth)
  })

  it('aggregates specifier subnode health into the weft', () => {
    expect(tokenise(['# Title {TypeScript}'])[0].health.status).toBe('ok')
  })
})

// =============================================================================
// Heading — one weft kind for every `#{1,6}` line, carrying an optional title
// and an optional specifier. The title names the section, and `normaliseTitle`
// turns it into the identifier the frame builder reads.
// =============================================================================

describe('Tokeniser — Heading title/specifier filling', () => {
  it('fills the title and specifier when the source provides them', () => {
    const w = headingAt(tokenise(['# Title {TypeScript}']), 0)
    expect(w.title?.source).toBe('Title')
    expect(w.specifier?.label.value).toBe('TypeScript')
    expect(w.specifier?.health.status).toBe('ok')
  })

  it('a title only → specifier undefined, weft ok', () => {
    const w = headingAt(tokenise(['# Title']), 0)
    expect(w.title?.source).toBe('Title')
    expect(w.specifier).toBeUndefined()
    expect(w.health.status).toBe('ok')
  })

  it('normaliseTitle turns distinct titles into distinct identifiers', () => {
    expect(normaliseTitle('Alpha one')).toBe('AlphaOne')
    expect(normaliseTitle('Beta two')).toBe('BetaTwo')
    expect(normaliseTitle('Alpha one')).not.toBe(normaliseTitle('Beta two'))
  })

  it('normaliseTitle maps identical titles to the same identifier', () => {
    expect(normaliseTitle('Glossary')).toBe(normaliseTitle('Glossary'))
  })

  it('every level (1–6) tokenises as a HeadingWeft, never incomplete', () => {
    for (const line of ['# One', '## Two', '###### Six']) {
      const out = tokenise([line])
      expect(out[0].type).toBe('HeadingWeft')
      expect(out[0].health.status).not.toBe('incomplete')
    }
  })

  it('post-Tokeniser Heading is never `incomplete` across presence/absence', () => {
    for (const line of ['# Title', '# Title {TS}', '# {TS}']) {
      expect(tokenise([line])[0].health.status).not.toBe('incomplete')
    }
  })
})

// =============================================================================
// Language specifier vs sink — the heading's two structural slots. A `{Lang}`
// specifier (`{Bash}`, `{Loom}`) names the section's language and lands on
// `weft.specifier` as a `Specifier`. A `[dir, file]` sink names a file tangle
// target and lands on `weft.sink` as a `Sink`; a one-part `[dir]` sink names a
// directory (the higher-order sink). The bracket inner text splits on the first
// comma: two parts give `dir` + `file`, one part gives `dir` alone.
// =============================================================================

describe('Tokeniser — language specifier vs sink', () => {
  it('`{Bash}` is a language Specifier on `weft.specifier`', () => {
    const w = headingAt(tokenise(['# Build {Bash}']), 0)
    expect(w.specifier?.type).toBe('Specifier')
    expect(w.specifier?.label.value).toBe('Bash')
    expect(w.sink).toBeUndefined()
  })

  it('`{Loom}` is a language Specifier on `weft.specifier`', () => {
    const w = headingAt(tokenise(['# Deps {Loom}']), 0)
    expect(w.specifier?.type).toBe('Specifier')
    expect(w.specifier?.label.value).toBe('Loom')
    expect(w.sink).toBeUndefined()
  })

  it('`[src/main/scala, App.scala]` is a two-part file Sink', () => {
    const w = headingAt(tokenise(['# Tangle [src/main/scala, App.scala]']), 0)
    expect(w.sink?.type).toBe('Sink')
    expect(w.sink?.dir.value).toBe('src/main/scala')
    expect(w.sink?.file?.value).toBe('App.scala')
    expect(w.sink?.health.status).toBe('ok')
    expect(w.specifier).toBeUndefined()
  })

  it('`[., build.sh]` is a two-part file Sink rooted at `.`', () => {
    const w = headingAt(tokenise(['# Tangle [., build.sh]']), 0)
    expect(w.sink?.type).toBe('Sink')
    expect(w.sink?.dir.value).toBe('.')
    expect(w.sink?.file?.value).toBe('build.sh')
  })

  it('`[packages/loom-cli]` is a one-part directory Sink (file absent)', () => {
    const w = headingAt(tokenise(['# CLI [packages/loom-cli]']), 0)
    expect(w.sink?.type).toBe('Sink')
    expect(w.sink?.dir.value).toBe('packages/loom-cli')
    expect(w.sink?.file).toBeUndefined()
    expect(w.sink?.health.status).toBe('ok')
  })

  it('`[lib]` is a one-part directory Sink (single segment)', () => {
    const w = headingAt(tokenise(['# Group [lib]']), 0)
    expect(w.sink?.type).toBe('Sink')
    expect(w.sink?.dir.value).toBe('lib')
    expect(w.sink?.file).toBeUndefined()
  })

  it('splits the bracket on the first comma — the dir is the text before it', () => {
    // The inner `src, a, b.ts` splits at the first comma: the dir is `src`,
    // and the rest (`a, b.ts`) is the file. That file text carries a comma and
    // a space, so it fails the file pattern and its bytes are preserved in
    // `unexpected[]` — proof the split took the whole post-first-comma run.
    const w = headingAt(tokenise(['# File [src, a, b.ts]']), 0)
    expect(w.sink?.dir.value).toBe('src')
    expect(w.sink?.file?.health.status).toBe('error')
    expect(w.sink?.file?.unexpected?.[0].value).toBe('a, b.ts')
  })

  it('a sink directory with a space fails its pattern (bad text in unexpected)', () => {
    const w = headingAt(tokenise(['# Tangle [src/bad name, x.ts]']), 0)
    expect(w.sink?.type).toBe('Sink')
    expect(w.sink?.dir.health.status).toBe('error')
    expect(w.sink?.dir.value).toBe('')
    expect(w.sink?.dir.unexpected?.[0].value).toBe('src/bad name')
  })

  it('a sink file with a space fails its pattern (bad text in unexpected)', () => {
    const w = headingAt(tokenise(['# Tangle [src, bad name.ts]']), 0)
    expect(w.sink?.type).toBe('Sink')
    expect(w.sink?.file?.health.status).toBe('error')
    expect(w.sink?.file?.value).toBe('')
    expect(w.sink?.file?.unexpected?.[0].value).toBe('bad name.ts')
  })

  it('a heading may carry both a specifier and a sink', () => {
    const w = headingAt(tokenise(['# Tangle {Bash} [., build.sh]']), 0)
    expect(w.specifier?.type).toBe('Specifier')
    expect(w.specifier?.label.value).toBe('Bash')
    expect(w.sink?.type).toBe('Sink')
    expect(w.sink?.dir.value).toBe('.')
    expect(w.sink?.file?.value).toBe('build.sh')
  })
})

// =============================================================================
// Multi-specifier — a second `{…}` is an extra: it lands on `weft.unexpected[]`
// and the weft's aggregated health flips to error.
// =============================================================================

describe('Tokeniser — multi-specifier', () => {
  it('multi-specifier captures extras as UnexpectedToken', () => {
    const w = headingAt(tokenise(['# Title {One}{Two}']), 0)
    expect(w.unexpected).toBeDefined()
    expect(w.unexpected!.length).toBeGreaterThan(0)
    expect(w.health.status).toBe('error')
  })
})

// =============================================================================
// Synthetic close — `{` without a matching `}` on the same line. The resulting
// Specifier still has structure (open + label + synthetic close at EOL), but
// `close.health.status === "error"` with an "expected closing" diagnostic.
// =============================================================================

describe('Tokeniser — synthetic close (unclosed bracket)', () => {
  it('unclosed `{` produces a Specifier with synthetic close + error health', () => {
    const w = headingAt(tokenise(['# Title {Lang']), 0)
    expect(w.specifier?.close.health.status).toBe('error')
    expect(w.specifier?.close.health.diagnostics[0].message).toMatch(
      /expected closing/i,
    )
  })
})

// =============================================================================
// Label validation — a malformed specifier label is kept in the AST via the
// synthetic-empty + UnexpectedToken mechanism. The schema's cross-field filter
// admits an empty `value` only when health is NOK.
// =============================================================================

describe('Tokeniser — malformed label values', () => {
  it('malformed label Specifier routes the bad text to unexpected', () => {
    const w = headingAt(tokenise(['# Title {bad lang}']), 0)
    expect(w.specifier?.type).toBe('Specifier')
    expect(w.specifier?.label.health.status).toBe('error')
    expect(w.specifier?.label.value).toBe('')
    expect(w.specifier?.label.unexpected?.[0].value).toBe('bad lang')
  })
})

// =============================================================================
// Heading title — the single trimmed title token: the text between the marker
// and the first structural token, whitespace stripped. Both `{…}` (a specifier)
// and `[…]` (a sink) are structural tokens, so each one bounds the title.
// =============================================================================

describe('Tokeniser — heading title', () => {
  it('captures the title before the specifier, trimmed of the trailing space', () => {
    const w = headingAt(tokenise(['## Title here {TS}']), 0)
    // Marker `## ` ends at offset 3; the specifier opens at 14. The raw gap
    // [3..14) is "Title here " — the trailing space is trimmed, so [3..13).
    expect(w.title?.source).toBe('Title here')
    expect(w.title?.position.start.offset).toBe(3)
    expect(w.title?.position.end.offset).toBe(13)
  })

  it('a `[…]` sink bounds the title — the title ends before the bracket', () => {
    const w = headingAt(tokenise(['# Title [App, App.scala] {TypeScript}']), 0)
    expect(w.title?.source).toBe('Title')
    expect(w.sink?.dir.value).toBe('App')
    expect(w.sink?.file?.value).toBe('App.scala')
    expect(w.specifier?.label.value).toBe('TypeScript')
  })

  it('has no title when the heading is only the marker and a specifier', () => {
    const w = headingAt(tokenise(['## {TS}']), 0)
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

  it('attaches a directory Sink `::[A cli module][packages/loom-cli]`', () => {
    const w = codeWeftFromLines(['## A', '=>', '::[A cli module][packages/loom-cli]'], 2)
    expect(w.anchors).toHaveLength(1)
    expect(w.anchors[0].name.value).toBe('A cli module')
    expect(w.anchors[0].specifier?.type).toBe('Sink')
    expect((w.anchors[0].specifier as { dir: { value: string } }).dir.value).toBe(
      'packages/loom-cli',
    )
    expect(w.anchors[0].health.status).toBe('ok')
    expect(w.anchors[0].source).toBe('::[A cli module][packages/loom-cli]')
  })

  it('attaches a file Sink `::[The manifest][., package.json]`', () => {
    const w = codeWeftFromLines(['## A', '=>', '::[The manifest][., package.json]'], 2)
    expect(w.anchors[0].specifier?.type).toBe('Sink')
    const sink = w.anchors[0].specifier as {
      dir: { value: string }
      file?: { value: string }
    }
    expect(sink.dir.value).toBe('.')
    expect(sink.file?.value).toBe('package.json')
  })

  it('attaches a language Specifier `::[base]{rust}`', () => {
    const w = codeWeftFromLines(['## A', '=>', '::[base]{rust}'], 2)
    expect(w.anchors[0].specifier?.type).toBe('Specifier')
    expect((w.anchors[0].specifier as { label: { value: string } }).label.value).toBe(
      'rust',
    )
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

  it('captures a directory-anchor target `::[Chapter](book/intro.loom)`', () => {
    const w = codeWeftFromLines(['## A', '=>', '::[Chapter](book/intro.loom)'], 2)
    expect(w.anchors).toHaveLength(1)
    expect(w.anchors[0].name.value).toBe('Chapter')
    expect(w.anchors[0].target?.value).toBe('book/intro.loom')
    expect(w.anchors[0].specifier).toBeUndefined()
    expect(w.anchors[0].health.status).toBe('ok')
    expect(w.anchors[0].source).toBe('::[Chapter](book/intro.loom)')
  })

  it('an anchor with no `(…)` has no target', () => {
    const w = codeWeftFromLines(['## A', '=>', '::[mul]'], 2)
    expect(w.anchors[0].target).toBeUndefined()
  })

  it('trims whitespace inside the target parens', () => {
    const w = codeWeftFromLines(['## A', '=>', '::[X]( book/intro.loom )'], 2)
    expect(w.anchors[0].target?.value).toBe('book/intro.loom')
  })

  it('a `(` with no `)` after the close stays product code', () => {
    const w = codeWeftFromLines(['## A', '=>', '::[x](book/intro.loom'], 2)
    expect(w.anchors[0].target).toBeUndefined()
    expect(w.anchors[0].health.status).toBe('ok')
    expect(w.anchors[0].source).toBe('::[x]')
  })
})

// =============================================================================
// Markdown-aware prose anchors — a `::[x]` in plain prose is a live anchor, but
// the tokeniser holds the markdown layer inert: a `::[x]` inside inline
// backticks `` `::[x]` `` or inside a ``` fenced block produces no anchor, so an
// author can write the anchor syntax as prose about Loom. Warps `{{…}}` are
// inert in the same spans.
// =============================================================================

describe('Tokeniser — markdown-aware prose anchors', () => {
  const proseWeftFromLines = (lines: ReadonlyArray<string>, idx: number) => {
    const out = tokenise(lines)
    const w = out[idx]
    if (w.type !== 'ProseWeft')
      throw new Error(`expected ProseWeft at ${idx}, got ${w.type}`)
    return w
  }

  it('a `::[x]` in plain prose is a live anchor', () => {
    const w = proseWeftFromLines(['## A', '~', 'see ::[mul] for details'], 2)
    expect(w.anchors).toHaveLength(1)
    expect(w.anchors[0].name.value).toBe('mul')
  })

  it('a `::[x]` inside inline backticks is inert (no anchor)', () => {
    const w = proseWeftFromLines(['## A', '~', 'write `::[mul]` to compose'], 2)
    expect(w.anchors).toHaveLength(0)
  })

  it('a live anchor and a backticked one coexist on the same prose line', () => {
    const w = proseWeftFromLines(
      ['## A', '~', '`::[lit]` is literal, but ::[real] composes'],
      2,
    )
    expect(w.anchors.map((a) => a.name.value)).toEqual(['real'])
  })

  it('a `::[x]` inside a ``` fenced block is inert (no anchor)', () => {
    const out = tokenise(['## A', '~', '```', 'use ::[mul] here', '```'])
    const fenced = out[3]
    if (fenced.type !== 'ProseWeft')
      throw new Error(`expected a ProseWeft inside the fence, got ${fenced.type}`)
    expect(fenced.anchors).toHaveLength(0)
  })

  it('a `{{…}}` warp inside inline backticks is inert on a PreambleWeft', () => {
    const out = tokenise(['## A', 'name a service with `{{mul = Mul}}`'])
    const w = out[1]
    if (w.type !== 'PreambleWeft')
      throw new Error(`expected PreambleWeft, got ${w.type}`)
    expect(w.warps).toHaveLength(0)
    expect(w.health.status).toBe('ok')
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
    expect(tokenise(['# Title {TS}'])[0].health.status).toBe('ok')
    expect(tokenise(['## Section'])[0].health.status).toBe('ok')
  })

  it('any error subnode flips the weft to error', () => {
    // Synthetic close inside the specifier → close.health is error → weft is error.
    expect(tokenise(['## Section {Lang'])[0].health.status).toBe('error')
  })

  it('any unexpected entry flips the weft to error even with ok subnodes', () => {
    // {One} is well-formed; {Two} is extra → unexpected → weft is error.
    expect(tokenise(['## Multi {One}{Two}'])[0].health.status).toBe('error')
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
