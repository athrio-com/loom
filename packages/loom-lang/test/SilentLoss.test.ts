import { describe, expect, it as it_ } from 'bun:test'
import { effectify } from '@athrio/effect-test'
const it = effectify(it_)
import { Effect } from 'effect'
import type { Diagnostic } from '@athrio/loom-ast/LoomNode'
import { parseDocument, ParseLayer } from './parse'

// Each case here is a way a loom used to lose content without a word: a stray
// specifier, an explicit block left open, a `#` comment that ended the code. Each
// must now leave a diagnostic in the tree, which is where the tangle and the
// editor both look.
const diagnosticsIn = (node: unknown): ReadonlyArray<Diagnostic> => {
  if (Array.isArray(node)) return node.flatMap(diagnosticsIn)
  if (node === null || typeof node !== 'object') return []
  const own = 'health' in node ? (node as { health: { diagnostics: ReadonlyArray<Diagnostic> } }).health.diagnostics : []
  return [...own, ...Object.entries(node).flatMap(([k, v]) => (k === 'health' ? [] : diagnosticsIn(v)))]
}

const diagnosticsOf = (text: string) =>
  parseDocument(text).pipe(Effect.map(diagnosticsIn), Effect.provide(ParseLayer))

describe('silent loss — every dropped piece leaves a diagnostic', () => {
  it.effect('names a second specifier on a heading as an error', () =>
    Effect.gen(function* () {
      const found = yield* diagnosticsOf('# Book\n\n## Bun config {toml} {Tangle}[bunfig.toml]\n\n=>\n\nx\n')
      expect(found.some((d) => d.severity === 'error' && d.message.includes('Unexpected `{Tangle}`'))).toBe(true)
    }),
  )

  it.effect('names an explicit block no tilde closes as an error, at its arrow', () =>
    Effect.gen(function* () {
      const found = yield* diagnosticsOf('# Book\n\n## Skill [SKILL.md]\n\n~>\n\n# swallowed\n')
      const open = found.find((d) => d.message.startsWith('Unclosed explicit block'))
      expect(open?.severity).toBe('error')
      expect(open?.position.start.line).toBe(5)
    }),
  )

  it.effect('raises nothing for an explicit block a tilde closes', () =>
    Effect.gen(function* () {
      const found = yield* diagnosticsOf('# Book\n\n## Skill [SKILL.md]\n\n~>\n\n# kept\n\n~\n')
      expect(found).toEqual([])
    }),
  )

  it.effect('warns about a heading flush against a line of code', () =>
    Effect.gen(function* () {
      const found = yield* diagnosticsOf('# Book\n\n## Script [run.sh]\n\n=>\n\necho start\n# then stop\necho stop\n')
      const glued = found.find((d) => d.message.startsWith('This heading sits directly under a line of code'))
      expect(glued?.severity).toBe('warning')
      expect(glued?.position.start.line).toBe(8)
    }),
  )

  it.effect('leaves a heading with a blank line above it alone', () =>
    Effect.gen(function* () {
      const found = yield* diagnosticsOf('# Book\n\n## A [a.ts]\n\n=>\n\nconst a = 1\n\n## B [b.ts]\n\n=>\n\nconst b = 2\n')
      expect(found).toEqual([])
    }),
  )
})
