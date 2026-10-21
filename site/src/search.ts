import { Array, Effect, Match, Option, Order, pipe } from 'effect'
import { marked } from 'marked'
import {
  pathOf,
  type Block,
  type Corpus,
  type Page,
  type Route,
  type SearchGroup,
  type SearchHit,
} from './model'
import { chapterPath, docsCorpus } from './docs-page'

export type Entry = {
  readonly route: Route
  readonly href: string
  readonly place: string
  readonly heading: string
  readonly text: string
}

type Run = {
  readonly type?: string
  readonly text?: string
  readonly tokens?: ReadonlyArray<Run>
  readonly items?: ReadonlyArray<Run>
  readonly header?: ReadonlyArray<Run> | boolean
  readonly rows?: ReadonlyArray<ReadonlyArray<Run>>
}

const SILENT: ReadonlyArray<string> = ['html', 'tag', 'space', 'hr', 'br', 'def']

const cellsOf = (table: Run): ReadonlyArray<Run> => [
  ...(typeof table.header === 'object' ? table.header : []),
  ...(table.rows ?? []).flat(),
]

const wordsOf = (runs: ReadonlyArray<Run>): ReadonlyArray<string> =>
  Array.flatMap(runs, (run) =>
    Match.value(run).pipe(
      Match.withReturnType<ReadonlyArray<string>>(),
      Match.when(
        (each: Run) => SILENT.includes(each.type ?? ''),
        () => [],
      ),
      Match.when(
        (each: Run) => (each.tokens ?? []).length > 0,
        (each) => wordsOf(each.tokens ?? []),
      ),
      Match.when(
        (each: Run) => each.items !== undefined,
        (each) => wordsOf(each.items ?? []),
      ),
      Match.when(
        (each: Run) => each.rows !== undefined,
        (each) => wordsOf(cellsOf(each)),
      ),
      Match.orElse((each) => [each.text ?? '']),
    ),
  )

const proseText = (markdown: string): string =>
  wordsOf(Array.fromIterable(marked.lexer(markdown))).join(' ')

const flattened = (text: string): string => text.replace(/\s+/g, ' ').trim()

const blockWords = (block: Block): string =>
  Match.value(block).pipe(
    Match.when({ type: 'heading' }, (heading) => heading.title),
    Match.when({ type: 'prose' }, (prose) => proseText(prose.markdown)),
    Match.when({ type: 'note' }, (note) => proseText(note.markdown)),
    Match.when({ type: 'code' }, (code) => code.code),
    Match.exhaustive,
  )

type Draft = { readonly heading: string; readonly id: string; readonly words: ReadonlyArray<string> }

type Cutting = { readonly done: ReadonlyArray<Draft>; readonly filling: Draft }

const cut = (cutting: Cutting, block: Block): Cutting =>
  Match.value(block).pipe(
    Match.withReturnType<Cutting>(),
    Match.when({ type: 'heading', level: 1 }, () => cutting),
    Match.when({ type: 'heading', level: 2 }, (heading) => ({
      done: [...cutting.done, cutting.filling],
      filling: { heading: heading.title, id: heading.id, words: [] },
    })),
    Match.orElse((other) => ({
      ...cutting,
      filling: { ...cutting.filling, words: [...cutting.filling.words, blockWords(other)] },
    })),
  )

const draftsOf = (page: Page): ReadonlyArray<Draft> => {
  const opening: Draft = { heading: page.title, id: '', words: [] }
  const { done, filling } = Array.reduce(page.blocks, { done: [], filling: opening } as Cutting, cut)
  return [...done, filling]
}

const corpusEntries = (corpus: Corpus, base: string, route: Route): ReadonlyArray<Entry> =>
  Array.filter(
    Array.flatMap(corpus.pages, (page) => {
    const address = chapterPath(base, page.slug)
    return Array.map(draftsOf(page), (draft) => ({
      route,
      href: draft.id === '' ? address : `${address}#${draft.id}`,
      place: page.title,
      heading: draft.heading,
      text: flattened(draft.words.join(' ')),
    }))
    }),
    (entry) => !anchorsAlone(entry.text),
  )

const ANCHORS = /:{2}\[[^\]]*\](\([^)]*\))?/g

const anchorsAlone = (text: string): boolean =>
  text.trim() !== '' && text.replace(ANCHORS, '').trim() === ''

const UNSEARCHED: ReadonlyArray<string> = ['loom-pager']

type PageSection = { readonly id: string; readonly heading: string; readonly text: string }

type Filling = { readonly id: string; readonly headings: Array<string>; readonly words: Array<string> }

const chunkText = (chunk: HTMLRewriterTypes.Text): string =>
  chunk.lastInTextNode ? `${chunk.text} ` : chunk.text

const sectionsOfBody = (html: string): Effect.Effect<ReadonlyArray<PageSection>> =>
  Effect.promise(async () => {
    const sections: Array<Filling> = []
    const heading: HTMLRewriterTypes.HTMLRewriterElementContentHandlers = {
      element: () => {
        sections.at(-1)?.headings.push('')
      },
      text: (chunk) => {
        const headings = sections.at(-1)?.headings
        headings?.push(`${headings.pop() ?? ''}${chunkText(chunk)}`)
      },
    }
    await new HTMLRewriter()
      .on('main > div[id]', {
        element: (element) => {
          sections.push({ id: element.getAttribute('id') ?? '', headings: [], words: [] })
        },
      })
      .on('main > div[id] h1', heading)
      .on('main > div[id] h2', heading)
      .on('main > div[id] *', {
        text: (chunk) => {
          sections.at(-1)?.words.push(chunkText(chunk))
        },
      })
      .transform(new Response(html))
      .text()
    return Array.map(sections, (section) => ({
      id: section.id,
      heading: unescaped(flattened(section.headings[0] ?? '')),
      text: unescaped(flattened(section.words.join(''))),
    }))
  })

const ENTITIES: ReadonlyArray<readonly [string, string]> = [
  ['&lt;', '<'],
  ['&gt;', '>'],
  ['&quot;', '"'],
  ['&#39;', "'"],
  ['&#x27;', "'"],
  ['&amp;', '&'],
]

const unescaped = (text: string): string =>
  Array.reduce(ENTITIES, text, (out, [entity, glyph]) => out.split(entity).join(glyph))

export const pageName = (route: Route): string =>
  Match.value(route).pipe(
    Match.when('home', () => 'Loom'),
    Match.when('docs', () => 'Docs'),
    Match.when('source', () => 'Source'),
    Match.when('why-loom', () => 'Why Loom'),
    Match.when('community', () => 'Community'),
    Match.when('license', () => 'License'),
    Match.exhaustive,
  )

const pageEntries = (route: Route, body: string): Effect.Effect<ReadonlyArray<Entry>> =>
  Effect.map(sectionsOfBody(body), (sections) =>
    pipe(
      sections,
      Array.filter((section) => !UNSEARCHED.includes(section.id)),
      Array.map((section) => ({
        route,
        href: `${pathOf(route)}#${section.id}`,
        place: pageName(route),
        heading: section.heading,
        text: section.text,
      })),
    ),
  )

const OWN_PAGES: ReadonlyArray<Route> = ['home', 'why-loom', 'community', 'license']

export const indexOf = (
  book: Option.Option<Corpus>,
  bodyOf: (route: Route) => Effect.Effect<string>,
): Effect.Effect<ReadonlyArray<Entry>> =>
  Effect.map(
    Effect.forEach(OWN_PAGES, (route) => Effect.flatMap(bodyOf(route), (body) => pageEntries(route, body))),
    (pages) => [
      ...corpusEntries(docsCorpus, '/docs', 'docs'),
      ...Option.match(book, {
        onNone: () => [],
        onSome: (corpus) => corpusEntries(corpus, '/source', 'source'),
      }),
      ...pages.flat(),
    ],
  )

type Fragment = { readonly pre: string; readonly hit: string; readonly post: string }

const WINDOW = 62
const LEAD_IN = 22

const toWordBreak = (text: string): string => text.replace(/\s+\S*$/, '')

const clipped = (text: string): string =>
  text.length > WINDOW ? `${toWordBreak(text.slice(0, WINDOW))}…` : text

const whole = (text: string): Fragment => ({ pre: clipped(text), hit: '', post: '' })

const indexOfIgnoringCase = (haystack: string, needle: string): Option.Option<number> => {
  const at = haystack.toLowerCase().indexOf(needle.toLowerCase())
  return at < 0 ? Option.none() : Option.some(at)
}

const windowedAt = (source: string, at: number, length: number): Fragment => {
  const from = Math.max(0, at - LEAD_IN)
  const space = source.indexOf(' ', from)
  const start = from > 0 && space >= 0 && space < at ? space + 1 : from
  const pre = `${start > 0 ? '…' : ''}${source.slice(start, at)}`
  const hit = source.slice(at, at + length)
  const room = Math.max(0, WINDOW - pre.length - hit.length)
  const rest = source.slice(at + length)
  const post = rest.length > room ? `${toWordBreak(rest.slice(0, room))}…` : rest
  return { pre, hit, post }
}

const fragmentOf = (text: string, needle: string): Fragment =>
  Option.match(indexOfIgnoringCase(text, needle), {
    onNone: () => whole(text),
    onSome: (at) => windowedAt(text, at, needle.length),
  })

const MIN_QUERY = 2

type Ranked = { readonly entry: Entry; readonly at: number; readonly rank: number }

const rankOf = (entry: Entry, needle: string): number =>
  pipe(
    [entry.heading, entry.place, entry.text],
    Array.findFirstIndex((field) => field.toLowerCase().includes(needle)),
    Option.match({ onNone: () => 0, onSome: (field) => 3 - field }),
  )

const byRelevance: Order.Order<Ranked> = Order.combine(
  Order.mapInput(Order.flip(Order.Number), (ranked: Ranked) => ranked.rank),
  Order.mapInput(Order.Number, (ranked: Ranked) => ranked.at),
)

const PER_PAGE = 5

const orderOf = (results: ReadonlyArray<Result>): ReadonlyArray<Route> => [
  ...pipe(
    results,
    Array.map((result) => result.entry.route),
    Array.dedupe,
    Array.filter((route) => route !== 'source'),
  ),
  'source',
]

const hitOf = (entry: Entry, needle: string, meaning: boolean): SearchHit => ({
  href: entry.href,
  place: entry.place,
  heading: entry.heading,
  ...fragmentOf(entry.text, needle),
  meaning,
})

export type Result = { readonly entry: Entry; readonly words: string; readonly meaning: boolean }

export const groupsOf = (results: ReadonlyArray<Result>): ReadonlyArray<SearchGroup> =>
  pipe(
    orderOf(results),
    Array.map((route) => ({
      route,
      hits: pipe(
        results,
        Array.filter((result) => result.entry.route === route),
        Array.take(PER_PAGE),
        Array.map((result) => hitOf(result.entry, result.words, result.meaning)),
      ),
    })),
    Array.filter((group) => group.hits.length > 0),
  )

export const searchIn = (index: ReadonlyArray<Entry>, query: string): ReadonlyArray<SearchGroup> => {
  const needle = query.trim().toLowerCase()
  return needle.length < MIN_QUERY
    ? []
    : pipe(
        index,
        Array.map((entry, at): Ranked => ({ entry, at, rank: rankOf(entry, needle) })),
        Array.filter((each) => each.rank > 0),
        Array.sort(byRelevance),
        Array.map((each): Result => ({ entry: each.entry, words: needle, meaning: false })),
        groupsOf,
      )
}
