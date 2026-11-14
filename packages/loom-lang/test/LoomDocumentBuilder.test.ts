import { describe, expect, it } from 'bun:test'
import { Effect, Schema } from 'effect'
import type { Position } from '@athrio/loom-ast/LoomNode'
import { LoomDocumentSchema, type LoomDocument } from '@athrio/loom-ast/LoomAst'
import type { ParametersToken } from '@athrio/loom-ast/LoomTokens'
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
  const [parameter] = heading?.specifier?.parameters ?? []

  it('claims nothing', () => {
    expect(built('# Build {kind=Bogus}\n\nProse.\n').sections[0]?.kind).toBeUndefined()
  })

  it('is a fault on the value that names it', () => {
    expect(parameter?.health.diagnostics.map((found) => found.message)).toEqual([
      'A heading takes no `Bogus` kind. It takes `Tangle`, `Concept`, and `Manifest`.',
    ])
    expect(heading?.specifier?.health.status).toBe('error')
    expect(heading?.health.status).toBe('error')
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
