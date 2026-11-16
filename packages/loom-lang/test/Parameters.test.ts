import { describe, expect, it } from 'bun:test'
import { Effect, Option, Result } from 'effect'
import type { Diagnostic } from '@athrio/loom-ast/LoomNode'
import type { LoomDocument, LoomSection } from '@athrio/loom-ast/LoomAst'
import { headingLang, readAs, type ScalarType } from '@athrio/loom-ast/LoomTokens'
import { sectionLanguage } from '#ast/ProductBuilder'
import { parseDocument, ParseLayer } from './parse'

const parsed = (heading: string): LoomDocument =>
  Effect.runSync(parseDocument(`${heading}\n\nProse.\n`).pipe(Effect.provide(ParseLayer)))

const sectionOf = (heading: string): LoomSection => parsed(heading).sections[0]!

const kindOf = (heading: string): string | undefined => sectionOf(heading).kind

const langOf = (heading: string): string | undefined =>
  Option.getOrUndefined(
    Option.flatMap(Option.fromNullishOr(sectionOf(heading).heading.specifier), headingLang),
  )

const diagnosticsIn = (node: unknown): ReadonlyArray<Diagnostic> => {
  if (node === null || typeof node !== 'object') return []
  if (globalThis.Array.isArray(node)) return node.flatMap(diagnosticsIn)
  const own =
    'health' in node
      ? (node as { health: { diagnostics: ReadonlyArray<Diagnostic> } }).health.diagnostics
      : []
  return [
    ...own,
    ...Object.entries(node).flatMap(([key, value]) =>
      key === 'health' ? [] : diagnosticsIn(value),
    ),
  ]
}

const faultsOf = (heading: string): ReadonlyArray<string> =>
  diagnosticsIn(parsed(heading)).map((found) => found.message)

describe("a heading's label", () => {
  it('names a kind of section, in any case of letters', () => {
    expect(kindOf('# Install {Tangle}')).toBe('Tangle')
    expect(kindOf('# Install {tangle}')).toBe('Tangle')
    expect(langOf('# Install {Tangle}')).toBeUndefined()
  })

  it('names a language otherwise', () => {
    expect(langOf('# Build {Bash}')).toBe('Bash')
    expect(kindOf('# Build {Bash}')).toBeUndefined()
  })
})

describe("a heading's parameters", () => {
  it('name a kind and a language at once', () => {
    expect(sectionOf('# Install {kind=Tangle lang=sh}').heading.specifier?.type).toBe('Parameters')
    expect(kindOf('# Install {kind=Tangle lang=sh}')).toBe('Tangle')
    expect(langOf('# Install {kind=Tangle lang=sh}')).toBe('sh')
  })
})

describe("the faults a heading's braces raise", () => {
  it('fault a key written twice', () => {
    expect(faultsOf('# Build {lang=Bash lang=sh}')).toEqual([
      '`lang` is written twice in these braces. Keep one.',
    ])
  })

  it('fault a key a heading does not take', () => {
    expect(faultsOf('# Build {flavour=dry}')).toEqual([
      'A heading takes no `flavour` key. It takes `lang` and `kind`.',
    ])
  })

  it('fault a kind the core does not know', () => {
    expect(faultsOf('# Build {kind=Bogus}')).toEqual([
      'A heading takes no `Bogus` kind. It takes `Tangle`, `Concept`, and `Manifest`.',
    ])
  })

  it('write a label beside parameters in full, under the key it stands for', () => {
    expect(faultsOf('# Build {Bash kind=Tangle}')).toEqual([
      'A label stands alone only in braces that hold nothing else. Write it in full here, as `lang="Bash"`.',
    ])
    expect(faultsOf('# Build {Tangle lang=sh}')).toEqual([
      'A label stands alone only in braces that hold nothing else. Write it in full here, as `kind="Tangle"`.',
    ])
  })

  it('leave a label that names a language alone', () => {
    expect(faultsOf('# Build {Bogus}')).toEqual([])
  })

  it('fault a second pair of braces', () => {
    expect(faultsOf('# Greeting {Bash} {Tangle}')).toEqual([
      'This line has no place for `{Tangle}`, so Loom would ignore it. Remove it.',
    ])
  })
})

describe('the language a heading names', () => {
  const languageOf = (heading: string): string =>
    sectionLanguage(sectionOf(heading), 'typescript', Option.none())

  it('is its lang, when it names one', () => {
    expect(languageOf('# Build {lang=Bash}')).toBe('bash')
    expect(languageOf('# Install {kind=Tangle lang=sh}')).toBe('sh')
  })

  it('is the language its kind implies, when it names none', () => {
    expect(languageOf('# The manifest {kind=Manifest}')).toBe('json')
    expect(languageOf('# Install {Tangle}')).toBe('typescript')
  })

  it("is the chapter's for a concept, whose kind implies none", () => {
    expect(languageOf('# An idea {kind=Concept}')).toBe('typescript')
  })

  it("is the chapter's, when the heading names nothing", () => {
    expect(languageOf('# Plain')).toBe('typescript')
  })
})

describe('reading a value through a type', () => {
  const read = (type: ScalarType, written: string) =>
    Result.getOrUndefined(readAs(type)(written))

  const wanted = (type: ScalarType, written: string) =>
    Result.match(readAs(type)(written), { onSuccess: () => undefined, onFailure: (unread) => unread })

  it('keeps text as it is written, whatever it looks like', () => {
    expect(read('text', 'NO')).toBe('NO')
    expect(read('text', '480')).toBe('480')
  })

  it('reads a number, with a sign and a fraction', () => {
    expect(read('number', '480')).toBe(480)
    expect(read('number', '-2.5')).toBe(-2.5)
    expect(wanted('number', 'wide')).toEqual({ wanted: 'number' })
    expect(wanted('number', '1e3')).toEqual({ wanted: 'number' })
  })

  it('reads a boolean from its two words alone', () => {
    expect(read('boolean', 'true')).toBe(true)
    expect(read('boolean', 'false')).toBe(false)
    expect(wanted('boolean', 'True')).toEqual({ wanted: 'word', words: ['true', 'false'] })
  })

  it("reads a locale in the standard's own spelling", () => {
    expect(read('locale', 'et')).toBe('et')
    expect(read('locale', 'pt-br')).toBe('pt-BR')
    expect(wanted('locale', 'pt_BR')).toEqual({ wanted: 'locale' })
  })

  it('reads a choice as its list spells it', () => {
    const status: ScalarType = { choice: ['draft', 'done'] }
    expect(read(status, 'done')).toBe('done')
    expect(wanted(status, 'Done')).toEqual({ wanted: 'word', words: ['draft', 'done'] })
  })

  it('takes any name for a reference', () => {
    expect(read('reference', 'Saying hello')).toBe('Saying hello')
  })
})
