import { describe, expect, it } from '@effect/vitest'
import {
  AmbiguousAnchor,
  CollidingTitles,
  CrossLanguageAnchor,
  describe as renderFault,
  EmptyLabel,
  EmptySink,
  faulty,
  MalformedLabel,
  MisplacedSpecifier,
  MissingLanguageWarp,
  MissingWarpValue,
  SinkCycle,
  UnclosedDelimiter,
  UnresolvedAnchor,
  UnresolvedReroute,
  type EmptyConstruct,
} from '#ast/LoomFault'

// The fault catalog is the one place every Loom diagnostic is worded. These
// tests read the table directly: a fault in, a `{ severity, message }` out. They
// also pin the bug that motivated the catalog — an empty tag once surfaced the
// internal model invariant `empty value requires non-ok health.status`, which no
// reader should ever see.

const POS = {
  start: { line: 1, offset: 10 },
  end: { line: 1, offset: 12 },
}

const everyEmptyConstruct: ReadonlyArray<EmptyConstruct> = [
  'tag',
  'specifier',
  'path',
  'warpName',
  'anchorName',
  'warpAnnotation',
  'warpDefault',
]

describe('LoomFault — the diagnostic catalog', () => {
  it('words an empty label by construct, in plain language', () => {
    expect(renderFault(EmptyLabel({ construct: 'tag' }))).toEqual({
      severity: 'error',
      message: 'Tag label cannot be empty.',
    })
    expect(renderFault(EmptyLabel({ construct: 'anchorName' })).message).toBe(
      'Anchor name cannot be empty.',
    )
    expect(
      renderFault(EmptyLabel({ construct: 'warpAnnotation' })).message,
    ).toBe('Warp annotation cannot be empty.')
  })

  it('words a malformed label with the rule it broke and the value it got', () => {
    expect(
      renderFault(MalformedLabel({ construct: 'tag', value: 'a b' })).message,
    ).toBe(
      'Tag label may contain only letters, digits, hyphen, and underscore; got `a b`.',
    )
    expect(
      renderFault(MalformedLabel({ construct: 'warpName', value: '1x' })).message,
    ).toBe('Warp name must be a TypeScript identifier; got `1x`.')
    expect(
      renderFault(MalformedLabel({ construct: 'anchorName', value: 'a]b' }))
        .message,
    ).toBe('Anchor name may not contain `]`; got `a]b`.')
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
      /^Unresolved anchor: no section named `n`\./,
    )
    expect(
      renderFault(AmbiguousAnchor({ name: 'Helper', count: 2 })).message,
    ).toMatch(/^Ambiguous anchor: 2 sections are named `Helper`\./)
    expect(
      renderFault(
        CrossLanguageAnchor({ name: 'Config', host: 'typescript', found: 'json' }),
      ).message,
    ).toMatch(/^Cross-language transclusion: `Config` is json, but/)
  })

  it('words the sink-tree faults, naming what to fix', () => {
    expect(renderFault(CollidingTitles({ name: 'theCli' })).message).toMatch(
      /^Two sections normalise to the same name `theCli`\./,
    )
    expect(renderFault(SinkCycle({ name: 'The CLI' })).message).toMatch(
      /^Sink cycle: the higher-order sink `The CLI` reaches itself/,
    )
    expect(
      renderFault(UnresolvedReroute({ directory: 'packages/missing/' })).message,
    ).toMatch(/^Reroute to `packages\/missing\/`, which no higher-order sink declares\./)
    expect(
      renderFault(MisplacedSpecifier({ specifier: 'package.json' })).message,
    ).toMatch(/^Specifier `package.json` on an anchor outside a higher-order sink\./)
  })

  it('makes an empty higher-order sink a warning, not an error', () => {
    expect(renderFault(EmptySink({ directory: 'packages/loom-cli/' })).severity).toBe(
      'warning',
    )
    expect(faulty(EmptySink({ directory: 'packages/loom-cli/' }), POS).status).toBe(
      'warning',
    )
  })

  it('wraps a fault as positioned node health', () => {
    const health = faulty(UnclosedDelimiter({ expected: ']' }), POS)
    expect(health.status).toBe('error')
    expect(health.diagnostics).toEqual([
      { message: 'expected closing `]`', position: POS, severity: 'error' },
    ])
  })

  it('lets a warning fault leave the node short of error', () => {
    expect(renderFault(MissingLanguageWarp()).severity).toBe('warning')
    expect(faulty(MissingLanguageWarp(), POS).status).toBe('warning')
    expect(faulty(MissingWarpValue({ name: 'n' }), POS).status).toBe('error')
  })
})
