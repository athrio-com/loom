import { describe, expect, it as it_ } from 'bun:test'
import { effectify } from '@athrio/effect-test'
const it = effectify(it_)
import {
  AmbiguousAnchor,
  CrossLanguageAnchor,
  describe as renderFault,
  EmptyLabel,
  faulty,
  MalformedLabel,
  MissingWarpValue,
  UnclosedDelimiter,
  UnresolvedAnchor,
  type EmptyConstruct,
} from '#ast/LoomFault'

// The fault catalog is the one place every Loom diagnostic is worded. These
// tests read the table directly: a fault in, a `{ severity, message }` out. They
// also pin the bug that motivated the catalog — an empty label once surfaced the
// internal model invariant `empty value requires non-ok health.status`, which no
// reader should ever see.

const POS = {
  start: { line: 1, offset: 10 },
  end: { line: 1, offset: 12 },
}

const everyEmptyConstruct: ReadonlyArray<EmptyConstruct> = [
  'specifier',
  'path',
  'warpName',
  'anchorName',
  'warpAnnotation',
  'warpDefault',
]

describe('LoomFault — the diagnostic catalog', () => {
  it('words an empty label by construct, in plain language', () => {
    expect(renderFault(EmptyLabel({ construct: 'specifier' }))).toEqual({
      severity: 'error',
      message: 'These braces are empty. Write a label in them, or remove them.',
    })
    expect(renderFault(EmptyLabel({ construct: 'anchorName' })).message).toBe(
      'This anchor names nothing. Write the name of a section or chapter in its brackets.',
    )
    expect(
      renderFault(EmptyLabel({ construct: 'warpAnnotation' })).message,
    ).toBe('This warp has an empty type. Write a type after its colon, or remove the colon.')
  })

  it('words a malformed label with the rule it broke and the value it got', () => {
    expect(
      renderFault(MalformedLabel({ construct: 'specifier', value: 'a.b' })).message,
    ).toBe(
      '`a.b` is not a valid label. A label may contain only words of letters, digits, hyphens, and underscores, one space apart.',
    )
    expect(
      renderFault(MalformedLabel({ construct: 'warpName', value: '1x' })).message,
    ).toBe('`1x` is not a valid warp name. A warp name must be a TypeScript identifier.')
    expect(
      renderFault(MalformedLabel({ construct: 'anchorName', value: 'a]b' }))
        .message,
    ).toBe('`a]b` is not a valid anchor name. An anchor name may not contain `]`.')
  })

  it('never leaks the internal model invariant as a message', () => {
    everyEmptyConstruct.forEach((construct) =>
      expect(renderFault(EmptyLabel({ construct })).message).not.toMatch(
        /non-ok|health\.status/,
      ),
    )
  })

  it('keeps the anchor faults in their established words', () => {
    expect(renderFault(UnresolvedAnchor({ name: 'n' })).message).toMatch(
      /^No section or chapter is called `n`\./,
    )
    expect(
      renderFault(AmbiguousAnchor({ name: 'Helper', count: 2, paths: [] })).message,
    ).toMatch(/^`Helper` names 2 sections\./)
    expect(
      renderFault(
        CrossLanguageAnchor({ name: 'Config', host: 'typescript', found: 'json' }),
      ).message,
    ).toMatch(/^`Config` holds json code, but/)
  })

  it('wraps a fault as positioned node health', () => {
    const health = faulty(UnclosedDelimiter({ expected: ']' }), POS)
    expect(health.status).toBe('error')
    expect(health.diagnostics).toEqual([
      { message: 'This is never closed. Add `]` on the same line.', position: POS, severity: 'error' },
    ])
  })

  it('wraps a warning-free catalog: every fault fails its node', () => {
    expect(faulty(MissingWarpValue({ name: 'n' }), POS).status).toBe('error')
  })
})
