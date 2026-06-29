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
// real parsed document with the frame/product left off. The detector takes
// `normaliseTitle` so the whole corpus folds titles by one rule; here it is the
// real one. Each test names a corpus that trips one sink fault and filters to
// its kind.

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

const widget =
  '# The widget\n\n## The module [src, Widget.ts]\n\n=>\n\nexport const x = 1\n'

const of = (corpus: LoomCorpusAst, kind: string) =>
  sinkTreeFaults(corpus, normaliseTitle).filter((f) => f.kind === kind)

describe('Sink tree — faults the detector raises', () => {
  it.effect('flags two titles that fold to one name', () =>
    Effect.gen(function* () {
      const corpus = yield* corpusOf({
        'a.loom': '# The widget\n\n=>\n\nexport const a = 1\n',
        'b.loom': '# the widget\n\n=>\n\nexport const b = 2\n',
      })
      const found = of(corpus, 'CollidingTitles')
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
          '# Book\n\n## R [r]\n\n~\n\n::[A]\n\n## A [a]\n\n~\n\n::[B]\n\n## B [b]\n\n~\n\n::[A]\n',
      })
      const names = of(corpus, 'SinkCycle').flatMap((f) =>
        f.kind === 'SinkCycle' ? [f.name] : [],
      )
      expect(names.sort()).toEqual(['A', 'B'])
    }),
  )

  it.effect('flags a higher-order sink with no members', () =>
    Effect.gen(function* () {
      const corpus = yield* corpusOf({
        'book.loom': '# Book\n\n## Solo [solo]\n\n=>\n\nconst nothing = true\n',
      })
      const found = of(corpus, 'EmptySink')
      expect(found.length).toBe(1)
      expect(found[0]?.kind === 'EmptySink' && found[0].directory).toBe('solo')
    }),
  )

  it.effect('flags a specifier worn by an anchor', () =>
    Effect.gen(function* () {
      const corpus = yield* corpusOf({
        'a.loom': '# Plain\n\n=>\n\n::[The widget][out.ts]\n',
        'widget.loom': widget,
      })
      const found = of(corpus, 'MisplacedSpecifier')
      expect(found.length).toBe(1)
      expect(found[0]?.kind === 'MisplacedSpecifier' && found[0].specifier).toBe('out.ts')
    }),
  )

  it.effect('flags a book that points a chapter into its own file', () =>
    Effect.gen(function* () {
      const corpus = yield* corpusOf({
        'book.loom':
          '# Book\n\n## Core [packages/core]\n\n~\n\n::[Inline]\n\n# Inline [src, x.ts]\n\n=>\n\nexport const x = 1\n',
      })
      const found = of(corpus, 'SelfRoutingSink')
      expect(found.length).toBe(1)
      expect(found[0]?.kind === 'SelfRoutingSink' && found[0].name).toBe('Inline')
    }),
  )

  it.effect('flags a chapter whose range tangles no file', () =>
    Effect.gen(function* () {
      const corpus = yield* corpusOf({
        'book.loom': '# Book\n\n## Core [packages/core]\n\n~\n\n::[Prose chapter]\n',
        'prose.loom': '# Prose chapter\n\n=>\n\nexport const note = 1\n',
      })
      const found = of(corpus, 'SinklessChapter')
      expect(found.length).toBe(1)
      expect(found[0]?.kind === 'SinklessChapter' && found[0].name).toBe('Prose chapter')
    }),
  )

  it.effect('flags a chapter opened below a top-level heading', () =>
    Effect.gen(function* () {
      const corpus = yield* corpusOf({
        'book.loom': '# Book\n\n## Core [packages/core]\n\n~\n\n::[Sub thing]\n',
        'content.loom': '## Sub thing [., x.ts]\n\n=>\n\nexport const y = 1\n',
      })
      const found = of(corpus, 'PointedNotH1')
      expect(found.length).toBe(1)
      expect(found[0]?.kind === 'PointedNotH1' && found[0].name).toBe('Sub thing')
    }),
  )

  it.effect('flags a first chapter that strands a module opening', () =>
    Effect.gen(function* () {
      const corpus = yield* corpusOf({
        'book.loom': '# Book\n\n## Core [packages/core]\n\n~\n\n::[Chapter two]\n',
        'content.loom':
          '# Intro\n\n=>\n\nconst a = 1\n\n# Chapter two [., x.ts]\n\n=>\n\nexport const b = 2\n',
      })
      const found = of(corpus, 'OrphanedOpening')
      expect(found.length).toBe(1)
      expect(found[0]?.kind === 'OrphanedOpening' && found[0].name).toBe('Chapter two')
    }),
  )

  it.effect('flags a chapter two higher-order sinks both claim', () =>
    Effect.gen(function* () {
      const corpus = yield* corpusOf({
        'book.loom':
          '# Book\n\n## A [a]\n\n~\n\n::[The widget]\n\n## B [b]\n\n~\n\n::[The widget]\n',
        'widget.loom': widget,
      })
      const found = of(corpus, 'DuplicateChapter')
      expect(found.length).toBe(2)
      expect(
        found.every((f) => f.kind === 'DuplicateChapter' && f.name === 'The widget'),
      ).toBe(true)
    }),
  )

  it.effect('flags a higher-order sink member that names no section', () =>
    Effect.gen(function* () {
      const corpus = yield* corpusOf({
        'book.loom': '# Book\n\n## Core [packages/core]\n\n~\n\n::[Nope]\n',
      })
      const found = of(corpus, 'UnresolvedPointing')
      expect(found.length).toBe(1)
      expect(found[0]?.kind === 'UnresolvedPointing' && found[0].name).toBe('Nope')
    }),
  )

  it.effect('a well-formed book raises no sink fault', () =>
    Effect.gen(function* () {
      const corpus = yield* corpusOf({
        'book.loom': '# Book\n\n## Core [packages/core]\n\n~\n\n::[The widget]\n',
        'widget.loom': widget,
      })
      expect(sinkTreeFaults(corpus, normaliseTitle)).toEqual([])
    }),
  )
})
