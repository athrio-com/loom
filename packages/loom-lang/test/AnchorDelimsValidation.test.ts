import { Effect, Option, Result } from 'effect'
import { describe, expect, it } from 'vitest'
import { checkAnchorDelims, defaultAnchorDelims } from '@athrio/loom-ast/LoomTokens'
import { LoomCorpusAstBuilder, type Source } from '#ast/LoomCorpusAstBuilder'

// A package configures its anchor delimiters in loom.json, so a bad pair is a
// parse-level fault — the same class as a mixed line terminator. checkAnchorDelims
// raises a distinct, self-describing error per fault; the parse recovers it into
// the document's health, where the editor and the tangler both surface it.
const check = (open: string, close: string) =>
  Effect.runSync(Effect.result(checkAnchorDelims({ open, close })))

describe('checkAnchorDelims — a configured anchor pair is validated', () => {
  it('accepts the built-in pair', () => {
    expect(check(defaultAnchorDelims.open, defaultAnchorDelims.close)).toStrictEqual(
      Result.succeed(defaultAnchorDelims),
    )
  })

  it('accepts a distinct custom pair, and `]` as a close', () => {
    expect(Result.isSuccess(check('<<', '>>'))).toBe(true)
    // the reserved-marker list guards the open, not the close, so the built-in
    // `]` stays a valid close under a custom open.
    expect(Result.isSuccess(check('<<', ']'))).toBe(true)
  })

  it.each([
    ['', ']', 'EmptyAnchorDelims'],
    ['::[', '', 'EmptyAnchorDelims'],
    ['@@', '@@', 'IdenticalAnchorDelims'],
    ['< <', '>', 'WhitespaceAnchorDelims'],
    ['[', ']', 'ReservedAnchorDelims'],
    ['<', '>', 'ReservedAnchorDelims'],
    ['=>', ']', 'ReservedAnchorDelims'],
    ['{{', '}}', 'ReservedAnchorDelims'],
  ])('rejects open=%j close=%j as %s, suggesting the default', (open, close, tag) => {
    const result = check(open, close)
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure._tag).toBe(tag)
      // the error describes itself and points at a sound pair
      expect(result.failure.message).toContain(defaultAnchorDelims.open)
    }
  })
})

describe('the parse recovers a bad pair into document health', () => {
  const source: Source = {
    read: () => Effect.succeed('# Title\n\n=>\n\nconst x = 1\n'),
    list: Option.none(),
  }

  it('surfaces the self-describing message, never a crash', () => {
    const module = Effect.runSync(
      LoomCorpusAstBuilder.pipe(
        Effect.flatMap((builder) =>
          builder.build(source, '/x.loom', { open: '@@', close: '@@' }),
        ),
        Effect.provide(LoomCorpusAstBuilder.layer),
      ),
    )
    expect(module.doc.health.status).toBe('error')
    expect(module.doc.health.diagnostics[0]?.message).toContain('must differ')
  })
})
