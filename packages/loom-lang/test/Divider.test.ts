import { describe, expect, it } from 'bun:test'
import { Effect, Layer, Option } from 'effect'
import { defaultAnchorDelims } from '@athrio/loom-ast/LoomTokens'
import { DocumentSource, LoomCompiler } from '../src/LoomCompiler'
import { WorkspaceSettings } from '../src/WorkspaceSettings'
import { LoomDiskCache } from '../src/LoomDiskCache'
import { FileSystemSource } from '../src/WorkspaceSource'
import type { Diagnostic } from '@athrio/loom-ast/LoomNode'
import type { LoomDocument } from '@athrio/loom-ast/LoomAst'
import { parseDocument, ParseLayer } from './parse'

// A divider is a line of three or more dashes past a loom's first heading. It ends
// the section above it and opens a division, a section whose heading is the
// divider. The line of prose directly above the divider labels the division and
// becomes its title; a divider after a blank line stands bare. A divider flush under
// a line of code warns, since such dashes most likely belong to the code.
const parse = (src: string): LoomDocument =>
  Effect.runSync(parseDocument(src).pipe(Effect.provide(ParseLayer)))

const lines = (...ls: ReadonlyArray<string>): string => ls.join('\n') + '\n'

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
    ...Object.entries(node).flatMap(([key, value]) => (key === 'health' ? [] : diagnosticsIn(value))),
  ]
}

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
    expect(doc.sections[0]!.code.map((weft) => weft.source.trim())).toEqual(['=>', 'const a = 1', ''])
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
        'This divider sits directly under a line of code, so it ends the code here. Format the loom to fence the code, which keeps the dashes in it. If the divider divides the chapter, leave a blank line above it.',
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

  const room = '/corpus/room.loom'
  const files = {
    [room]: lines(
      '# The room [room.ts]',
      '',
      '=>',
      `::${'['}Drawing the room]`,
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
    const tangled = await Effect.runPromise(
      LoomCompiler.pipe(
        Effect.flatMap((compiler) => compiler.tangle(room)),
        Effect.provide(layerOf(files)),
      ),
    )
    expect(tangled.map((file) => file.content)).toEqual(['const draw = () => 1\n'])
  })

  it('follows its label from an anchor', async () => {
    const at = files[room]!.indexOf('Drawing the room]') + 1
    const found = await Effect.runPromise(
      LoomCompiler.pipe(
        Effect.flatMap((compiler) => compiler.definition(room, at)),
        Effect.provide(layerOf(files)),
      ),
    )
    expect(found?.range.start.line).toBe(6)
  })
})
