import { describe, expect, it } from 'bun:test'
import { Effect, Layer, Option } from 'effect'
import { defaultAnchorDelims } from '@athrio/loom-ast/LoomTokens'
import type { LoomDocument } from '@athrio/loom-ast/LoomAst'
import { DocumentSource, LoomCompiler } from '../src/LoomCompiler'
import { WorkspaceSettings } from '../src/WorkspaceSettings'
import { LoomDiskCache } from '../src/LoomDiskCache'
import { FileSystemSource } from '../src/WorkspaceSource'
import { parseDocument, ParseLayer } from './parse'

// A discussion is a loom of its own kind, which sits in its part beside the
// chapters. Its identity line names it as a chapter's does, with `Discussion` in
// place of `Chapter`, and discussions are numbered apart from chapters.
const parse = (src: string): LoomDocument =>
  Effect.runSync(parseDocument(src).pipe(Effect.provide(ParseLayer)))

const lines = (...ls: ReadonlyArray<string>): string => ls.join('\n') + '\n'

const anchor = (name: string): string => `::${'['}${name}]`

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

const diagnosed = (files: Record<string, string>, entry: string) =>
  Effect.runPromise(
    LoomCompiler.pipe(
      Effect.flatMap((compiler) => compiler.diagnose(entry)),
      Effect.provide(layerOf(files)),
    ),
  ).then((found) => found.map((d) => d.message))

describe("a discussion's identity line", () => {
  it('names a numbered discussion in its part', () => {
    const fm = parse(lines('---', 'Part I, Discussion 1: Waking', '---', '', '# Waking')).frontmatter
    expect([fm?.part?.value, fm?.discussion?.value, fm?.title?.value, fm?.chapter]).toEqual([
      'I',
      '1',
      'Waking',
      undefined,
    ])
  })

  it('names a discussion without a number', () => {
    const fm = parse(lines('---', 'Part: Work in progress', 'Discussion: Waking', '---')).frontmatter
    expect([fm?.partName?.value, fm?.discussion?.value, fm?.title?.value]).toEqual([
      'Work in progress',
      '',
      'Waking',
    ])
  })
})

describe('a discussion in the book', () => {
  const files = {
    '/corpus/rooms.loom': lines('---', 'Part I, Chapter 1: Rooms', '---', '', '# Rooms', '', 'A room.'),
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
  const linking = (name: string) =>
    lines('---', 'Part I, Chapter 2: Monsters', '---', '', '# Monsters [monsters.ts]', '', '=>', anchor(name))
  const holdsNoCode = (title: string) =>
    `Chapter \`${title}\` opens with a section that holds no code, so this anchor composes nothing.`

  it('leaves a name that nothing holds unresolved', async () => {
    const found = await diagnosed({ ...files, '/corpus/monsters.loom': linking('Sleeping') }, '/corpus/monsters.loom')
    expect(found.some((message) => message.startsWith('Unresolved anchor'))).toBe(true)
  })

  it('is found by its title, as a chapter is', async () => {
    const found = await diagnosed({ ...files, '/corpus/monsters.loom': linking('Waking') }, '/corpus/monsters.loom')
    expect(found).toContain(holdsNoCode('Waking'))
  })

  it('is found by its own number, apart from the chapters', async () => {
    const found = await diagnosed(
      { ...files, '/corpus/monsters.loom': linking('Part I, Discussion 1') },
      '/corpus/monsters.loom',
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
    const found = await diagnosed({ ...files, '/corpus/monsters.loom': boxed }, '/corpus/monsters.loom')
    expect(found).toContain(
      "To be settled: no chapter is titled `Waking` yet. Open it from this box, and the box's body becomes its opening.",
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
      { [path]: lines('---', 'Part I, Discussion 1: Waking', '---', '', '# Waking', '', '## Notes [notes.ts]') },
      path,
    )
    expect(found).toContain(
      'File in a discussion: a discussion holds no code and writes no file, so this mark means nothing here. Move the code into a chapter, or remove the mark.',
    )
  })
})

describe('a topic and its conclusion', () => {
  const discussion = (...body: ReadonlyArray<string>) =>
    lines('---', 'Part I, Discussion 1: Waking', '---', '', '# Waking', '', 'What wakes a monster?', '', ...body)
  const conclusion = (text: string) => ['::: {Conclusion}', text, ':::']
  const faults = (text: string) =>
    diagnosed({ '/corpus/waking.loom': text }, '/corpus/waking.loom').then((found) =>
      found.filter((message) => message.includes('onclusion')),
    )

  it('closes a topic with one conclusion', async () => {
    const text = discussion('What wakes a monster', '---', '', '~ Yegor', 'A trap?', '', ...conclusion('A trap.'))
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
      'Second conclusion: this topic already closes with a conclusion. Merge the two, or open a new topic with a divider.',
    ])
  })

  it('faults a conclusion outside a topic', async () => {
    const outside =
      'Conclusion outside a topic: a conclusion closes a topic of a discussion, and a divider opens each topic. Move it under a topic, or make it a note.'
    expect(await faults(discussion(...conclusion('Too early.')))).toEqual([outside])
    const chapter = lines('# Rooms', '', 'Rooms', '---', '', ...conclusion('No discussion here.'))
    expect(await faults(chapter)).toEqual([outside])
  })
})
