import { describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import {
  sinkTreeRouting,
  type LoomCorpusAst,
  type LoomModule,
} from '@athrio/loom-ast/LoomCorpusAst'
import { ParseLayer, parseDocument } from './parse'

// `sinkTreeRouting` reads only a module's `path` and parsed `doc`, so a test
// module is a real parsed document with the product left off — the cast names
// exactly that. A higher-order sink — a section whose sink names a directory,
// written `[dir]` — points at a chapter (an H1) through the members in its
// prose, and places that chapter's tangle sinks under its directory. A member
// resolves lexically: a bare `::[Name]` names a section in the sink's own file,
// and `::[Name](path.loom)` names one in the file the path points to. Routing
// maps each module's sink path to the prefix it lands under.

const corpusOf = (
  files: Record<string, string>,
): Effect.Effect<LoomCorpusAst, never, never> =>
  Effect.gen(function* () {
    const entries = yield* Effect.forEach(
      Object.entries(files),
      ([path, text]) =>
        parseDocument(text).pipe(
          Effect.map(
            (doc) =>
              [path, { path, text, doc, imports: [] } as unknown as LoomModule] as const,
          ),
        ),
    )
    return { modules: new Map(entries) }
  }).pipe(Effect.provide(ParseLayer))

// a chapter: an H1 opening it, and a file tangle sink within its range
const widget =
  '# The widget\n\n## The module [src, Widget.ts]\n\n=>\n\nexport const x = 1\n'

describe('Sink tree — placing a chapter under a higher-order sink', () => {
  it.effect('places a chapter sink under the sink directory', () =>
    Effect.gen(function* () {
      const corpus = yield* corpusOf({
        'book.loom':
          '# Book\n\n## Core [packages/core]\n\n~\n\n::[The widget](widget.loom)\n',
        'widget.loom': widget,
      })
      const routing = sinkTreeRouting(corpus)
      expect(routing.get('widget.loom')?.get('src/Widget.ts')).toBe('packages/core')
    }),
  )

  it.effect('a bare member does not cross files', () =>
    Effect.gen(function* () {
      // lexical scope: `::[The widget]` carries no path, so it resolves in
      // book.loom, which has no such section — nothing is placed.
      const corpus = yield* corpusOf({
        'book.loom': '# Book\n\n## Core [packages/core]\n\n~\n\n::[The widget]\n',
        'widget.loom': widget,
      })
      const routing = sinkTreeRouting(corpus)
      expect(routing.get('widget.loom')).toBeUndefined()
    }),
  )

  it.effect('leaves a module no chapter places out of the routing', () =>
    Effect.gen(function* () {
      const corpus = yield* corpusOf({
        'book.loom':
          '# Book\n\n## Core [packages/core]\n\n~\n\n::[The widget](widget.loom)\n',
        'widget.loom': widget,
      })
      const routing = sinkTreeRouting(corpus)
      expect(routing.has('book.loom')).toBe(false)
    }),
  )

  it.effect('accumulates the prefix through nested higher-order sinks', () =>
    Effect.gen(function* () {
      const corpus = yield* corpusOf({
        // `::[Sub]` is local to book.loom; `::[The widget]` crosses to widget.loom
        'book.loom':
          '# Book\n\n## Docs [docs]\n\n~\n\n::[Sub]\n\n## Sub [ast]\n\n~\n\n::[The widget](widget.loom)\n',
        'widget.loom': widget,
      })
      const routing = sinkTreeRouting(corpus)
      expect(routing.get('widget.loom')?.get('src/Widget.ts')).toBe('docs/ast')
    }),
  )

  it.effect('places every tangle sink in a chapter range', () =>
    Effect.gen(function* () {
      const corpus = yield* corpusOf({
        'book.loom':
          '# Book\n\n## Core [packages/core]\n\n~\n\n::[The pair](pair.loom)\n',
        'pair.loom':
          '# The pair\n\n## One [src, one.ts]\n\n=>\n\nexport const a = 1\n\n## Two [src, two.ts]\n\n=>\n\nexport const b = 2\n',
      })
      const routing = sinkTreeRouting(corpus)
      expect(routing.get('pair.loom')?.get('src/one.ts')).toBe('packages/core')
      expect(routing.get('pair.loom')?.get('src/two.ts')).toBe('packages/core')
    }),
  )

  it.effect('ends a chapter range at the next pointed chapter', () =>
    Effect.gen(function* () {
      const corpus = yield* corpusOf({
        'book.loom':
          '# Book\n\n## Core [packages/core]\n\n~\n\n::[First](content.loom)\n\n## Libs [libs]\n\n~\n\n::[Second](content.loom)\n',
        'content.loom':
          '# First\n\n## A [., a.ts]\n\n=>\n\nexport const a = 1\n\n# Second\n\n## B [., b.ts]\n\n=>\n\nexport const b = 2\n',
      })
      const routing = sinkTreeRouting(corpus)
      // First's chapter ends where Second opens, so each sink takes its own prefix
      expect(routing.get('content.loom')?.get('a.ts')).toBe('packages/core')
      expect(routing.get('content.loom')?.get('b.ts')).toBe('libs')
    }),
  )

  it.effect('a cycle among higher-order sinks terminates with no routing', () =>
    Effect.gen(function* () {
      const corpus = yield* corpusOf({
        // A and B are both local to book.loom, so the cycle stays within the file
        'book.loom':
          '# Book\n\n## A [a]\n\n~\n\n::[B]\n\n## B [b]\n\n~\n\n::[A]\n',
      })
      const routing = sinkTreeRouting(corpus)
      expect(routing.size).toBe(0)
    }),
  )
})
