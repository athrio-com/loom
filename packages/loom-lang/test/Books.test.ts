import { describe, expect, it as it_ } from 'bun:test'
import { effectify } from '@athrio/effect-test'
import { Effect, Layer, Option } from 'effect'
import { defaultAnchorDelims } from '@athrio/loom-ast/LoomTokens'
import type { LoomDocument } from '@athrio/loom-ast/LoomAst'
import { DocumentSource, LoomCompiler } from '../src/LoomCompiler'
import { WorkspaceSettings } from '../src/WorkspaceSettings'
import { LoomDiskCache } from '../src/LoomDiskCache'
import { FileSystemSource } from '../src/WorkspaceSource'
import { parseDocument, ParseLayer } from './parse'

const it = effectify(it_)

const lines = (...rows: ReadonlyArray<string>): string => `${rows.join('\n')}\n`

const anchor = (name: string): string => `::${'['}${name}]`

const chapter = (identity: ReadonlyArray<string>, ...body: ReadonlyArray<string>): string =>
  lines('---', ...identity, '---', '', ...body)

const parse = (src: string): LoomDocument =>
  Effect.runSync(parseDocument(src).pipe(Effect.provide(ParseLayer)))

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

const tangled = (files: Record<string, string>, entry: string) =>
  LoomCompiler.pipe(
    Effect.flatMap((compiler) => compiler.tangle(entry)),
    Effect.provide(layerOf(files)),
  )

const refusal = (files: Record<string, string>, entry: string) =>
  tangled(files, entry).pipe(
    Effect.flip,
    Effect.map((error) => error.message),
  )

const diagnosed = (files: Record<string, string>, entry: string) =>
  LoomCompiler.pipe(
    Effect.flatMap((compiler) => compiler.diagnose(entry)),
    Effect.map((found) => found.map((diagnostic) => diagnostic.message)),
    Effect.provide(layerOf(files)),
  )

describe('a loom names its book', () => {
  it('reads the book a chapter names beside its place', () => {
    const fm = parse(
      chapter(['Part I, Chapter 2: Sleeping monsters', 'Book: The game'], '# Sleeping monsters'),
    ).frontmatter
    expect([fm?.book?.value, fm?.part?.value, fm?.title?.value]).toEqual([
      'The game',
      'I',
      'Sleeping monsters',
    ])
  })

  it('reads a book loom as a book with no place', () => {
    const fm = parse(chapter(['Book: The game'], '# The game')).frontmatter
    expect([fm?.book?.value, fm?.part, fm?.title]).toEqual(['The game', undefined, undefined])
  })
})

const hello = 'const greet = (name: string): string => `Hello, ${name}!`'

const welcome = 'const greet = (name: string): string => `Welcome, ${name}!`'

const corpus = (looms: Record<string, string>): Record<string, string> => ({
  '/corpus/greetings.loom': chapter(
    ['Part I: Saying things', 'Chapter 1: Greetings'],
    '# Greetings',
    '',
    'A greeting takes a name and returns a line of welcome.',
    '',
    '=>',
    hello,
  ),
  '/corpus/game/book.loom': chapter(
    ['Book: The game'],
    '# The game',
    '',
    'A game of rooms that wake one at a time.',
  ),
  '/corpus/game/greetings.loom': chapter(
    ['Part I: Waking', 'Chapter 1: Greetings', 'Book: The game'],
    '# Greetings',
    '',
    'The game greets a player who wakes.',
    '',
    '=>',
    welcome,
  ),
  '/corpus/game/rooms.loom': chapter(
    ['Part I, Chapter 2: Rooms', 'Book: The game'],
    '# Rooms',
    '',
    'A room waits for its player.',
    '',
    '=>',
    'const rooms = 3',
  ),
  ...looms,
})

const program = (identity: ReadonlyArray<string>, line: string): string =>
  chapter(
    identity,
    '# The program [hello.ts]',
    '',
    'The program greets the world.',
    '',
    '=>',
    line,
    "console.log(greet('world'))",
  )

const greeted = (greeting: string): string => `${greeting}\nconsole.log(greet('world'))\n`

describe('names stay within their book', () => {
  it.effect('finds a chapter of its own book by a bare name', () =>
    Effect.gen(function* () {
      const files = yield* tangled(
        corpus({
          '/corpus/game/hello.loom': program(
            ['Part I, Chapter 3: The program', 'Book: The game'],
            anchor('Greetings'),
          ),
        }),
        '/corpus/game/hello.loom',
      )
      expect(files[0]!.content).toBe(greeted(welcome))
    }),
  )

  it.effect('numbers the parts of each book on their own', () =>
    Effect.gen(function* () {
      const inGame = yield* tangled(
        corpus({
          '/corpus/game/hello.loom': program(
            ['Part I, Chapter 3: The program', 'Book: The game'],
            anchor('Part I, Chapter 1'),
          ),
        }),
        '/corpus/game/hello.loom',
      )
      const inDefault = yield* tangled(
        corpus({
          '/corpus/hello.loom': program(
            ['Part I, Chapter 2: The program'],
            anchor('Part I, Chapter 1'),
          ),
        }),
        '/corpus/hello.loom',
      )
      expect([inGame[0]!.content, inDefault[0]!.content]).toEqual([
        greeted(welcome),
        greeted(hello),
      ])
    }),
  )

  it.effect('reaches into another book by a path that starts with its name', () =>
    Effect.gen(function* () {
      const files = yield* tangled(
        corpus({
          '/corpus/hello.loom': program(
            ['Part I, Chapter 2: The program'],
            anchor('The game, Greetings'),
          ),
        }),
        '/corpus/hello.loom',
      )
      expect(files[0]!.content).toBe(greeted(welcome))
    }),
  )

  it.effect('never reaches a chapter of another book by a bare name', () =>
    Effect.gen(function* () {
      const message = yield* refusal(
        corpus({
          '/corpus/hello.loom': program(['Part I, Chapter 2: The program'], anchor('Rooms')),
        }),
        '/corpus/hello.loom',
      )
      expect(message).toContain('No section or chapter is called `Rooms`.')
    }),
  )

  it.effect('lets two books hold chapters of one title', () =>
    Effect.gen(function* () {
      const messages = yield* diagnosed(corpus({}), '/corpus/game/greetings.loom')
      expect(messages.filter((message) => message.includes('too.'))).toEqual([])
    }),
  )
})

describe("judging a book's name", () => {
  it.effect('warns of a book that no loom opens', () =>
    Effect.gen(function* () {
      const messages = yield* diagnosed(
        corpus({
          '/corpus/game/doors.loom': chapter(
            ['Part I, Chapter 4: Doors', 'Book: The gmae'],
            '# Doors',
            '',
            'A door opens onto the next room.',
          ),
        }),
        '/corpus/game/doors.loom',
      )
      expect(messages).toContain(
        'No loom opens the book `The gmae`. Write its book loom, a loom whose frontmatter holds only `Book: The gmae`.',
      )
    }),
  )

  it.effect('faults two looms that open one book', () =>
    Effect.gen(function* () {
      const messages = yield* diagnosed(
        corpus({ '/corpus/game/again.loom': chapter(['Book: The game'], '# The game, again') }),
        '/corpus/game/again.loom',
      )
      expect(messages).toContain(
        'Another book loom, in book.loom, is called `The game` too. Rename one of them.',
      )
    }),
  )
})

describe("a book's name in the editor", () => {
  const files = corpus({})
  const rooms = files['/corpus/game/rooms.loom']!
  const nameOffset = rooms.indexOf('The game') + 2

  it.effect('leads from a Book line to the book loom', () =>
    Effect.gen(function* () {
      const target = yield* LoomCompiler.pipe(
        Effect.flatMap((compiler) => compiler.definition('/corpus/game/rooms.loom', nameOffset)),
        Effect.provide(layerOf(files)),
      )
      expect([target?.path, target?.range.start]).toEqual([
        '/corpus/game/book.loom',
        { line: 1, character: 6 },
      ])
    }),
  )

  it.effect('finds every loom that names the book', () =>
    Effect.gen(function* () {
      const found = yield* LoomCompiler.pipe(
        Effect.flatMap((compiler) => compiler.references('/corpus/game/rooms.loom', nameOffset)),
        Effect.provide(layerOf(files)),
      )
      expect(found.map((reference) => reference.path).sort()).toEqual([
        '/corpus/game/book.loom',
        '/corpus/game/greetings.loom',
        '/corpus/game/rooms.loom',
      ])
    }),
  )
})

const woven = (files: Record<string, string>, root: string) =>
  LoomCompiler.pipe(
    Effect.flatMap((compiler) => compiler.weave(root)),
    Effect.provide(layerOf(files)),
  )

describe('weaving a corpus of books', () => {
  const root = '/corpus/book.loom'
  const files = corpus({
    [root]: lines(
      '# Greetings everywhere',
      '',
      'A corpus of greetings, and a game that uses them.',
    ),
    '/corpus/notes.loom': chapter(['Chapter: Notes'], '# Notes', '', 'Loose thoughts on greeting.'),
  })

  it.effect('gives each named book a menu of its own', () =>
    Effect.gen(function* () {
      const site = yield* woven(files, root)
      expect([
        site.nav.map((part) => [part.name, part.chapters.map((entry) => entry.title)]),
        site.books.map((book) => [
          book.name,
          book.slug,
          book.nav.map((part) => [part.name, part.chapters.map((entry) => entry.title)]),
        ]),
      ]).toEqual([
        [
          ['Saying things', ['Greetings']],
          ['Orphan chapters', ['Notes']],
        ],
        [['The game', 'the-game', [['Waking', ['Greetings', 'Rooms']]]]],
      ])
    }),
  )

  it.effect('keeps the books apart in their pages and their order', () =>
    Effect.gen(function* () {
      const site = yield* woven(files, root)
      expect(site.pages.map((page) => [page.slug, page.book ?? ''])).toEqual([
        ['corpus/greetings', ''],
        ['corpus/notes', ''],
        ['the-game', 'The game'],
        ['the-game/game/greetings', 'The game'],
        ['the-game/game/rooms', 'The game'],
      ])
    }),
  )
})
