import { describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import {
  sinkTreeRouting,
  type LoomCorpusAst,
  type LoomModule,
} from '@athrio/loom-ast/LoomCorpusAst'
import { ParseLayer, parseDocument } from './parse'

// `sinkTreeRouting` reads only a module's `path` and parsed `doc`, so a test
// module is a real parsed document with the frame/product left off — the cast
// names exactly that. `corpusOf` parses each file and assembles the map the
// query walks.

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

const widget = '# The widget\n\n## The module {src/Widget.ts}\n\n=>\n\nexport const x = 1\n'

describe('Sink tree — routing modules under higher-order sinks', () => {
  it.effect('routes a member chapter under its sink directory', () =>
    Effect.gen(function* () {
      const corpus = yield* corpusOf({
        'book.loom': '# Book\n\n## Core {packages/core/}\n\n=>\n\n::[The widget]\n',
        'widget.loom': widget,
      })
      const routing = sinkTreeRouting(corpus)
      expect(routing.get('widget.loom')).toBe('packages/core/')
    }),
  )

  it.effect('leaves a module no sink reaches out of the routing', () =>
    Effect.gen(function* () {
      const corpus = yield* corpusOf({
        'book.loom': '# Book\n\n## Core {packages/core/}\n\n=>\n\n::[The widget]\n',
        'widget.loom': widget,
      })
      const routing = sinkTreeRouting(corpus)
      expect(routing.has('book.loom')).toBe(false)
    }),
  )

  it.effect('accumulates the prefix through nested higher-order sinks', () =>
    Effect.gen(function* () {
      const corpus = yield* corpusOf({
        'book.loom':
          '# Book\n\n## Docs {docs/}\n\n=>\n\n::[Sub]\n\n## Sub {ast/}\n\n=>\n\n::[The widget]\n',
        'widget.loom': widget,
      })
      const routing = sinkTreeRouting(corpus)
      expect(routing.get('widget.loom')).toBe('docs/ast/')
    }),
  )

  it.effect('a member that names its own directory reroutes there', () =>
    Effect.gen(function* () {
      const corpus = yield* corpusOf({
        'book.loom':
          '# Book\n\n## Core {packages/core/}\n\n=>\n\n::[The widget]{libs/special/}\n',
        'widget.loom': widget,
      })
      const routing = sinkTreeRouting(corpus)
      expect(routing.get('widget.loom')).toBe('libs/special/')
    }),
  )

  it.effect('a cycle among sinks terminates rather than looping', () =>
    Effect.gen(function* () {
      const corpus = yield* corpusOf({
        'book.loom':
          '# Book\n\n## R {r/}\n\n=>\n\n::[A]\n\n## A {a/}\n\n=>\n\n::[B]\n\n## B {b/}\n\n=>\n\n::[A]\n',
      })
      const routing = sinkTreeRouting(corpus)
      expect(routing.size).toBe(0)
    }),
  )
})
