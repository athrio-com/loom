import { describe, expect, it } from 'bun:test'
import { Effect, Match, Schema } from 'effect'
import type { Fix, Health, Position } from '@athrio/loom-ast/LoomNode'
import { LoomDocumentSchema, type LoomDocument } from '@athrio/loom-ast/LoomAst'
import type { ParametersToken, SpecifierToken } from '@athrio/loom-ast/LoomTokens'
import { parseDocument, parsedDocument, ParseLayer } from './parse'

const built = (text: string): LoomDocument =>
  Effect.runSync(parseDocument(text).pipe(Effect.provide(ParseLayer)))

const bracesOf = (heading: string): ParametersToken | undefined =>
  built(`${heading}\n\nProse.\n`).sections[0]?.heading.specifier

const statedBy = (heading: string): ReadonlyArray<readonly [string, string | undefined]> =>
  (bracesOf(heading)?.parameters ?? []).map(
    (parameter) => [parameter.key.value, parameter.values[0]?.value] as const,
  )

const textAt = (text: string, position: Position): string =>
  text.slice(position.start.offset, position.end.offset)

const greeting = (braces: string): string => `::${'['}Greeting]${braces}`

const anchorIn = (line: string) =>
  built(`# A\n\n=>\n\n${line}\n`).sections[0]?.code.flatMap((weft) => weft.anchors)[0]

const boxIn = (line: string) =>
  built(`# A\n\n${line}\nBody.\n:::\n`).sections[0]?.preamble.flatMap((weft) =>
    weft.box ? [weft.box] : [],
  )[0]

const judgedIn = (
  braces: SpecifierToken | ParametersToken | undefined,
): ReadonlyArray<{ readonly health: Health }> =>
  Match.value(braces).pipe(
    Match.when(Match.undefined, () => []),
    Match.when({ type: 'Parameters' }, (held) => [...held.parameters, ...held.labels]),
    Match.when({ type: 'Specifier' }, (labelled) => [labelled.label]),
    Match.exhaustive,
  )

const messagesIn = (braces: SpecifierToken | ParametersToken | undefined): ReadonlyArray<string> =>
  judgedIn(braces).flatMap((judged) => judged.health.diagnostics.map((found) => found.message))

const fixesIn = (braces: SpecifierToken | ParametersToken | undefined): ReadonlyArray<Fix> =>
  judgedIn(braces).flatMap((judged) =>
    judged.health.diagnostics.flatMap((found) => found.fixes ?? []),
  )

describe("expanding a heading's label", () => {
  it('writes a language in full', () => {
    expect(statedBy('# Build {Bash}')).toEqual([['lang', 'Bash']])
  })

  it('writes a kind in full, in any case of letters', () => {
    expect(statedBy('# Install {Tangle}')).toEqual([['kind', 'Tangle']])
    expect(statedBy('# Install {tangle}')).toEqual([['kind', 'tangle']])
  })

  it('keeps a language of two words whole', () => {
    expect(statedBy('# Build {Emacs Lisp}')).toEqual([['lang', 'Emacs Lisp']])
  })

  it('leaves parameters as the author wrote them', () => {
    expect(statedBy('# Install {kind=Tangle lang=sh}')).toEqual([
      ['kind', 'Tangle'],
      ['lang', 'sh'],
    ])
  })
})

describe('a parameter the pass writes', () => {
  const text = '# Install {Tangle}\n\nProse.\n'
  const [kind] = built(text).sections[0]?.heading.specifier?.parameters ?? []

  it('covers the label the author wrote', () => {
    expect(kind && textAt(text, kind.position)).toBe('Tangle')
  })

  it('has a key with no width, where the label starts', () => {
    expect(kind?.key.source).toBe('')
    expect(kind?.key.position.start.offset).toBe(kind?.position.start.offset)
    expect(kind?.key.position.end.offset).toBe(kind?.position.start.offset)
  })
})

describe('a label the tokeniser could not read', () => {
  it('states nothing and keeps its fault', () => {
    const braces = bracesOf('# Build {}')
    expect(braces?.parameters).toEqual([])
    expect(braces?.health.diagnostics.map((found) => found.message)).toEqual([
      'These braces are empty. Write a label in them, or remove them.',
    ])
  })
})

describe('a label beside parameters', () => {
  it('is written in full under the key it stands for, on a heading', () => {
    expect(messagesIn(bracesOf('# Build {Bash kind=Tangle}'))).toEqual([
      'A label stands alone only in braces that hold nothing else. Write it in full here, as `lang="Bash"`.',
    ])
    expect(messagesIn(bracesOf('# Build {Tangle lang=sh}'))).toEqual([
      'A label stands alone only in braces that hold nothing else. Write it in full here, as `kind="Tangle"`.',
    ])
  })

  it('offers the full form as its fix, and fails the anchor that bears it', () => {
    const anchor = anchorIn(greeting('{To be settled provides=greet}'))
    const [label] = anchor?.specifier?.type === 'Parameters' ? anchor.specifier.labels : []
    expect(label?.health.diagnostics[0]?.fixes?.map((fix) => fix.text)).toEqual([
      'kind="To be settled"',
    ])
    expect(anchor?.specifier?.health.status).toBe('error')
    expect(anchor?.health.status).toBe('error')
  })
})

describe('claiming a kind', () => {
  const kindOf = (heading: string): string | undefined =>
    built(`${heading}\n\nProse.\n`).sections[0]?.kind

  it('claims the kind a label names', () => {
    expect(kindOf('# Install {Tangle}')).toBe('Tangle')
    expect(kindOf('# An idea {concept}')).toBe('Concept')
  })

  it('claims the kind a parameter names', () => {
    expect(kindOf('# Install {kind=tangle lang=sh}')).toBe('Tangle')
  })

  it('claims nothing for a language, or for no braces', () => {
    expect(kindOf('# Build {Bash}')).toBeUndefined()
    expect(kindOf('# Plain')).toBeUndefined()
  })
})

describe('a kind nothing declares', () => {
  const heading = built('# Build {kind=Bogus}\n\nProse.\n').sections[0]?.heading

  it('claims nothing', () => {
    expect(built('# Build {kind=Bogus}\n\nProse.\n').sections[0]?.kind).toBeUndefined()
  })

  it('is a fault on the value that names it', () => {
    expect(messagesIn(heading?.specifier)).toEqual([
      'A heading takes no `Bogus` kind. It takes `Tangle`, `Concept`, and `Manifest`.',
    ])
    expect(heading?.specifier?.health.status).toBe('error')
    expect(heading?.health.status).toBe('error')
  })
})

describe('checking the keys of braces', () => {
  it("faults a key a heading does not take, and fails the heading's braces", () => {
    const heading = built('# Build {flavour=dry}\n\nProse.\n').sections[0]?.heading
    expect(messagesIn(heading?.specifier)).toEqual([
      'A heading takes no `flavour` key. It takes `lang` and `kind`.',
    ])
    expect(heading?.specifier?.health.status).toBe('error')
    expect(heading?.health.status).toBe('error')
  })

  it('faults a key written twice', () => {
    expect(messagesIn(bracesOf('# Build {lang=Bash lang=sh}'))).toEqual([
      '`lang` is written twice in these braces. Keep one.',
    ])
  })

  it("checks an anchor's keys, and fails the anchor", () => {
    const anchor = anchorIn(greeting('{provides=a colour=red}'))
    expect(messagesIn(anchor?.specifier)).toEqual([
      'An anchor takes no `colour` key. It takes `kind` and `provides`.',
    ])
    expect(anchor?.health.status).toBe('error')
    expect(messagesIn(anchorIn(greeting('{provides=a provides=b}'))?.specifier)).toEqual([
      '`provides` is written twice in these braces. Keep one.',
    ])
  })

  it("checks a box's keys", () => {
    expect(messagesIn(boxIn('::: Cells {kind=Note width=480}')?.specifier)).toEqual([
      'A box takes no `width` key. It takes `kind`, `provides`, and `anchors`.',
    ])
  })

  it('gives a repeated key the fault for the repeat alone', () => {
    expect(messagesIn(anchorIn(greeting('{kind=Module kind=Bogus}'))?.specifier)).toEqual([
      '`kind` is written twice in these braces. Keep one.',
    ])
  })

  it('leaves sound braces as they were', () => {
    const text = '# Build {kind=Tangle lang=sh}\n\nProse.\n'
    const parsed = Effect.runSync(parsedDocument(text).pipe(Effect.provide(ParseLayer)))
    expect<unknown>(built(text).sections[0]?.heading.specifier).toEqual(
      parsed.sections[0]?.heading.specifier,
    )
  })
})

describe("the kind an anchor's braces name", () => {
  it('faults a label that names no kind of anchor, and fails the anchor', () => {
    const anchor = anchorIn(greeting('{x}'))
    expect(messagesIn(anchor?.specifier)).toEqual([
      'An anchor takes no `x` kind. It takes `To be settled` and `Module`.',
    ])
    expect(anchor?.health.status).toBe('error')
  })

  it('faults a parameter that names no kind of anchor', () => {
    expect(messagesIn(anchorIn(greeting('{kind=Term}'))?.specifier)).toEqual([
      'An anchor takes no `Term` kind. It takes `To be settled` and `Module`.',
    ])
  })

  it('reads the kind in any case of letters', () => {
    const anchor = anchorIn(greeting('{to be settled}'))
    expect(messagesIn(anchor?.specifier)).toEqual([])
    expect(anchor?.health.status).toBe('ok')
  })

  it('tells the author the present name of a kind written by its former name', () => {
    const anchor = anchorIn(greeting('{Reference}'))
    expect(messagesIn(anchor?.specifier)).toEqual([
      'The `Reference` kind is now called `Module`. Write `Module`.',
    ])
    expect(fixesIn(anchor?.specifier)).toEqual([{ title: 'Write `Module`', text: 'Module' }])
    expect(anchor?.health.status).toBe('error')
  })

  it('knows a former name written as a parameter, in any case of letters', () => {
    expect(messagesIn(anchorIn(greeting('{kind=reference provides=greet}'))?.specifier)).toEqual([
      'The `reference` kind is now called `Module`. Write `Module`.',
    ])
  })

  it("leaves a box's kind for the book to judge", () => {
    expect(messagesIn(boxIn('::: Cells {Mermaid}')?.specifier)).toEqual([])
  })
})

describe('the tree the row writes', () => {
  const text = '# Build {Bash}\n\nProse.\n\n# Install {kind=Tangle lang=sh}\n\nProse.\n'
  const decoded = Schema.decodeUnknownSync(LoomDocumentSchema)

  it('decodes as a LoomDocument', () => {
    expect(() => decoded(built(text))).not.toThrow()
  })

  it('differs from the tree the parser built', () => {
    const parsed = Effect.runSync(parsedDocument(text).pipe(Effect.provide(ParseLayer)))
    expect(() => decoded(parsed)).toThrow()
  })
})
