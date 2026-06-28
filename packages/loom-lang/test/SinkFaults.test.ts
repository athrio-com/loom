import { describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import {
  sinkTreeFaults,
  type LoomCorpusAst,
  type LoomModule,
} from '@athrio/loom-ast/LoomCorpusAst'
import { normaliseTitle } from '../src/ast/WeftTokeniser'
import { ParseLayer, parseDocument } from './parse'

// `sinkTreeFaults` reads a module's parsed `doc` alone, so a test module is a
// real parsed document with the frame/product left off — the cast names exactly
// that. The detector takes `normaliseTitle` so the whole corpus folds titles by
// one rule; here it is the real one.

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

describe('Sink tree — faults the detector raises', () => {
  it.effect('flags two titles that fold to one name', () =>
    Effect.gen(function* () {
      const corpus = yield* corpusOf({
        'a.loom': '# The widget\n\n=>\n\nexport const a = 1\n',
        'b.loom': '# the widget\n\n=>\n\nexport const b = 2\n',
      })
      const found = sinkTreeFaults(corpus, normaliseTitle).filter(
        (f) => f.kind === 'CollidingTitles',
      )
      expect(found.length).toBe(2)
      expect(found.every((f) => f.kind === 'CollidingTitles' && f.name === 'TheWidget')).toBe(
        true,
      )
    }),
  )

  it.effect('flags each higher-order sink that reaches itself', () =>
    Effect.gen(function* () {
      const corpus = yield* corpusOf({
        'book.loom':
          '# Book\n\n## R {r/}\n\n=>\n\n::[A]\n\n## A {a/}\n\n=>\n\n::[B]\n\n## B {b/}\n\n=>\n\n::[A]\n',
      })
      const cycles = sinkTreeFaults(corpus, normaliseTitle).filter(
        (f) => f.kind === 'SinkCycle',
      )
      const names = cycles.flatMap((f) => (f.kind === 'SinkCycle' ? [f.name] : []))
      expect(names.sort()).toEqual(['A', 'B'])
    }),
  )

  it.effect('flags a higher-order sink with no members', () =>
    Effect.gen(function* () {
      const corpus = yield* corpusOf({
        'book.loom': '# Book\n\n## Solo {solo/}\n\n=>\n\nconst nothing = true\n',
      })
      const empties = sinkTreeFaults(corpus, normaliseTitle).filter(
        (f) => f.kind === 'EmptySink',
      )
      expect(empties.length).toBe(1)
      expect(empties[0]?.kind === 'EmptySink' && empties[0].directory).toBe('solo/')
    }),
  )

  it.effect('flags a member rerouted to an undeclared directory', () =>
    Effect.gen(function* () {
      const corpus = yield* corpusOf({
        'book.loom':
          '# Book\n\n## Core {packages/core/}\n\n=>\n\n::[The widget]{libs/special/}\n',
        'widget.loom': widget,
      })
      const reroutes = sinkTreeFaults(corpus, normaliseTitle).filter(
        (f) => f.kind === 'UnresolvedReroute',
      )
      expect(reroutes.length).toBe(1)
      expect(
        reroutes[0]?.kind === 'UnresolvedReroute' && reroutes[0].directory,
      ).toBe('libs/special/')
    }),
  )

  it.effect('flags a specifier on an anchor outside a higher-order sink', () =>
    Effect.gen(function* () {
      const corpus = yield* corpusOf({
        'a.loom': '# Plain\n\n=>\n\n::[The widget]{out.ts}\n',
        'widget.loom': widget,
      })
      const misplaced = sinkTreeFaults(corpus, normaliseTitle).filter(
        (f) => f.kind === 'MisplacedSpecifier',
      )
      expect(misplaced.length).toBe(1)
      expect(
        misplaced[0]?.kind === 'MisplacedSpecifier' && misplaced[0].specifier,
      ).toBe('out.ts')
    }),
  )

  it.effect('flags a higher-order sink that routes its own module', () =>
    Effect.gen(function* () {
      const corpus = yield* corpusOf({
        'book.loom':
          '# Book\n\n## Core {packages/core/}\n\n=>\n\n::[Inline]\n\n# Inline {src/x.ts}\n\n=>\n\nexport const x = 1\n',
      })
      const self = sinkTreeFaults(corpus, normaliseTitle).filter(
        (f) => f.kind === 'SelfRoutingSink',
      )
      expect(self.length).toBe(1)
      expect(self[0]?.kind === 'SelfRoutingSink' && self[0].name).toBe('Inline')
    }),
  )

  it.effect('flags a member whose module tangles no file', () =>
    Effect.gen(function* () {
      const corpus = yield* corpusOf({
        'book.loom': '# Book\n\n## Core {packages/core/}\n\n=>\n\n::[Prose chapter]\n',
        'prose.loom': '# Prose chapter\n\n=>\n\nexport const note = 1\n',
      })
      const sinkless = sinkTreeFaults(corpus, normaliseTitle).filter(
        (f) => f.kind === 'SinklessMember',
      )
      expect(sinkless.length).toBe(1)
      expect(sinkless[0]?.kind === 'SinklessMember' && sinkless[0].name).toBe(
        'Prose chapter',
      )
    }),
  )

  it.effect('a well-formed book raises no sink fault', () =>
    Effect.gen(function* () {
      const corpus = yield* corpusOf({
        'book.loom': '# Book\n\n## Core {packages/core/}\n\n=>\n\n::[The widget]\n',
        'widget.loom': widget,
      })
      expect(sinkTreeFaults(corpus, normaliseTitle)).toEqual([])
    }),
  )
})
