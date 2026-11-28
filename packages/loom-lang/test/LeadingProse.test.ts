import { describe, expect, it } from 'bun:test'
import { Array, Effect, Layer, Option } from 'effect'
import { byType } from '@athrio/loom-ast/LoomNode'
import { LoomCorpusAstBuilder } from '#ast/LoomCorpusAstBuilder'
import { WeaveBuilder } from '../src/weave/WeaveBuilder'
import type { WovenBlock, WovenCorpus, WovenPage } from '../src/weave/WovenCorpus'

const lines = (...rows: ReadonlyArray<string>): string => `${rows.join('\n')}\n`

const anchor = (name: string): string => `::${'['}${name}]`

const woven = (looms: Readonly<Record<string, string>>, root?: string): WovenCorpus =>
  Effect.runSync(
    Effect.gen(function* () {
      const builder = yield* LoomCorpusAstBuilder
      const modules = yield* Effect.forEach(Object.keys(looms), (path) =>
        builder
          .build(
            { read: (asked) => Effect.succeed(looms[asked] ?? ''), list: Option.none() },
            path,
          )
          .pipe(Effect.map((module) => [path, module] as const)),
      )
      const weaver = yield* WeaveBuilder
      return yield* weaver.build({ modules: new Map(modules) }, root)
    }).pipe(Effect.provide(Layer.mergeAll(LoomCorpusAstBuilder.layer, WeaveBuilder.layer))),
  )

const textOf = byType<WovenBlock>()({
  prose: (block) => block.markdown,
  heading: (block) => block.title,
  code: (block) => block.code,
  note: (block) => block.markdown,
  message: (block) => block.author ?? '',
})

const outline = (page: WovenPage | undefined): ReadonlyArray<readonly [string, string]> =>
  (page?.blocks ?? []).map((block) => [block.type, textOf(block)] as const)

const pageAt = (corpus: WovenCorpus, slug: string): WovenPage | undefined =>
  corpus.pages.find((page) => page.slug === slug)

describe('the prose that leads a loom', () => {
  const post = lines(
    '---',
    'Chapter: A post with a title',
    '---',
    '',
    'Prose before any heading.',
    '',
    '# A post with a title',
    '',
    'Prose under the title.',
  )

  it('stands on the page before the first heading', () => {
    const page = pageAt(woven({ '/posts/titled.loom': post }), 'posts/titled')
    expect(outline(page)).toEqual([
      ['prose', 'Prose before any heading.'],
      ['heading', 'A post with a title'],
      ['prose', 'Prose under the title.'],
    ])
  })

  it('belongs to the page and to no section of it', () => {
    const page = pageAt(woven({ '/posts/titled.loom': post }), 'posts/titled')
    expect(page?.blocks[0]?.source).toEqual({ chapter: 'posts/titled', section: '' })
  })

  it('keeps a note apart and an anchor as a link', () => {
    const led = lines(
      ':::',
      'A note that leads.',
      ':::',
      '',
      `See ${anchor('The details')} first.`,
      '',
      '# A post',
      '',
      '## The details',
      '',
      'They are few.',
    )
    const page = pageAt(woven({ '/posts/led.loom': led }), 'posts/led')
    expect(outline(page).slice(0, 2)).toEqual([
      ['note', 'A note that leads.'],
      ['prose', `See ${anchor('The details')} first.`],
    ])
    const prose = page?.blocks[1]
    expect(prose?.type === 'prose' ? prose.links.map((link) => link.targetId) : []).toEqual([
      'the-details',
    ])
  })
})

describe('a loom with no heading', () => {
  const titleOf = (text: string): string | undefined =>
    pageAt(woven({ '/posts/2026-11-21.loom': text }), 'posts/2026-11-21')?.title

  it('weaves to a page that holds all its prose', () => {
    const post = lines(
      '---',
      'Chapter: A short post',
      '---',
      '',
      'Its first line.',
      '',
      'Its second.',
    )
    const page = pageAt(woven({ '/posts/short.loom': post }), 'posts/short')
    expect(page?.title).toBe('A short post')
    expect(outline(page)).toEqual([['prose', 'Its first line.\n\nIts second.']])
  })

  it('goes by its first sentence, without the full stop', () => {
    expect(titleOf(lines('A short post with no heading. Its second sentence.'))).toBe(
      'A short post with no heading',
    )
  })

  it('keeps a question mark', () => {
    expect(titleOf(lines('Why weave at all? Because prose is read.'))).toBe('Why weave at all?')
  })

  it('reads a paragraph broken over two lines as one', () => {
    expect(titleOf(lines('A paragraph broken', 'over two lines. And more.'))).toBe(
      'A paragraph broken over two lines',
    )
  })

  it('reads an anchor as the name it holds', () => {
    expect(titleOf(lines(`Read ${anchor('The details')} first.`))).toBe('Read The details first')
  })

  it('reads its opening words after a box that opens it', () => {
    expect(titleOf(lines(':::', 'Check the date.', ':::', '', 'Spring came early.'))).toBe(
      'Spring came early',
    )
  })

  it('cuts a long sentence at a word and ends it on an ellipsis', () => {
    expect(
      titleOf(
        lines(
          'This opening sentence runs on for far longer than any menu could ever hold in one line.',
        ),
      ),
    ).toBe('This opening sentence runs on for far longer than any menu…')
  })

  it('goes by the name of its file when it holds no prose', () => {
    expect(titleOf('')).toBe('2026-11-21')
  })

  it('stands in the menu under the same words', () => {
    const corpus = woven(
      {
        '/corpus/book.loom': lines('# A small book', '', 'Its preface.'),
        '/corpus/post.loom': lines('A short post with no heading.'),
      },
      '/corpus/book.loom',
    )
    expect(corpus.nav).toEqual([
      {
        number: '',
        name: 'Orphan chapters',
        chapters: [{ number: '', title: 'A short post with no heading', slug: 'corpus/post' }],
      },
    ])
  })
})

describe('the loom a weave starts from', () => {
  it('opens the corpus with a page of its own, ahead of every chapter', () => {
    const corpus = woven(
      {
        '/corpus/zz-book.loom': lines('# A small book', '', 'The preface of the book.'),
        '/corpus/aa-first.loom': lines('---', 'Chapter 1: The first chapter', '---', '', '# First'),
      },
      '/corpus/zz-book.loom',
    )
    expect(corpus.pages.map((page) => page.slug)).toEqual(['corpus/zz-book', 'corpus/aa-first'])
    expect(corpus.opening).toEqual({ number: '', title: 'A small book', slug: 'corpus/zz-book' })
    expect(outline(corpus.pages[0])).toEqual([
      ['heading', 'A small book'],
      ['prose', 'The preface of the book.'],
    ])
    expect(corpus.nav.flatMap((part) => part.chapters.map((chapter) => chapter.slug))).toEqual([
      'corpus/aa-first',
    ])
  })

  it('is the whole of a post woven by itself', () => {
    const corpus = woven({ '/posts/post.loom': lines('Just prose.') }, '/posts/post.loom')
    expect(corpus.nav).toEqual([])
    expect(corpus.opening).toEqual({ number: '', title: 'Just prose', slug: 'posts/post' })
    expect(corpus.pages.map((page) => page.title)).toEqual(['Just prose'])
    expect(outline(corpus.pages[0])).toEqual([['prose', 'Just prose.']])
  })

  it('names no opening page when the weave names no root', () => {
    const corpus = woven({ '/corpus/book.loom': lines('# A small book', '', 'Its preface.') })
    expect(corpus.opening).toBeUndefined()
    expect(corpus.pages.map((page) => page.slug)).toEqual(['corpus/book'])
  })
})

describe('the index of a book that opens with prose', () => {
  it('links the opening loom that defines a concept, and a use in leading prose', () => {
    const corpus = woven(
      {
        '/corpus/book.loom': lines(
          '# A small book',
          '',
          'Its preface.',
          '',
          '## Weft {Concept}',
          '',
          'A weft is one line of a loom.',
        ),
        '/corpus/post.loom': lines(`A post that speaks of a ${anchor('Weft')}.`),
      },
      '/corpus/book.loom',
    )
    const closing = Option.getOrUndefined(Array.last(pageAt(corpus, 'index')?.blocks ?? []))
    expect(closing?.type === 'prose' ? closing.markdown : '').toBe(
      'Defined in A small book. Used in A post that speaks of a Weft.',
    )
    expect(
      closing?.type === 'prose'
        ? closing.links.map((link) => [link.name, link.targetSlug, link.targetId])
        : [],
    ).toEqual([
      ['A small book', 'corpus/book', 'weft'],
      ['A post that speaks of a Weft', 'corpus/post', ''],
    ])
  })
})
