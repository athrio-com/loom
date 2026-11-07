import { describe, expect, it } from 'bun:test'
import { Effect, Layer, Option, Schema } from 'effect'
import { defaultAnchorDelims } from '@athrio/loom-ast/LoomTokens'
import { LoomHeadingSchema, type LoomDocument } from '@athrio/loom-ast/LoomAst'
import { okHealth, type Diagnostic } from '@athrio/loom-ast/LoomNode'
import { DocumentSource, LoomCompiler } from '../src/LoomCompiler'
import { WorkspaceSettings } from '../src/WorkspaceSettings'
import { LoomDiskCache } from '../src/LoomDiskCache'
import { FileSystemSource } from '../src/WorkspaceSource'
import { parseDocument, ParseLayer } from './parse'

const lines = (...rows: ReadonlyArray<string>): string => `${rows.join('\n')}\n`

const anchor = (name: string): string => `::${'['}${name}]`

const parse = (src: string): LoomDocument =>
  Effect.runSync(parseDocument(src).pipe(Effect.provide(ParseLayer)))

const titles = (doc: LoomDocument): ReadonlyArray<string | undefined> =>
  doc.sections.map((section) => section.heading.title?.source)

const markers = (doc: LoomDocument): ReadonlyArray<string> =>
  doc.sections.map((section) => section.heading.marker.type)

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

const layerOf = (files: Record<string, string>) =>
  Layer.provide(
    LoomCompiler.layer,
    Layer.mergeAll(
      FileSystemSource,
      LoomDiskCache.none,
      Layer.succeed(DocumentSource, {
        read: (path: string) => Effect.succeed(files[path] ?? ''),
        list: Option.some(() => Effect.succeed(Object.keys(files))),
        hold: () => Effect.void,
        forget: () => Effect.void,
      }),
      Layer.succeed(WorkspaceSettings, {
        manifest: () => Effect.succeed(Option.none()),
        resolve: () =>
          Effect.succeed({
            delims: defaultAnchorDelims,
            primaryLanguage: 'typescript',
            variables: {},
            width: 100,
          }),
      }),
    ),
  )

const compiled = <A, E>(
  files: Record<string, string>,
  use: (compiler: LoomCompiler['Service']) => Effect.Effect<A, E>,
) => Effect.runPromise(LoomCompiler.pipe(Effect.flatMap(use), Effect.provide(layerOf(files))))

describe('a labelled divider', () => {
  const labelled = lines(
    '# Chapter',
    '',
    'The grid is the whole model.',
    '',
    'Drawing the room',
    '---',
    '',
    'The room draws itself one cell at a time.',
    '',
    '## A cell',
  )

  it('ends the section above it and opens a division titled by its label', () => {
    const doc = parse(labelled)
    expect(titles(doc)).toEqual(['Chapter', 'Drawing the room', 'A cell'])
    expect(markers(doc)).toEqual(['HeadingStart', 'Divider', 'HeadingStart'])
  })

  it('takes its label out of the section above', () => {
    const above = parse(labelled).sections[0]!
    const prose = [...above.preamble, ...above.code].map((weft) => weft.source).join('')
    expect(prose).toContain('The grid is the whole model.')
    expect(prose).not.toContain('Drawing the room')
  })

  it('keeps the division its opening prose', () => {
    const division = parse(labelled).sections[1]!
    expect(division.preamble.map((weft) => weft.source).join('')).toContain(
      'The room draws itself one cell at a time.',
    )
  })

  it('reconstructs the source verbatim, and raises no fault', () => {
    const doc = parse(labelled)
    expect(doc.source).toBe(labelled)
    expect(diagnosticsIn(doc)).toEqual([])
  })
})

describe('a bare divider', () => {
  it('stands after a blank line and opens a division with no title', () => {
    const doc = parse(lines('# Chapter', '', 'Before.', '', '---', '', 'After.'))
    expect(titles(doc)).toEqual(['Chapter', undefined])
  })

  it('ends code, as a heading does', () => {
    const doc = parse(lines('# A [a.ts]', '', '=>', 'const a = 1', '', '---', '', 'Prose.'))
    expect(doc.sections).toHaveLength(2)
    expect(doc.sections[0]!.code.map((weft) => weft.source.trim())).toEqual([
      '=>',
      'const a = 1',
      '',
    ])
    expect(diagnosticsIn(doc)).toEqual([])
  })

  it('takes no closing fence above it for a label', () => {
    const doc = parse(lines('# Chapter', '', '```', 'Quoted', '```', '---'))
    expect(titles(doc)).toEqual(['Chapter', undefined])
  })
})

describe('a divider flush under code', () => {
  it('warns that it ends the code there', () => {
    const doc = parse(lines('# A [a.yaml]', '', '=>', 'a: 1', '---', 'b: 2'))
    expect(diagnosticsIn(doc).map((d) => [d.severity, d.message])).toEqual([
      [
        'warning',
        'This divider ends the code above it. If the dashes belong to the code, format the loom to fence it. If the divider divides the chapter, leave a blank line above it.',
      ],
    ])
  })

  it('warns under the arrow itself', () => {
    const doc = parse(lines('# A [a.md]', '', '=>', '---', 'title: A'))
    expect(diagnosticsIn(doc)).toHaveLength(1)
  })
})

describe('dashes that divide nothing', () => {
  it('stay code inside fenced code', () => {
    const doc = parse(lines('# A [a.yaml]', '', '=>', '```', 'a: 1', '---', 'b: 2', '```'))
    expect(doc.sections).toHaveLength(1)
  })

  it('stay quoted inside a fence in prose', () => {
    const doc = parse(lines('# Chapter', '', '```', 'Drawing', '---', '```'))
    expect(doc.sections).toHaveLength(1)
  })

  it('stay inert inside a box', () => {
    const doc = parse(lines('# Chapter', '', ':::', 'Drawing', '---', ':::'))
    expect(doc.sections).toHaveLength(1)
  })

  it('open and close the frontmatter', () => {
    const doc = parse(lines('---', 'Part I, Chapter 1: Rooms', '---', '', '# Rooms'))
    expect(doc.frontmatter?.title?.value).toBe('Rooms')
    expect(doc.sections).toHaveLength(1)
  })

  it('stand in the preamble before the first heading', () => {
    const doc = parse(lines('Before any heading.', '---', '', '# Chapter'))
    expect(titles(doc)).toEqual(['Chapter'])
  })
})

describe('a division found by its label', () => {
  const room = '/corpus/room.loom'
  const files = {
    [room]: lines(
      '# The room [room.ts]',
      '',
      '=>',
      anchor('Drawing the room'),
      '~',
      '',
      'Drawing the room',
      '---',
      '',
      '=>',
      'const draw = () => 1',
    ),
  }

  it('composes the code a labelled division holds, as a section', async () => {
    const tangled = await compiled(files, (compiler) => compiler.tangle(room))
    expect(tangled.map((file) => file.content)).toEqual(['const draw = () => 1\n'])
  })

  it('follows its label from an anchor', async () => {
    const at = files[room]!.indexOf('Drawing the room]') + 1
    const found = await compiled(files, (compiler) => compiler.definition(room, at))
    expect(found?.range.start.line).toBe(6)
  })
})

describe('what a division becomes', () => {
  it('is a heading whose marker is a divider', () => {
    const at = { start: { line: 1, column: 1, offset: 0 }, end: { line: 1, column: 4, offset: 3 } }
    const divider = { type: 'Divider', position: at, source: '---', health: okHealth }
    expect(
      Schema.is(LoomHeadingSchema)({
        type: 'LoomHeading',
        position: at,
        source: '---',
        health: okHealth,
        marker: divider,
      }),
    ).toBe(true)
  })

  it('weaves as a heading of the second level that a divider wrote', async () => {
    const divided = lines(
      '---',
      'Part I, Chapter 1: Rooms',
      'Language: Prose',
      '---',
      '',
      '# Rooms',
      '',
      'The grid is the whole model.',
      '',
      'Drawing the room',
      '---',
      '',
      'The room draws itself.',
    )
    const rooms = '/corpus/rooms.loom'
    const site = await compiled({ [rooms]: divided }, (compiler) => compiler.weave(rooms))
    const headings = site.pages[0]!.blocks.flatMap((b) => (b.type === 'heading' ? [b] : []))
    expect(headings.map((b) => [b.level, b.title, b.divider])).toEqual([
      [1, 'Rooms', false],
      [2, 'Drawing the room', true],
    ])
  })
})
