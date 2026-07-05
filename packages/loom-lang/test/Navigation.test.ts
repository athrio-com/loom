import { describe, expect, it as it_ } from 'bun:test'
import { effectify } from '@athrio/effect-test'
const it = effectify(it_)
import { Effect, Layer, Option } from 'effect'
import { DocumentSource, LoomCompiler } from '../src/LoomCompiler'
import { LoomMemo } from '../src/LoomMemo'
import { PackageConfig } from '../src/PackageConfig'
import { defaultAnchorDelims } from '@athrio/loom-ast/LoomTokens'

// The compiler's navigation verbs over an in-memory DocumentSource. `doc` holds
// a tangle sink whose `::[The greeting]` anchor names a section in the same file,
// so definition follows the anchor to that heading and references finds both the
// heading and the anchor. Offsets are taken straight from the source text.

const doc = `---
Language: TypeScript
---

# The greeting

=>

const hi = "hi"

# The bundle {out/bundle.ts}

=>

::[The greeting]
export const out = hi
`

const files: Record<string, string> = { '/doc.loom': doc }

const TestDocs = Layer.succeed(
  DocumentSource,
  {
    read: (path: string) => Effect.succeed(files[path] ?? ''),
    list: Option.some(() => Effect.succeed(Object.keys(files))),
  },
)

const TestConfig = Layer.succeed(
  PackageConfig,
  {
    resolve: () =>
      Effect.succeed({
        delims: defaultAnchorDelims,
        primaryLanguage: undefined,
        packageRoot: undefined,
        workspaceRoot: undefined,
        corpusDir: undefined,
      }),
  },
)

const layer = Layer.provide(
  Layer.merge(LoomCompiler.layer, LoomMemo.layer),
  Layer.merge(TestDocs, TestConfig),
)

const makeLayer = (docs: Record<string, string>) =>
  Layer.provide(
    Layer.merge(LoomCompiler.layer, LoomMemo.layer),
    Layer.merge(
      Layer.succeed(
        DocumentSource,
        {
          read: (path: string) => Effect.succeed(docs[path] ?? ''),
          list: Option.some(() => Effect.succeed(Object.keys(docs))),
        },
      ),
      TestConfig,
    ),
  )

const anchorOffset = doc.indexOf('::[The greeting]') + 4 // inside the anchor name
const titleOffset = doc.indexOf('# The greeting') + 3 // inside the heading title

describe('LoomCompiler — navigation over anchors and sections', () => {
  it.effect('definition jumps from an anchor to the section it names', () =>
    Effect.gen(function* () {
      const c = yield* LoomCompiler
      const target = yield* c.definition('/doc.loom', anchorOffset)
      expect(target?.path).toBe('/doc.loom')
      // "The greeting" heading title — line 4 (0-based), after the "# " marker
      expect(target?.range.start).toEqual({ line: 4, character: 2 })
    }).pipe(Effect.provide(layer)),
  )

  it.effect('references lists the heading and every anchor that names it', () =>
    Effect.gen(function* () {
      const c = yield* LoomCompiler
      const refs = yield* c.references('/doc.loom', titleOffset)
      // the heading on line 4 and the `::[The greeting]` anchor on line 14
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
      // the anchor name span starts after `::[`, so the brackets are left alone
      const anchorEdit = edits.find((e) => e.range.start.line === 14)
      expect(anchorEdit?.range.start.character).toBe(3)
    }).pipe(Effect.provide(layer)),
  )

  it.effect('renameRange covers the whole multi-word title under the cursor', () =>
    Effect.gen(function* () {
      const c = yield* LoomCompiler
      const span = yield* c.renameRange('/doc.loom', titleOffset)
      // "The greeting" — twelve characters, after the "# " marker
      expect(span?.range.start).toEqual({ line: 4, character: 2 })
      expect(span?.range.end).toEqual({ line: 4, character: 14 })
    }).pipe(Effect.provide(layer)),
  )
})

// A book names a chapter in another file with `::[Name](path.loom)`, so the
// editor follows the member across files: definition lands on the named file's
// heading, and references from that heading finds the member back in the book.
describe('LoomCompiler — navigation across files', () => {
  const docs: Record<string, string> = {
    '/book.loom':
      '# Book\n\n## Core [packages/core]\n\n~\n\n::[The widget](widget.loom)\n',
    '/widget.loom':
      '# The widget\n\n## The module [src, Widget.ts]\n\n=>\n\nexport const x = 1\n',
  }
  const crossLayer = makeLayer(docs)
  const memberOffset = docs['/book.loom']!.indexOf('::[The widget]') + 4

  it.effect('definition jumps across files to the named chapter', () =>
    Effect.gen(function* () {
      const c = yield* LoomCompiler
      const target = yield* c.definition('/book.loom', memberOffset)
      expect(target?.path).toBe('/widget.loom')
      // "The widget" heading title on line 0, after the "# " marker
      expect(target?.range.start).toEqual({ line: 0, character: 2 })
    }).pipe(Effect.provide(crossLayer)),
  )

  it.effect('references finds the cross-file member from its chapter heading', () =>
    Effect.gen(function* () {
      const c = yield* LoomCompiler
      const widgetTitleOffset = docs['/widget.loom']!.indexOf('# The widget') + 3
      const refs = yield* c.references('/widget.loom', widgetTitleOffset)
      // the heading in widget.loom and the member back in book.loom
      expect(refs.map((r) => r.path).sort()).toEqual(['/book.loom', '/widget.loom'])
    }).pipe(Effect.provide(crossLayer)),
  )
})

// A value warp defined in a section, named by ::[ratio] anchors in its code. Navigation
// binds them within the section: go-to from an anchor lands on the {{ratio = …}}
// definition, references and rename gather the definition and every anchor, and
// renameRange covers the warp name under the cursor.
describe('LoomCompiler — navigation over value warps', () => {
  const warp = `---
Language: TypeScript
---

# Converting

{{ratio = 1.8}}

=>

export const toF = (c: number) => c * ::[ratio] + 32
export const back = (f: number) => (f - 32) / ::[ratio]
`
  const warpLayer = makeLayer({ '/convert.loom': warp })
  const anchorOffset = warp.indexOf('::[ratio]') + 4 // inside the first anchor's name
  const defOffset = warp.indexOf('{{ratio') + 2 // inside the definition's name

  it.effect('definition jumps from a warp anchor to its definition', () =>
    Effect.gen(function* () {
      const c = yield* LoomCompiler
      const target = yield* c.definition('/convert.loom', anchorOffset)
      expect(target?.path).toBe('/convert.loom')
      // "ratio" in {{ratio = 1.8}} — line 6 (0-based), after the "{{"
      expect(target?.range.start).toEqual({ line: 6, character: 2 })
    }).pipe(Effect.provide(warpLayer)),
  )

  it.effect('references gathers the definition and every anchor', () =>
    Effect.gen(function* () {
      const c = yield* LoomCompiler
      const refs = yield* c.references('/convert.loom', defOffset)
      // the {{ratio}} definition on line 6 and the two ::[ratio] anchors on lines 10, 11
      expect(refs.map((r) => r.range.start.line).sort((a, b) => a - b)).toEqual([
        6, 10, 11,
      ])
    }).pipe(Effect.provide(warpLayer)),
  )

  it.effect('rename rewrites the definition name and every anchor name', () =>
    Effect.gen(function* () {
      const c = yield* LoomCompiler
      const edits = yield* c.rename('/convert.loom', anchorOffset)
      expect(edits.length).toBe(3)
      // each span is the bare name "ratio" — five characters — so {{ }} and ::[ ] stay
      expect(
        edits.every((e) => e.range.end.character - e.range.start.character === 5),
      ).toBe(true)
    }).pipe(Effect.provide(warpLayer)),
  )

  it.effect('renameRange covers the warp name under the cursor', () =>
    Effect.gen(function* () {
      const c = yield* LoomCompiler
      const span = yield* c.renameRange('/convert.loom', defOffset)
      // "ratio" — five characters, after the "{{"
      expect(span?.range.start).toEqual({ line: 6, character: 2 })
      expect(span?.range.end).toEqual({ line: 6, character: 7 })
    }).pipe(Effect.provide(warpLayer)),
  )
})
