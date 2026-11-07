import { describe, expect, it } from 'bun:test'
import { Array, Effect, Layer, Match, Option } from 'effect'
import { defaultAnchorDelims } from '@athrio/loom-ast/LoomTokens'
import type { LoomDocument } from '@athrio/loom-ast/LoomAst'
import { DocumentSource, LoomCompiler } from '../src/LoomCompiler'
import { WorkspaceSettings } from '../src/WorkspaceSettings'
import { LoomDiskCache } from '../src/LoomDiskCache'
import { FileSystemSource } from '../src/WorkspaceSource'
import { parseDocument, ParseLayer } from './parse'

const lines = (...rows: ReadonlyArray<string>): string => `${rows.join('\n')}\n`

const anchor = (name: string): string => `::${'['}${name}]`

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

const compiled = <A, E>(
  files: Record<string, string>,
  use: (compiler: LoomCompiler['Service']) => Effect.Effect<A, E>,
) => Effect.runPromise(LoomCompiler.pipe(Effect.flatMap(use), Effect.provide(layerOf(files))))

const diagnosed = (files: Record<string, string>, entry: string) =>
  compiled(files, (compiler) => compiler.diagnose(entry)).then((found) =>
    found.map((d) => d.message),
  )

describe("a discussion's identity line", () => {
  it('names a numbered discussion in its part', () => {
    const fm = parse(
      lines('---', 'Part I, Discussion 1: Waking', '---', '', '# Waking'),
    ).frontmatter
    expect([fm?.part?.value, fm?.discussion?.value, fm?.title?.value, fm?.chapter]).toEqual([
      'I',
      '1',
      'Waking',
      undefined,
    ])
  })

  it('names a discussion without a number', () => {
    const fm = parse(
      lines('---', 'Part: Work in progress', 'Discussion: Waking', '---'),
    ).frontmatter
    expect([fm?.partName?.value, fm?.discussion?.value, fm?.title?.value]).toEqual([
      'Work in progress',
      '',
      'Waking',
    ])
  })
})

describe('a discussion in the book', () => {
  const files = {
    '/corpus/rooms.loom': lines(
      '---',
      'Part I, Chapter 1: Rooms',
      '---',
      '',
      '# Rooms',
      '',
      'A room.',
    ),
    '/corpus/waking.loom': lines(
      '---',
      'Part I, Discussion 1: Waking',
      '---',
      '',
      '# Waking',
      '',
      'What wakes a monster?',
    ),
  }
  const monsters = '/corpus/monsters.loom'
  const linking = (name: string) =>
    lines(
      '---',
      'Part I, Chapter 2: Monsters',
      '---',
      '',
      '# Monsters [monsters.ts]',
      '',
      '=>',
      anchor(name),
    )
  const holdsNoCode = (title: string) =>
    `Chapter \`${title}\` holds no code in its opening section, so this anchor composes nothing. Name the section that holds the code instead.`

  it('leaves a name that nothing holds unresolved', async () => {
    const found = await diagnosed({ ...files, [monsters]: linking('Sleeping') }, monsters)
    expect(found.some((message) => message.startsWith('No section or chapter is called'))).toBe(
      true,
    )
  })

  it('is found by its title, as a chapter is', async () => {
    const found = await diagnosed({ ...files, [monsters]: linking('Waking') }, monsters)
    expect(found).toContain(holdsNoCode('Waking'))
  })

  it('is found by its own number, apart from the chapters', async () => {
    const found = await diagnosed(
      { ...files, [monsters]: linking('Part I, Discussion 1') },
      monsters,
    )
    expect(found).toContain(holdsNoCode('Part I, Discussion 1'))
  })

  it('is never a chapter that a chapter box points to', async () => {
    const boxed = lines(
      '---',
      'Part I, Chapter 2: Monsters',
      '---',
      '',
      '# Monsters',
      '',
      '::: Waking {Chapter}',
      'What wakes a monster.',
      ':::',
    )
    const found = await diagnosed({ ...files, [monsters]: boxed }, monsters)
    expect(found).toContain(
      "No chapter is titled `Waking` yet. Open it from this box, and the box's body becomes its opening.",
    )
  })
})

describe("a discussion's lines", () => {
  const thread = lines(
    '---',
    'Part I, Discussion 1: Waking',
    '---',
    '',
    '# Waking',
    '',
    '~ Yegor',
    'What should wake a monster?',
    '',
    '~ Loom',
    'A trap going off near it.',
    '=>',
    'An arrow here is prose.',
    '~',
    'A message nobody has signed yet.',
  )

  it('opens a message at every tilde, signed with its author', () => {
    const body = parse(thread).sections[0]!.code
    const tildes = body.flatMap((weft) => (weft.type === 'TildeWeft' ? [weft] : []))
    expect(tildes.map((weft) => weft.prose?.source)).toEqual(['Yegor', 'Loom', undefined])
  })

  it('reads an arrow as prose, so a discussion holds no code', () => {
    const body = parse(thread).sections[0]!.code
    expect(body.some((weft) => weft.type === 'ArrowWeft' || weft.type === 'CodeWeft')).toBe(false)
  })

  it('faults a mark for a file on a heading, and writes nothing', async () => {
    const path = '/corpus/waking.loom'
    const found = await diagnosed(
      {
        [path]: lines(
          '---',
          'Part I, Discussion 1: Waking',
          '---',
          '',
          '# Waking',
          '',
          '## Notes [notes.ts]',
        ),
      },
      path,
    )
    expect(found).toContain(
      'A discussion writes no file, so it takes no sink or `{Tangle}`. Remove it, or move the section into a chapter.',
    )
  })
})

describe('a topic and its conclusion', () => {
  const discussion = (...body: ReadonlyArray<string>) =>
    lines(
      '---',
      'Part I, Discussion 1: Waking',
      '---',
      '',
      '# Waking',
      '',
      'What wakes a monster?',
      '',
      ...body,
    )
  const conclusion = (text: string) => ['::: {Conclusion}', text, ':::']
  const faults = (text: string) =>
    diagnosed({ '/corpus/waking.loom': text }, '/corpus/waking.loom').then((found) =>
      found.filter((message) => message.includes('onclusion')),
    )

  it('closes a topic with one conclusion', async () => {
    const text = discussion(
      'What wakes a monster',
      '---',
      '',
      '~ Yegor',
      'A trap?',
      '',
      ...conclusion('A trap.'),
    )
    expect(await faults(text)).toEqual([])
  })

  it('faults a second conclusion in one topic', async () => {
    const text = discussion(
      'What wakes a monster',
      '---',
      '',
      ...conclusion('A trap.'),
      '',
      ...conclusion('A sound.'),
    )
    expect(await faults(text)).toEqual([
      'This topic already has a conclusion. Merge the two, or open a new topic with a divider.',
    ])
  })

  it('faults a conclusion outside a topic', async () => {
    const outside =
      'Only a topic holds a conclusion, and a divider opens each topic. Move this one below a divider, or make it a note.'
    expect(await faults(discussion(...conclusion('Too early.')))).toEqual([outside])
    const chapter = lines('# Rooms', '', 'Rooms', '---', '', ...conclusion('No discussion here.'))
    expect(await faults(chapter)).toEqual([outside])
  })
})

describe("the book's back matter", () => {
  const book = lines(
    '# Contents {TOC}',
    '',
    '### Part I — Rooms',
    '',
    '1. Walls',
    '',
    '### Back matter',
    '',
    'What the book leaves open.',
    '',
    '- Part I, Discussion 1: Waking',
  )
  const walls = lines(
    '---',
    'Part I: Rooms',
    'Chapter 1: Walls',
    '---',
    '',
    '# Walls',
    '',
    'A wall.',
  )
  const waking = lines(
    '---',
    'Part I, Discussion 1: Waking',
    '---',
    '',
    '# Waking',
    '',
    'What wakes a monster?',
    '',
    '~ Yegor',
    'A trap going off near it.',
    '',
    '~',
    'Nobody signed this.',
  )
  const root = '/corpus/book.loom'
  const files = { [root]: book, '/corpus/walls.loom': walls, '/corpus/waking.loom': waking }
  const unresolved = (sources: Record<string, string>) =>
    diagnosed(sources, root).then((found) =>
      found.filter((message) =>
        message.endsWith('Run `loom toc` to bring the contents up to date.'),
      ),
    )

  it("reads an entry's place and title apart", () => {
    const entries = parse(book).sections.flatMap((section) => section.entries ?? [])
    const entry = entries.find((one) => one.discussion !== undefined)
    expect([entry?.discussion?.value, entry?.title?.value]).toEqual([
      'Part I, Discussion 1',
      'Waking',
    ])
  })

  it('resolves an entry to the discussion its place and title name', async () => {
    expect(await unresolved(files)).toEqual([])
    const at = book.indexOf('Waking') + 1
    const found = await compiled(files, (compiler) => compiler.definition(root, at))
    expect(found?.path).toBe('/corpus/waking.loom')
  })

  it('leaves an entry unresolved when its place names no such discussion', async () => {
    const wrong = { ...files, [root]: book.replace('Discussion 1', 'Discussion 2') }
    expect(await unresolved(wrong)).toEqual([
      'No discussion is titled `Waking`. Run `loom toc` to bring the contents up to date.',
    ])
  })

  it('never resolves a chapter entry to a discussion', async () => {
    const listed = { ...files, [root]: book.replace('1. Walls', '1. Walls\n2. Waking') }
    expect(await unresolved(listed)).toEqual([
      'No chapter is titled `Waking`. Run `loom toc` to bring the contents up to date.',
    ])
  })

  it('writes the back matter after the parts, keeping its description', async () => {
    expect(await compiled(files, (compiler) => compiler.contents(root))).toBe(book)
    const bare = { ...files, [root]: lines('# Contents {TOC}', '', '1. Walls') }
    expect(await compiled(bare, (compiler) => compiler.contents(root))).toBe(
      lines(
        '# Contents {TOC}',
        '',
        '### Part I — Rooms',
        '',
        '1. Walls',
        '',
        '### Back matter',
        '',
        '- Part I, Discussion 1: Waking',
      ),
    )
  })

  it('writes no back matter for a book without discussions', async () => {
    const quiet = { [root]: book, '/corpus/walls.loom': walls }
    expect(await compiled(quiet, (compiler) => compiler.contents(root))).toBe(
      lines('# Contents {TOC}', '', '### Part I — Rooms', '', '1. Walls'),
    )
  })

  it('weaves the back matter as the last part of the menu', async () => {
    const site = await compiled(files, (compiler) => compiler.weave(root))
    expect(site.nav.map((part) => [part.name, part.chapters.map((entry) => entry.title)])).toEqual([
      ['Rooms', ['Walls']],
      ['Back matter', ['Waking']],
    ])
  })

  it('weaves each message as a byline, then its words', async () => {
    const site = await compiled(files, (compiler) => compiler.weave(root))
    const page = site.pages.find((one) => one.title === 'Waking')
    const blocks = Array.flatMap(page?.blocks ?? [], (block) =>
      Match.value(block).pipe(
        Match.when({ type: 'message' }, (message) => [['message', message.author]]),
        Match.when({ type: 'prose' }, (prose) => [['prose', prose.markdown]]),
        Match.orElse(() => []),
      ),
    )
    expect(blocks).toEqual([
      ['prose', 'What wakes a monster?'],
      ['message', 'Yegor'],
      ['prose', 'A trap going off near it.'],
      ['message', undefined],
      ['prose', 'Nobody signed this.'],
    ])
  })
})
