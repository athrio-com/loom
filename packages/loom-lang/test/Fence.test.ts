import { describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import { parseDocument, ParseLayer } from './parse'

// A fenced code block lets a loom quote a loom. In prose, a ``` line opens a
// verbatim region: the classifier reads every line inside it as prose, so a
// `#`, `=>`, or `~` there is text, not a mark. In a code region a ``` is just a
// line of that section's code — the classifier never treats it as a fence.
const parse = (src: string) =>
  Effect.runSync(parseDocument(src).pipe(Effect.provide(ParseLayer)))

const lines = (...ls: ReadonlyArray<string>): string => ls.join('\n') + '\n'

describe('a fenced block in prose', () => {
  const fenced = lines(
    '# Chapter',
    '',
    'Quoting a loom:',
    '',
    '```loom',
    '# A greeting',
    '',
    '=>',
    '',
    'export const greet = 1',
    '~',
    '```',
    '',
    'Back to prose.',
  )

  it('keeps the loom in one section — the fenced `#` opens none', () => {
    const doc = parse(fenced)
    expect(doc.sections).toHaveLength(1)
    expect(doc.sections[0].heading.title?.source).toBe('Chapter')
  })

  it('reads every fenced line as prose — no arrow or tilde leaks', () => {
    const body = parse(fenced).sections[0].code
    expect(body.every((w) => w.type === 'ProseWeft')).toBe(true)
    expect(body.some((w) => w.type === 'ArrowWeft')).toBe(false)
    expect(body.some((w) => w.type === 'TildeWeft')).toBe(false)
  })

  it('reconstructs the source verbatim', () => {
    expect(parse(fenced).source).toBe(fenced)
  })
})

describe('a heading after the fence', () => {
  it('opens a section again — the fence closed on its pair', () => {
    const doc = parse(
      lines('# First', '', '```loom', '# Not a heading', '```', '', '# Second'),
    )
    expect(doc.sections.map((s) => s.heading.title?.source)).toEqual([
      'First',
      'Second',
    ])
  })
})

describe('a fence marker inside a code region', () => {
  it('stays code — the region owns it, to be judged by its language', () => {
    const doc = parse(
      lines('# S', '', '=>', '', 'const x = 1', '```', 'still code', '~'),
    )
    const body = doc.sections[0].code
    const marker = body.find((w) => w.source.trim() === '```')
    expect(marker?.type).toBe('CodeWeft')
    expect(body.some((w) => w.type === 'ArrowWeft')).toBe(true)
    expect(body.some((w) => w.type === 'TildeWeft')).toBe(true)
  })
})
