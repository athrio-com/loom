import { describe, expect, it as it_ } from 'bun:test'
import { effectify } from '@athrio/effect-test'
import { Effect, Layer, Option } from 'effect'
import { DocumentSource, LoomCompiler } from '../src/LoomCompiler'
import { LoomMemo } from '../src/LoomMemo'
import { WorkspaceSettings } from '../src/WorkspaceSettings'
import { LoomDiskCache } from '../src/LoomDiskCache'
import { FileSystemSource } from '../src/WorkspaceSource'
import { defaultAnchorDelims } from '@athrio/loom-ast/LoomTokens'

const it = effectify(it_)

const lines = (...rows: ReadonlyArray<string>): string => `${rows.join('\n')}\n`

const anchor = (name: string): string => `::${'['}${name}]`

const doc = lines(
  '---',
  'Language: TypeScript',
  '---',
  '',
  '# The greeting',
  '',
  '=>',
  '',
  'const hi = "hi"',
  '',
  '# The bundle {out/bundle.ts}',
  '',
  '=>',
  '',
  anchor('The greeting'),
  'export const out = hi',
)

const files: Record<string, string> = { '/doc.loom': doc }

const anchorOffset = doc.indexOf(anchor('The greeting')) + 4
const titleOffset = doc.indexOf('# The greeting') + 3

const TestDocs = Layer.succeed(DocumentSource, {
  read: (path: string) => Effect.succeed(files[path] ?? ''),
  list: Option.some(() => Effect.succeed(Object.keys(files))),
  hold: () => Effect.void,
  forget: () => Effect.void,
})

const TestConfig = Layer.succeed(WorkspaceSettings, {
  manifest: () => Effect.succeed(Option.none()),
  resolve: () =>
    Effect.succeed({
      delims: defaultAnchorDelims,
      primaryLanguage: undefined,
      variables: {},
      width: 100,
    }),
})

const layer = Layer.provide(
  Layer.merge(LoomCompiler.layer, LoomMemo.layer),
  Layer.mergeAll(TestDocs, TestConfig, FileSystemSource, LoomDiskCache.none),
)

const makeLayer = (docs: Record<string, string>) =>
  Layer.provide(
    Layer.merge(LoomCompiler.layer, LoomMemo.layer),
    Layer.mergeAll(
      FileSystemSource,
      LoomDiskCache.none,
      Layer.succeed(DocumentSource, {
        read: (path: string) => Effect.succeed(docs[path] ?? ''),
        list: Option.some(() => Effect.succeed(Object.keys(docs))),
        hold: () => Effect.void,
        forget: () => Effect.void,
      }),
      TestConfig,
    ),
  )

describe('LoomCompiler — navigation over anchors and sections', () => {
  it.effect('definition jumps from an anchor to the section it names', () =>
    Effect.gen(function* () {
      const c = yield* LoomCompiler
      const target = yield* c.definition('/doc.loom', anchorOffset)
      expect(target?.path).toBe('/doc.loom')
      expect(target?.range.start).toEqual({ line: 4, character: 2 })
    }).pipe(Effect.provide(layer)),
  )

  it.effect('references lists the heading and every anchor that names it', () =>
    Effect.gen(function* () {
      const c = yield* LoomCompiler
      const refs = yield* c.references('/doc.loom', titleOffset)
      expect(refs.map((r) => r.range.start.line).sort((a, b) => a - b)).toEqual([4, 14])
    }).pipe(Effect.provide(layer)),
  )

  it.effect('definition finds nothing under a position that is not an anchor', () =>
    Effect.gen(function* () {
      const c = yield* LoomCompiler
      const target = yield* c.definition('/doc.loom', doc.indexOf('const hi'))
      expect(target).toBeUndefined()
    }).pipe(Effect.provide(layer)),
  )

  it.effect('rename gathers the heading title and every anchor name', () =>
    Effect.gen(function* () {
      const c = yield* LoomCompiler
      const edits = yield* c.rename('/doc.loom', titleOffset)
      expect(edits.map((e) => e.range.start.line).sort((a, b) => a - b)).toEqual([4, 14])
      const anchorEdit = edits.find((e) => e.range.start.line === 14)
      expect(anchorEdit?.range.start.character).toBe(3)
    }).pipe(Effect.provide(layer)),
  )

  it.effect('renameRange covers the whole multi-word title under the cursor', () =>
    Effect.gen(function* () {
      const c = yield* LoomCompiler
      const span = yield* c.renameRange('/doc.loom', titleOffset)
      expect(span?.range.start).toEqual({ line: 4, character: 2 })
      expect(span?.range.end).toEqual({ line: 4, character: 14 })
    }).pipe(Effect.provide(layer)),
  )
})

describe('LoomCompiler — navigation across files', () => {
  const docs: Record<string, string> = {
    '/book.loom': lines(
      '# Book',
      '',
      '## Core [packages/core]',
      '',
      '~',
      '',
      `${anchor('The widget')}(widget.loom)`,
    ),
    '/widget.loom':
      '# The widget\n\n## The module [src, Widget.ts]\n\n=>\n\nexport const x = 1\n',
  }
  const crossLayer = makeLayer(docs)
  const memberOffset = docs['/book.loom']!.indexOf(anchor('The widget')) + 4

  it.effect('definition jumps across files to the named chapter', () =>
    Effect.gen(function* () {
      const c = yield* LoomCompiler
      const target = yield* c.definition('/book.loom', memberOffset)
      expect(target?.path).toBe('/widget.loom')
      expect(target?.range.start).toEqual({ line: 0, character: 2 })
    }).pipe(Effect.provide(crossLayer)),
  )

  it.effect('references finds the cross-file member from its chapter heading', () =>
    Effect.gen(function* () {
      const c = yield* LoomCompiler
      const widgetTitleOffset = docs['/widget.loom']!.indexOf('# The widget') + 3
      const refs = yield* c.references('/widget.loom', widgetTitleOffset)
      expect(refs.map((r) => r.path).sort()).toEqual(['/book.loom', '/widget.loom'])
    }).pipe(Effect.provide(crossLayer)),
  )
})

describe('LoomCompiler — navigation along a path', () => {
  const docs: Record<string, string> = {
    '/words.loom': lines(
      '---',
      'Part I, Chapter 2: Words',
      '---',
      '',
      '# Words',
      '',
      'What the program says.',
      '',
      '## Saying hello',
      '',
      '=>',
      '',
      'const hi = "hi"',
    ),
    '/caller.loom': lines(
      '# Caller',
      '',
      '=>',
      '',
      anchor('Words, Saying hello'),
      'export const out = hi',
    ),
  }
  const pathLayer = makeLayer(docs)
  const nameStart = docs['/caller.loom']!.indexOf(anchor('Words, Saying hello')) + 3
  const wordsOffset = nameStart + 2
  const sectionOffset = nameStart + 9
  const spanOf = (location: { readonly path: string; readonly range: unknown }) =>
    JSON.stringify(location)

  it.effect('definition follows the name of the path under the cursor', () =>
    Effect.gen(function* () {
      const c = yield* LoomCompiler
      const chapter = yield* c.definition('/caller.loom', wordsOffset)
      expect(chapter?.path).toBe('/words.loom')
      expect(chapter?.range.start).toEqual({ line: 1, character: 19 })
      const section = yield* c.definition('/caller.loom', sectionOffset)
      expect(section?.path).toBe('/words.loom')
      expect(section?.range.start).toEqual({ line: 8, character: 3 })
    }).pipe(Effect.provide(pathLayer)),
  )

  it.effect('rename edits only the name of the path that names the renamed thing', () =>
    Effect.gen(function* () {
      const c = yield* LoomCompiler
      const words = docs['/words.loom']!
      const section = yield* c.rename('/words.loom', words.indexOf('## Saying hello') + 5)
      expect(section.map(spanOf).sort()).toEqual(
        [
          {
            path: '/caller.loom',
            range: { start: { line: 4, character: 10 }, end: { line: 4, character: 22 } },
          },
          {
            path: '/words.loom',
            range: { start: { line: 8, character: 3 }, end: { line: 8, character: 15 } },
          },
        ]
          .map(spanOf)
          .sort(),
      )
      const chapter = yield* c.rename('/words.loom', words.indexOf('Words') + 1)
      expect(chapter.map(spanOf).sort()).toEqual(
        [
          {
            path: '/caller.loom',
            range: { start: { line: 4, character: 3 }, end: { line: 4, character: 8 } },
          },
          {
            path: '/words.loom',
            range: { start: { line: 1, character: 19 }, end: { line: 1, character: 24 } },
          },
        ]
          .map(spanOf)
          .sort(),
      )
    }).pipe(Effect.provide(pathLayer)),
  )
})

describe('LoomCompiler — renumbering a chapter', () => {
  const words = lines(
    '---',
    'Part I, Chapter 2: Words',
    '---',
    '',
    '# Words',
    '',
    'What the program says.',
    '',
    '## Saying hello',
    '',
    '=>',
    '',
    'const hi = "hi"',
  )
  const numbered = lines(
    '# Numbered',
    '',
    '=>',
    '',
    anchor('Chapter 2, Saying hello'),
    anchor('Words, Saying hello'),
  )
  const numberLayer = makeLayer({ '/words.loom': words, '/numbered.loom': numbered })
  const spans = (locations: ReadonlyArray<{ readonly path: string; readonly range: unknown }>) =>
    locations.map((location) => JSON.stringify(location)).sort()
  const span = (path: string, line: number, from: number, to: number) => ({
    path,
    range: { start: { line, character: from }, end: { line, character: to } },
  })

  it.effect('renumbering rewrites the numbered names, and retitling the titled ones', () =>
    Effect.gen(function* () {
      const c = yield* LoomCompiler
      const renumbered = [span('/numbered.loom', 4, 3, 12), span('/words.loom', 1, 8, 17)].map(
        (location) => JSON.stringify(location),
      )
      expect(spans(yield* c.rename('/words.loom', words.indexOf('Chapter 2') + 2))).toEqual(
        renumbered.sort(),
      )
      expect(spans(yield* c.rename('/numbered.loom', numbered.indexOf('Chapter 2') + 2))).toEqual(
        renumbered.sort(),
      )
      expect(spans(yield* c.rename('/words.loom', words.indexOf('Words') + 1))).toEqual(
        [span('/numbered.loom', 5, 3, 8), span('/words.loom', 1, 19, 24)]
          .map((location) => JSON.stringify(location))
          .sort(),
      )
    }).pipe(Effect.provide(numberLayer)),
  )

  it.effect('hints show the title beside each number', () =>
    Effect.gen(function* () {
      const c = yield* LoomCompiler
      expect(yield* c.hints('/numbered.loom')).toEqual([
        { position: { line: 4, character: 12 }, label: 'Words' },
      ])
    }).pipe(Effect.provide(numberLayer)),
  )
})

describe('LoomCompiler — navigation over value warps', () => {
  const warp = lines(
    '---',
    'Language: TypeScript',
    '---',
    '',
    '# Converting',
    '',
    '{{ratio = 1.8}}',
    '',
    '=>',
    '',
    `export const toF = (c: number) => c * ${anchor('ratio')} + 32`,
    `export const back = (f: number) => (f - 32) / ${anchor('ratio')}`,
  )
  const warpLayer = makeLayer({ '/convert.loom': warp })
  const anchorOffset = warp.indexOf(anchor('ratio')) + 4
  const defOffset = warp.indexOf('{{ratio') + 2

  it.effect('definition jumps from a warp anchor to its definition', () =>
    Effect.gen(function* () {
      const c = yield* LoomCompiler
      const target = yield* c.definition('/convert.loom', anchorOffset)
      expect(target?.path).toBe('/convert.loom')
      expect(target?.range.start).toEqual({ line: 6, character: 2 })
    }).pipe(Effect.provide(warpLayer)),
  )

  it.effect('references gathers the definition and every anchor', () =>
    Effect.gen(function* () {
      const c = yield* LoomCompiler
      const refs = yield* c.references('/convert.loom', defOffset)
      expect(refs.map((r) => r.range.start.line).sort((a, b) => a - b)).toEqual([6, 10, 11])
    }).pipe(Effect.provide(warpLayer)),
  )

  it.effect('rename rewrites the definition name and every anchor name', () =>
    Effect.gen(function* () {
      const c = yield* LoomCompiler
      const edits = yield* c.rename('/convert.loom', anchorOffset)
      expect(edits.length).toBe(3)
      expect(edits.every((e) => e.range.end.character - e.range.start.character === 5)).toBe(
        true,
      )
    }).pipe(Effect.provide(warpLayer)),
  )

  it.effect('renameRange covers the warp name under the cursor', () =>
    Effect.gen(function* () {
      const c = yield* LoomCompiler
      const span = yield* c.renameRange('/convert.loom', defOffset)
      expect(span?.range.start).toEqual({ line: 6, character: 2 })
      expect(span?.range.end).toEqual({ line: 6, character: 7 })
    }).pipe(Effect.provide(warpLayer)),
  )
})
