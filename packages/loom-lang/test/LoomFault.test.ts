import { describe, expect, it } from '@effect/vitest'
import {
  AmbiguousAnchor,
  CollidingTitles,
  CrossLanguageAnchor,
  describe as renderFault,
  DuplicateChapter,
  EmptyLabel,
  EmptySink,
  faulty,
  MalformedLabel,
  MisplacedSpecifier,
  MissingWarpValue,
  OrphanedOpening,
  PointedNotH1,
  SelfRoutingSink,
  SinkCycle,
  SinklessChapter,
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
      message: 'Specifier label cannot be empty.',
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
      renderFault(MalformedLabel({ construct: 'specifier', value: 'a b' })).message,
    ).toBe(
      'Specifier label may contain only letters, digits, hyphen, and underscore; got `a b`.',
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
      renderFault(MisplacedSpecifier({ specifier: 'package.json' })).message,
    ).toMatch(/^Specifier `package.json` on an anchor\./)
    expect(renderFault(SelfRoutingSink({ name: 'Inline' })).message).toMatch(
      /^A book points the chapter `Inline` into its own file\./,
    )
    expect(renderFault(SinklessChapter({ name: 'Prose chapter' })).message).toMatch(
      /^The chapter `Prose chapter` tangles no file/,
    )
    expect(renderFault(PointedNotH1({ name: 'Sub thing' })).message).toMatch(
      /^The chapter `Sub thing` opens below a top-level heading\./,
    )
    expect(renderFault(OrphanedOpening({ name: 'Chapter two' })).message).toMatch(
      /^The first chapter `Chapter two` is not its module's first section/,
    )
    expect(renderFault(DuplicateChapter({ name: 'The widget' })).message).toMatch(
      /^Two higher-order sinks point the chapter `The widget`/,
    )
  })

  it('sorts the sink-tree faults into warnings and errors', () => {
    expect(renderFault(EmptySink({ directory: 'packages/loom-cli/' })).severity).toBe(
      'warning',
    )
    expect(faulty(EmptySink({ directory: 'packages/loom-cli/' }), POS).status).toBe(
      'warning',
    )
    expect(renderFault(SinklessChapter({ name: 'Prose chapter' })).severity).toBe(
      'warning',
    )
    expect(renderFault(PointedNotH1({ name: 'Sub thing' })).severity).toBe('warning')
    expect(renderFault(OrphanedOpening({ name: 'Chapter two' })).severity).toBe(
      'warning',
    )
    expect(renderFault(SelfRoutingSink({ name: 'Inline' })).severity).toBe('error')
    expect(renderFault(DuplicateChapter({ name: 'The widget' })).severity).toBe('error')
  })

  it('wraps a fault as positioned node health', () => {
    const health = faulty(UnclosedDelimiter({ expected: ']' }), POS)
    expect(health.status).toBe('error')
    expect(health.diagnostics).toEqual([
      { message: 'expected closing `]`', position: POS, severity: 'error' },
    ])
  })

  it('lets a warning fault leave the node short of error', () => {
    expect(renderFault(EmptySink({ directory: 'out' })).severity).toBe('warning')
    expect(faulty(EmptySink({ directory: 'out' }), POS).status).toBe('warning')
    expect(faulty(MissingWarpValue({ name: 'n' }), POS).status).toBe('error')
  })
})
