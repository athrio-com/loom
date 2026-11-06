import { describe, expect, it } from 'bun:test'
import { Array, Effect, Layer, Option } from 'effect'
import type { Diagnostic } from '@athrio/loom-ast/LoomNode'
import type { LoomDocument } from '@athrio/loom-ast/LoomAst'
import { boxKind, type BoxToken } from '@athrio/loom-ast/LoomTokens'
import { boxOf, type LoomWeft } from '@athrio/loom-ast/Weft'
import { LoomCorpusAstBuilder } from '#ast/LoomCorpusAstBuilder'
import { WeaveBuilder } from '../src/weave/WeaveBuilder'
import { parseDocument, ParseLayer } from './parse'

const lines = (...rows: ReadonlyArray<string>): string => `${rows.join('\n')}\n`

const anchor = (name: string): string => `::${'['}${name}]`

const parse = (src: string): LoomDocument =>
  Effect.runSync(parseDocument(src).pipe(Effect.provide(ParseLayer)))

const wefts = (doc: LoomDocument): ReadonlyArray<LoomWeft> => [
  ...doc.preamble,
  ...Array.flatMap(doc.sections, (section) => [...section.preamble, ...section.code]),
]

const boxes = (doc: LoomDocument): ReadonlyArray<BoxToken> =>
  Array.getSomes(Array.map(wefts(doc), boxOf))

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

const woven = (path: string, text: string) =>
  Effect.runSync(
    Effect.gen(function* () {
      const builder = yield* LoomCorpusAstBuilder
      const module = yield* builder.build(
        { read: () => Effect.succeed(text), list: Option.none() },
        path,
      )
      const weaver = yield* WeaveBuilder
      return yield* weaver.build({ modules: new Map([[path, module]]) })
    }).pipe(Effect.provide(Layer.mergeAll(LoomCorpusAstBuilder.layer, WeaveBuilder.layer))),
  )

describe('a note', () => {
  const note = lines(
    '# Chapter',
    '',
    'Before the note.',
    '',
    ':::',
    '# Not a heading',
    '=>',
    'Not code either.',
    ':::',
    '',
    'After the note.',
  )

  it('opens with three colons alone and closes with three more', () => {
    expect(boxes(parse(note)).map((box) => box.side)).toEqual(['open', 'close'])
  })

  it('keeps its body inert, so a heading or an arrow inside it opens nothing', () => {
    const doc = parse(note)
    expect(doc.sections).toHaveLength(1)
    expect(doc.sections[0]!.code.some((w) => w.type === 'ArrowWeft')).toBe(false)
  })

  it('is a note, with no name', () => {
    const [open] = boxes(parse(note))
    expect(boxKind(open!)).toBe('Note')
    expect(open!.name).toBeUndefined()
  })

  it('raises no fault, and reconstructs the source verbatim', () => {
    const doc = parse(note)
    expect(diagnosticsIn(doc)).toEqual([])
    expect(doc.source).toBe(note)
  })

  it('opens in the document preamble too', () => {
    const doc = parse(lines(':::', 'A remark before any heading.', ':::', '', '# Chapter'))
    expect(boxes(doc).map((box) => box.side)).toEqual(['open', 'close'])
  })
})

describe('an opening line', () => {
  const opener = (line: string): BoxToken =>
    boxes(parse(lines('# Chapter', '', line, 'Body.', ':::')))[0]!

  it('reads its name and its kind from a label', () => {
    const box = opener('::: Why a grid {Note}')
    expect(box.name?.value).toBe('Why a grid')
    expect(box.specifier?.type).toBe('Specifier')
    expect(boxKind(box)).toBe('Note')
  })

  it('reads its kind from a parameter, in any case of letters', () => {
    const box = opener('::: Why a grid {kind=note}')
    expect(box.specifier?.type).toBe('Parameters')
    expect(boxKind(box)).toBe('Note')
  })

  it('keeps braces that do not end the line in its name', () => {
    const box = opener('::: Why {x} matters')
    expect(box.name?.value).toBe('Why {x} matters')
    expect(box.specifier).toBeUndefined()
  })

  it('opens a box with braces and no name', () => {
    const box = opener('::: {Note}')
    expect(box.name).toBeUndefined()
    expect(boxKind(box)).toBe('Note')
  })

  it('places its name on the text it names', () => {
    const src = lines('# Chapter', '', '::: Why a grid {Note}', 'Body.', ':::')
    const box = boxes(parse(src))[0]!
    const name = Option.getOrThrow(Option.fromNullishOr(box.name))
    expect(src.slice(name.position.start.offset, name.position.end.offset)).toBe('Why a grid')
  })
})

describe('the braces on a box', () => {
  const faults = (line: string): ReadonlyArray<string> =>
    diagnosticsIn(parse(lines('# Chapter', '', line, 'Body.', ':::'))).map((d) => d.message)

  it('leave a kind for the book to judge', () => {
    expect(faults('::: Cells {Mermaid}')).toEqual([])
  })

  it('fault a key a box does not take', () => {
    expect(faults('::: Cells {kind=Note width=480}')).toEqual([
      'Unknown key: a box takes no `width` key. It takes `kind`.',
    ])
  })

  it('leave an anchor its own keys and kinds', () => {
    const found = diagnosticsIn(
      parse(
        lines(
          '# Chapter',
          '',
          '=>',
          '',
          `${anchor('Greeting')}{Mermaid}`,
          '',
          '## Greeting',
          '',
          '=>',
          '',
          'x',
        ),
      ),
    ).map((d) => d.message)
    expect(found).toContain(
      'Unknown kind: an anchor takes no kind `Mermaid`. It takes `To be settled` and `Reference`.',
    )
  })
})

describe('a stray line of colons', () => {
  it('faults three colons that would open a box inside another', () => {
    const doc = parse(lines('# Chapter', '', '::: Outer', '::: Inner', ':::', '', 'After.'))
    expect(boxes(doc).map((box) => box.side)).toEqual(['open', 'stray', 'close'])
    expect(diagnosticsIn(doc).map((d) => d.message)).toEqual([
      'Box inside a box: a box never holds another, so this line opens nothing. Close the open box with `:::` on a line of its own, then open this one.',
    ])
  })

  it('faults a run of four or more colons, with a fix that writes three', () => {
    const doc = parse(lines('# Chapter', '', '::::', 'Prose.'))
    expect(boxes(doc).map((box) => box.side)).toEqual(['stray'])
    const [fault] = diagnosticsIn(doc)
    expect(fault!.message).toBe(
      'Too many colons: a box line starts with three colons, so `::::` opens and closes nothing. Write `:::`.',
    )
    expect(fault!.fixes).toEqual([{ title: 'Write `:::`', text: ':::' }])
  })
})

describe('a box that never closes', () => {
  it('faults its opening line, and swallows the headings after it', () => {
    const doc = parse(lines('# Chapter', '', '::: Open', 'Body.', '', '# Swallowed'))
    expect(doc.sections).toHaveLength(1)
    expect(diagnosticsIn(doc).map((d) => d.message)).toEqual([
      'Unclosed box: this box runs to the end of the loom, because nothing closes it. Close it with `:::` on a line of its own.',
    ])
  })
})

describe('colons that are no box line', () => {
  it('stay quoted inside a fence in prose', () => {
    const doc = parse(lines('# Chapter', '', '```', '::: Quoted {Note}', ':::', '```'))
    expect(boxes(doc)).toEqual([])
  })

  it('stay code after an arrow', () => {
    const doc = parse(lines('# Chapter', '', '=>', '', ':::', 'x'))
    expect(boxes(doc)).toEqual([])
  })

  it('open no quote inside a box', () => {
    const doc = parse(lines('# Chapter', '', ':::', '```', ':::', '', '# Next'))
    expect(boxes(doc).map((box) => box.side)).toEqual(['open', 'close'])
    expect(doc.sections).toHaveLength(2)
  })

  it('leave the anchors after a fence inside a box live', () => {
    const doc = parse(
      lines(
        '# Chapter',
        '',
        ':::',
        '```',
        `A link to ${anchor('Next')}.`,
        ':::',
        '',
        `See ${anchor('Next')}.`,
        '',
        '# Next',
      ),
    )
    const names = Array.flatMap(wefts(doc), (weft) =>
      'anchors' in weft ? weft.anchors.map((found) => found.name.value) : [],
    )
    expect(names).toEqual(['Next', 'Next'])
  })
})

describe('a box on the woven page', () => {
  it('leaves a box of another kind in the prose around it', () => {
    const boxed = lines(
      '---',
      'Part I, Chapter 1: A greeting',
      'Language: Prose',
      '---',
      '',
      '# A greeting',
      '',
      'Before.',
      '::: Cells {Mermaid}',
      'flowchart LR',
      ':::',
      'After.',
    )
    const page = woven('/corpus/boxed.loom', boxed).pages[0]!
    expect(page.blocks.filter((b) => b.type === 'note')).toEqual([])
    const prose = page.blocks.flatMap((b) => (b.type === 'prose' ? [b.markdown] : []))
    expect(prose).toEqual(['Before.\n::: Cells {Mermaid}\nflowchart LR\n:::\nAfter.'])
  })
})
