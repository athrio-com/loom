import { describe, expect, it as it_ } from 'bun:test'
import { effectify } from '@athrio/effect-test'
import { Array, Effect, Layer, Option, Order } from 'effect'
import { defaultAnchorDelims } from '@athrio/loom-ast/LoomTokens'
import type { WorkspaceManifest } from '@athrio/loom-config/LoomConfig'
import { DocumentSource, type EditAnswer, LoomCompiler } from '../src/LoomCompiler'
import { ReadError } from '#ast/LoomCorpusAstBuilder'
import { WorkspaceSettings } from '../src/WorkspaceSettings'
import { LoomDiskCache } from '../src/LoomDiskCache'
import { FileSystemSource } from '../src/WorkspaceSource'
import type { LoomIntent } from '../src/EditBuilder'

const it = effectify(it_)

const offsetOf = (
  text: string,
  at: { readonly line: number; readonly character: number },
): number =>
  text.split('\n').slice(0, at.line).join('\n').length + (at.line > 0 ? 1 : 0) + at.character

const lastFirst = Order.mapInput(Order.Number, (edit: { readonly start: number }) => -edit.start)

const appliedTo = (files: Record<string, string>, answer: EditAnswer): Record<string, string> => ({
  ...files,
  ...Object.fromEntries(answer.made.map((made) => [made.path, made.text])),
  ...Object.fromEntries(
    Object.entries(Array.groupBy(answer.edits, (edit) => edit.path)).map(([path, edits]) => {
      const text = files[path] ?? ''
      return [
        path,
        Array.sort(
          edits.map((edit) => ({
            start: offsetOf(text, edit.range.start),
            end: offsetOf(text, edit.range.end),
            text: edit.text,
          })),
          lastFirst,
        ).reduce(
          (done, edit) => done.slice(0, edit.start) + edit.text + done.slice(edit.end),
          text,
        ),
      ]
    }),
  ),
})

const edited = (
  files: Record<string, string>,
  intent: LoomIntent,
  configured: Option.Option<WorkspaceManifest> = Option.some(manifest),
) =>
  withCompiler(
    files,
    (compiler) =>
      compiler.edit('/', Option.fromNullishOr(Object.keys(files)[0]), intent, (uri) => uri),
    configured,
  )

const afterEdit = (files: Record<string, string>, intent: LoomIntent) =>
  Effect.map(edited(files, intent), (answer) => appliedTo(files, answer))

const refusal = (files: Record<string, string>, intent: LoomIntent) =>
  Effect.flip(edited(files, intent))

const refused = (files: Record<string, string>, intent: LoomIntent) =>
  Effect.map(refusal(files, intent), (failure) => failure._tag)

const lines = (...rows: ReadonlyArray<string>): string => `${rows.join('\n')}\n`

const anchor = (name: string): string => `::${'['}${name}]`

const manifest: WorkspaceManifest = {
  languages: { typescript: {} },
  corpus: 'corpus',
  variables: { version: '0.1.19' },
}

const layerOf = (
  files: Record<string, string>,
  configured: Option.Option<WorkspaceManifest> = Option.some(manifest),
) =>
  Layer.provide(
    LoomCompiler.layer,
    Layer.mergeAll(
      FileSystemSource,
      LoomDiskCache.none,
      Layer.succeed(DocumentSource, {
        read: (path: string) =>
          path in files
            ? Effect.succeed(files[path] ?? '')
            : Effect.fail(new ReadError({ path, cause: 'no such loom' })),
        list: Option.some(() =>
          Effect.succeed(Object.keys(files).filter((path) => path.endsWith('.loom'))),
        ),
        hold: () => Effect.void,
        forget: () => Effect.void,
      }),
      Layer.succeed(WorkspaceSettings, {
        manifest: () => Effect.succeed(configured),
        resolve: () =>
          Effect.succeed({
            delims: defaultAnchorDelims,
            primaryLanguage: 'typescript',
            variables: { version: '0.1.19' },
            width: 100,
          }),
      }),
    ),
  )

const withCompiler = <A, E>(
  files: Record<string, string>,
  use: (compiler: LoomCompiler['Service']) => Effect.Effect<A, E>,
  configured: Option.Option<WorkspaceManifest> = Option.some(manifest),
) => LoomCompiler.pipe(Effect.flatMap(use), Effect.provide(layerOf(files, configured)))

const grid = lines(
  '---',
  'Part I: The room',
  'Chapter 1: The grid',
  'Book: The game',
  'Language: TypeScript',
  '---',
  '',
  '# The grid',
  '',
  'The room is a grid.',
  '',
  '## Cells',
  '',
  'A cell holds one thing.',
  '',
  '=>',
  '',
  'export const cells = 9',
)

const walls = lines(
  '---',
  'Part I, Chapter 2: Walls',
  'Book: The game',
  'Language: TypeScript',
  '---',
  '',
  '# Walls',
  '',
  `Walls bound the grid, as ${anchor('Part I, Chapter 1, Cells')} describes.`,
)

const lamps = lines(
  '---',
  'Part II: Light',
  'Chapter 1: Lamps',
  'Book: The game',
  '---',
  '',
  '# Lamps',
  '',
  `Lamps hang on the ${anchor('Walls')}.`,
)

const waking = lines(
  '---',
  'Part I, Discussion 1: Waking',
  'Book: The game',
  '---',
  '',
  '# Waking',
  '',
  'What wakes a monster.',
  '',
  'Traps',
  '---',
  '',
  '~ Yegor',
  'What should wake a monster?',
)

const game: Record<string, string> = {
  '/corpus/game.loom': lines(
    '---',
    'Book: The game',
    '---',
    '',
    '# The game',
    '',
    'A game of rooms.',
  ),
  '/corpus/grid.loom': grid,
  '/corpus/walls.loom': walls,
  '/corpus/lamps.loom': lamps,
  '/corpus/waking.loom': waking,
}

const quiet: Record<string, string> = {
  ...game,
  '/corpus/walls.loom': walls.replace(`, as ${anchor('Part I, Chapter 1, Cells')} describes`, ''),
}

const plan = lines(
  '# The plan',
  '',
  'What the game still needs.',
  '',
  '## Paint the walls {kind=Task status=todo}',
  '',
  'Two coats.',
)

const tasks: Record<string, string> = {
  '/corpus/plan.loom': plan,
  '/corpus/tasks.loom': lines(
    '---',
    'Trope Chapter: Tasks',
    '---',
    '',
    '# Tasks',
    '',
    '## What it declares {Manifest}',
    '',
    '=>',
    JSON.stringify({
      contract: '1',
      contributes: {
        kinds: {
          section: [
            {
              kind: 'Task',
              parameters: { status: { choice: ['todo', 'done'] }, tags: { list: 'text' } },
            },
          ],
          box: [{ kind: 'Estimate', body: 'text', parameters: { days: 'number' } }],
        },
        headings: { parameters: { owner: 'text' } },
      },
    }),
  ),
}

describe('making looms and books', () => {
  it.effect('makes a chapter in its part and numbers the chapters after it', () =>
    Effect.gen(function* () {
      const after = yield* afterEdit(game, {
        _tag: 'MakeLoom',
        uri: '/corpus/doors.loom',
        kind: 'Chapter',
        book: 'The game',
        part: 'I',
        title: 'Doors',
        language: 'TypeScript',
        after: '/corpus/grid.loom',
      })
      expect(after['/corpus/doors.loom']).toBe(
        lines(
          '---',
          'Part I: The room',
          'Chapter 2: Doors',
          'Book: The game',
          'Language: TypeScript',
          '---',
          '',
          '# Doors',
        ),
      )
      expect(after['/corpus/walls.loom']).toBe(
        walls.replace('Chapter 2: Walls', 'Chapter 3: Walls'),
      )
      expect(after['/corpus/grid.loom']).toBe(grid)
    }),
  )

  it.effect('makes a chapter in a new part and numbers the parts after it', () =>
    Effect.gen(function* () {
      const after = yield* afterEdit(game, {
        _tag: 'MakeLoom',
        uri: '/corpus/keys.loom',
        kind: 'Chapter',
        book: 'The game',
        part: { name: 'Doors and keys', after: 'I' },
        title: 'Keys',
      })
      expect(after['/corpus/keys.loom']).toBe(
        lines(
          '---',
          'Part II: Doors and keys',
          'Chapter 1: Keys',
          'Book: The game',
          '---',
          '',
          '# Keys',
        ),
      )
      expect(after['/corpus/lamps.loom']).toBe(lamps.replace('Part II: Light', 'Part III: Light'))
    }),
  )

  it.effect('refuses what cannot be made', () =>
    Effect.gen(function* () {
      const doors = {
        _tag: 'MakeLoom',
        uri: '/corpus/doors.loom',
        kind: 'Chapter',
        book: 'The game',
        part: 'I',
        title: 'Doors',
      } as const
      expect(yield* refused(game, { ...doors, title: 'Walls' })).toBe('TitleTaken')
      expect(yield* refused(game, { ...doors, book: 'The maze' })).toBe('NoSuchBook')
      expect(yield* refused(game, { ...doors, part: 'IX' })).toBe('NoSuchPart')
      expect(yield* refused(game, { ...doors, uri: '/corpus/walls.loom' })).toBe('LoomExists')
      expect(yield* refused(game, { ...doors, title: 'Two\nlines' })).toBe('UnfitName')
      expect(yield* refused(game, { ...doors, after: '/corpus/lamps.loom' })).toBe('NotInPart')
    }),
  )

  it.effect('makes a book loom, even in an empty workspace', () =>
    Effect.gen(function* () {
      const website = { _tag: 'MakeBook', uri: '/corpus/web.loom', name: 'The website' } as const
      const opened = lines('---', 'Book: The website', '---', '', '# The website')
      expect((yield* afterEdit(game, website))['/corpus/web.loom']).toBe(opened)
      expect((yield* afterEdit({}, website))['/corpus/web.loom']).toBe(opened)
      expect(yield* refused(game, { ...website, name: 'The game' })).toBe('BookExists')
    }),
  )
})

describe('moving and removing looms', () => {
  it.effect('moves a chapter into another part', () =>
    Effect.gen(function* () {
      const after = yield* afterEdit(game, {
        _tag: 'MoveLoom',
        uri: '/corpus/walls.loom',
        book: 'The game',
        part: 'II',
        after: '/corpus/lamps.loom',
      })
      expect(after['/corpus/walls.loom']).toBe(
        walls.replace('Part I, Chapter 2: Walls\n', 'Part II: Light\nChapter 2: Walls\n'),
      )
      expect(after['/corpus/grid.loom']).toBe(grid)
      expect(after['/corpus/lamps.loom']).toBe(lamps)
    }),
  )

  it.effect('moves a chapter within its part', () =>
    Effect.gen(function* () {
      const after = yield* afterEdit(game, {
        _tag: 'MoveLoom',
        uri: '/corpus/grid.loom',
        book: 'The game',
        part: 'I',
        after: '/corpus/walls.loom',
      })
      expect(after['/corpus/grid.loom']).toBe(
        grid.replace('Chapter 1: The grid', 'Chapter 2: The grid'),
      )
      expect(after['/corpus/walls.loom']).toBe(
        walls
          .replace('Chapter 2: Walls', 'Chapter 1: Walls')
          .replace('Part I, Chapter 1, Cells', 'Part I, Chapter 2, Cells'),
      )
    }),
  )

  it.effect('removes a chapter and hands its part name on', () =>
    Effect.gen(function* () {
      const answer = yield* edited(quiet, { _tag: 'RemoveLoom', uri: '/corpus/grid.loom' })
      expect(answer.edits.some((edit) => edit.path === '/corpus/grid.loom')).toBe(false)
      expect(answer.removed).toEqual(['/corpus/grid.loom'])
      expect(appliedTo(quiet, answer)['/corpus/walls.loom']).toBe(
        (quiet['/corpus/walls.loom'] ?? '').replace(
          'Part I, Chapter 2: Walls\n',
          'Part I: The room\nChapter 1: Walls\n',
        ),
      )
    }),
  )

  it.effect('refuses to remove a chapter another chapter composes', () =>
    Effect.gen(function* () {
      const composing = {
        ...quiet,
        '/corpus/walls.loom': `${quiet['/corpus/walls.loom']}\n=>\n\n${anchor('Part I, Chapter 1, Cells')}\n`,
      }
      const failed = yield* Effect.flip(
        edited(composing, { _tag: 'RemoveLoom', uri: '/corpus/grid.loom' }),
      )
      expect(failed._tag).toBe('EditBreaksLoom')
      expect(failed._tag === 'EditBreaksLoom' ? failed.path : '').toBe('/corpus/walls.loom')
    }),
  )
})

describe('titles and names', () => {
  it.effect('retitles a chapter, its heading, and the links that name it', () =>
    Effect.gen(function* () {
      const after = yield* afterEdit(game, {
        _tag: 'RetitleLoom',
        uri: '/corpus/walls.loom',
        title: 'Fences',
      })
      expect(after['/corpus/walls.loom']).toBe(
        walls.replace(': Walls', ': Fences').replace('# Walls', '# Fences'),
      )
      expect(after['/corpus/lamps.loom']).toBe(lamps.replace(anchor('Walls'), anchor('Fences')))
    }),
  )

  it.effect('renames a book on every line that names it', () =>
    Effect.gen(function* () {
      const after = yield* afterEdit(game, {
        _tag: 'RenameBook',
        book: 'The game',
        name: 'The maze',
      })
      expect(Object.values(after).filter((text) => text.includes('The game'))).toEqual([])
      expect(after['/corpus/game.loom']).toBe(
        lines('---', 'Book: The maze', '---', '', '# The maze', '', 'A game of rooms.'),
      )
      expect(after['/corpus/grid.loom']).toBe(grid.replace('Book: The game', 'Book: The maze'))
    }),
  )

  it.effect('renames a part where it is announced', () =>
    Effect.gen(function* () {
      const after = yield* afterEdit(game, {
        _tag: 'RenamePart',
        book: 'The game',
        part: 'I',
        name: 'The chamber',
      })
      expect(after['/corpus/grid.loom']).toBe(
        grid.replace('Part I: The room', 'Part I: The chamber'),
      )
      expect(after['/corpus/walls.loom']).toBe(walls)
    }),
  )
})

describe('moving and removing parts', () => {
  it.effect('moves a part and numbers the parts again', () =>
    Effect.gen(function* () {
      const after = yield* afterEdit(game, {
        _tag: 'MovePart',
        book: 'The game',
        part: 'II',
        after: null,
      })
      expect(after['/corpus/lamps.loom']).toBe(lamps.replace('Part II: Light', 'Part I: Light'))
      expect(after['/corpus/grid.loom']).toBe(grid.replace('Part I: The room', 'Part II: The room'))
      expect(after['/corpus/walls.loom']).toBe(
        walls
          .replace('Part I, Chapter 2: Walls', 'Part II, Chapter 2: Walls')
          .replace('Part I, Chapter 1, Cells', 'Part II, Chapter 1, Cells'),
      )
      expect(after['/corpus/waking.loom']).toBe(
        waking.replace('Part I, Discussion 1', 'Part II, Discussion 1'),
      )
    }),
  )

  it.effect('removes a part and numbers the parts after it', () =>
    Effect.gen(function* () {
      const answer = yield* edited(game, { _tag: 'RemovePart', book: 'The game', part: 'I' })
      expect(answer.edits.map((edit) => edit.path)).toEqual(['/corpus/lamps.loom'])
      expect(Array.sort(answer.removed, Order.String)).toEqual([
        '/corpus/grid.loom',
        '/corpus/waking.loom',
        '/corpus/walls.loom',
      ])
      expect(appliedTo(game, answer)['/corpus/lamps.loom']).toBe(
        lamps.replace('Part II: Light', 'Part I: Light'),
      )
    }),
  )
})

describe('the sections of a loom', () => {
  const cells = (body: ReadonlyArray<{ readonly _tag: 'Prose' | 'Code'; readonly text: string }>) =>
    afterEdit(game, { _tag: 'ReplaceSection', uri: '/corpus/grid.loom', section: 'Cells', body })

  it.effect('replaces a section body with its marks', () =>
    Effect.gen(function* () {
      const after = yield* cells([
        { _tag: 'Prose', text: 'A cell holds a thing or nothing.' },
        { _tag: 'Code', text: 'export const cells = 16' },
        { _tag: 'Prose', text: 'Sixteen cells make the room.' },
      ])
      expect(after['/corpus/grid.loom']).toBe(
        grid.replace(
          'A cell holds one thing.\n\n=>\n\nexport const cells = 9\n',
          'A cell holds a thing or nothing.\n\n=>\n\nexport const cells = 16\n\n~\n\nSixteen cells make the room.\n',
        ),
      )
      const outline = yield* withCompiler(game, (compiler) => compiler.outline('/corpus/grid.loom'))
      expect((yield* cells(outline.sections[1]?.body ?? []))['/corpus/grid.loom']).toBe(grid)
    }),
  )

  it.effect('fences code that would read as a mark', () =>
    Effect.gen(function* () {
      const after = yield* cells([{ _tag: 'Code', text: '# cells\nexport const cells = 9' }])
      expect(after['/corpus/grid.loom']).toBe(
        grid.replace(
          'A cell holds one thing.\n\n=>\n\nexport const cells = 9\n',
          '=>\n\n```\n# cells\nexport const cells = 9\n```\n',
        ),
      )
    }),
  )

  it.effect('adds, moves, renames, and removes sections', () =>
    Effect.gen(function* () {
      const rows = yield* afterEdit(game, {
        _tag: 'AddSection',
        uri: '/corpus/grid.loom',
        after: 'Cells',
        name: 'Rows',
        body: [{ _tag: 'Prose', text: 'Rows run across.' }],
      })
      expect(rows['/corpus/grid.loom']).toBe(`${grid}\n## Rows\n\nRows run across.\n`)
      const size = yield* afterEdit(game, {
        _tag: 'AddSection',
        uri: '/corpus/grid.loom',
        after: null,
        name: 'Size',
        kind: 'Concept',
        body: [{ _tag: 'Prose', text: 'A size counts cells.' }],
      })
      expect(size['/corpus/grid.loom']).toBe(
        grid.replace('## Cells', '## Size {Concept}\n\nA size counts cells.\n\n## Cells'),
      )
      const order = lines(
        '# Order',
        '',
        '## A',
        '',
        'One.',
        '',
        '## B',
        '',
        'Two.',
        '',
        '## C',
        '',
        'Three.',
      )
      const moved = yield* afterEdit(
        { '/corpus/order.loom': order },
        {
          _tag: 'MoveSection',
          uri: '/corpus/order.loom',
          section: 'C',
          after: null,
        },
      )
      expect(moved['/corpus/order.loom']).toBe(
        lines('# Order', '', '## C', '', 'Three.', '', '## A', '', 'One.', '', '## B', '', 'Two.'),
      )
      const renamed = yield* afterEdit(game, {
        _tag: 'RenameSection',
        uri: '/corpus/grid.loom',
        section: 'Cells',
        name: 'Squares',
      })
      expect(renamed['/corpus/grid.loom']).toBe(grid.replace('## Cells', '## Squares'))
      expect(renamed['/corpus/walls.loom']).toBe(
        walls.replace('Chapter 1, Cells', 'Chapter 1, Squares'),
      )
      const removed = yield* afterEdit(quiet, {
        _tag: 'RemoveSection',
        uri: '/corpus/grid.loom',
        section: 'Cells',
      })
      expect(removed['/corpus/grid.loom']).toBe(grid.slice(0, grid.indexOf('\n## Cells')))
    }),
  )

  it.effect('refuses a name taken, a section missing, and a section that breaks its loom', () =>
    Effect.gen(function* () {
      const rename = { _tag: 'RenameSection', uri: '/corpus/grid.loom', section: 'Cells' } as const
      expect(yield* refused(game, { ...rename, name: 'The grid' })).toBe('SectionExists')
      expect(yield* refused(game, { ...rename, section: 'Rows', name: 'Lines' })).toBe(
        'NoSuchSection',
      )
      expect(
        yield* refused(game, {
          _tag: 'AddSection',
          uri: '/corpus/grid.loom',
          name: 'Ghost',
          kind: 'Bogus',
          body: [],
        }),
      ).toBe('EditBreaksLoom')
    }),
  )
})

describe('sections with keys', () => {
  const paint = {
    _tag: 'ReplaceSection',
    uri: '/corpus/plan.loom',
    section: 'Paint the walls',
    body: [{ _tag: 'Prose', text: 'Two coats.' }],
  } as const

  it.effect('writes the keys of a new section, and of a section given its body', () =>
    Effect.gen(function* () {
      const added = yield* afterEdit(tasks, {
        _tag: 'AddSection',
        uri: '/corpus/plan.loom',
        name: 'Hang the lamps',
        kind: 'Task',
        parameters: { status: 'todo', tags: ['light', 'first floor'] },
        body: [{ _tag: 'Prose', text: 'Two lamps a room.' }],
      })
      expect(added['/corpus/plan.loom']).toBe(
        `${plan}\n## Hang the lamps {kind=Task status=todo tags=[light, "first floor"]}\n\nTwo lamps a room.\n`,
      )
      const done = yield* afterEdit(tasks, { ...paint, parameters: { status: 'done' } })
      expect(done['/corpus/plan.loom']).toBe(plan.replace('status=todo', 'status=done'))
      expect((yield* afterEdit(tasks, paint))['/corpus/plan.loom']).toBe(plan)
      const owned = yield* afterEdit(tasks, {
        _tag: 'ReplaceSection',
        uri: '/corpus/plan.loom',
        section: 'The plan',
        body: [{ _tag: 'Prose', text: 'What the game still needs.' }],
        parameters: { owner: 'Yegor' },
      })
      expect(owned['/corpus/plan.loom']).toBe(plan.replace('# The plan', '# The plan {owner=Yegor}'))
    }),
  )

  it.effect('refuses a key braces cannot hold, and a value its kind does not take', () =>
    Effect.gen(function* () {
      const sweep = (parameters: Readonly<Record<string, string>>) =>
        Effect.map(
          refusal(tasks, {
            _tag: 'AddSection',
            uri: '/corpus/plan.loom',
            name: 'Sweep',
            kind: 'Task',
            parameters,
            body: [],
          }),
          (failed) => (failed._tag === 'UnfitParameter' ? failed.key : failed._tag),
        )
      expect(yield* sweep({ 'two words': 'x' })).toBe('two words')
      expect(yield* sweep({ kind: 'Task' })).toBe('kind')
      expect(yield* sweep({ status: 'two\nlines' })).toBe('status')
      expect(yield* sweep({ status: 'maybe' })).toBe('EditBreaksLoom')
    }),
  )
})

describe('notes and boxes', () => {
  it.effect('leaves a note, keeps it through a new body, and resolves it', () =>
    Effect.gen(function* () {
      const noted = yield* afterEdit(game, {
        _tag: 'AddBox',
        uri: '/corpus/grid.loom',
        section: 'Cells',
        text: 'Count them again.',
      })
      expect(noted['/corpus/grid.loom']).toBe(
        grid.replace(
          'A cell holds one thing.\n',
          'A cell holds one thing.\n\n:::\nCount them again.\n:::\n',
        ),
      )
      const rewritten = yield* afterEdit(noted, {
        _tag: 'ReplaceSection',
        uri: '/corpus/grid.loom',
        section: 'Cells',
        body: [{ _tag: 'Prose', text: 'A cell holds a thing.' }],
      })
      expect(rewritten['/corpus/grid.loom']).toBe(
        grid.replace(
          'A cell holds one thing.\n\n=>\n\nexport const cells = 9\n',
          'A cell holds a thing.\n\n:::\nCount them again.\n:::\n',
        ),
      )
      const resolved = yield* afterEdit(noted, {
        _tag: 'ResolveNote',
        uri: '/corpus/grid.loom',
        section: 'Cells',
        text: 'Count them again.',
      })
      expect(resolved['/corpus/grid.loom']).toBe(grid)
      expect(
        yield* refused(game, {
          _tag: 'ResolveNote',
          uri: '/corpus/grid.loom',
          section: 'Cells',
          text: 'Count them again.',
        }),
      ).toBe('NoSuchNote')
    }),
  )

  it.effect('leaves a box of a declared kind with its name and its keys', () =>
    Effect.gen(function* () {
      const estimate = (parameters: Readonly<Record<string, string>>) =>
        afterEdit(tasks, {
          _tag: 'AddBox',
          uri: '/corpus/plan.loom',
          section: 'Paint the walls',
          kind: 'Estimate',
          name: 'Walls',
          parameters,
          text: 'Two days, three with drying.',
        })
      const boxed = (opener: string) =>
        plan.replace('Two coats.\n', `Two coats.\n\n${opener}\nTwo days, three with drying.\n:::\n`)
      expect((yield* estimate({}))['/corpus/plan.loom']).toBe(boxed('::: Walls {Estimate}'))
      expect((yield* estimate({ days: '2' }))['/corpus/plan.loom']).toBe(
        boxed('::: Walls {kind=Estimate days=2}'),
      )
      expect(
        yield* refused(tasks, {
          _tag: 'AddBox',
          uri: '/corpus/plan.loom',
          section: 'Paint the walls',
          kind: 'Bogus',
          text: 'Hm.',
        }),
      ).toBe('EditBreaksLoom')
    }),
  )
})

describe('discussions', () => {
  it.effect('opens a topic, adds messages, and concludes a topic', () =>
    Effect.gen(function* () {
      const opened = yield* afterEdit(game, {
        _tag: 'OpenTopic',
        uri: '/corpus/waking.loom',
        name: 'Light',
      })
      expect(opened['/corpus/waking.loom']).toBe(`${waking}\nLight\n---\n`)
      const answered = yield* afterEdit(game, {
        _tag: 'AddMessage',
        uri: '/corpus/waking.loom',
        topic: 'Traps',
        author: 'Claude',
        text: 'A trap going off.',
      })
      expect(answered['/corpus/waking.loom']).toBe(`${waking}\n~ Claude\nA trap going off.\n`)
      const concluded = yield* afterEdit(answered, {
        _tag: 'Conclude',
        uri: '/corpus/waking.loom',
        topic: 'Traps',
        text: 'Traps wake monsters.',
      })
      expect(concluded['/corpus/waking.loom']).toBe(
        `${answered['/corpus/waking.loom']}\n::: {Conclusion}\nTraps wake monsters.\n:::\n`,
      )
      const again = yield* afterEdit(concluded, {
        _tag: 'Conclude',
        uri: '/corpus/waking.loom',
        topic: 'Traps',
        text: 'A trap within hearing wakes a monster.',
      })
      expect(again['/corpus/waking.loom']).toBe(
        (concluded['/corpus/waking.loom'] ?? '').replace(
          'Traps wake monsters.',
          'A trap within hearing wakes a monster.',
        ),
      )
      const late = yield* afterEdit(concluded, {
        _tag: 'AddMessage',
        uri: '/corpus/waking.loom',
        topic: 'Traps',
        author: 'Yegor',
        text: 'Agreed.',
      })
      expect(late['/corpus/waking.loom']).toBe(
        (concluded['/corpus/waking.loom'] ?? '').replace(
          '::: {Conclusion}',
          '~ Yegor\nAgreed.\n\n::: {Conclusion}',
        ),
      )
      expect(
        yield* refused(game, { _tag: 'OpenTopic', uri: '/corpus/grid.loom', name: 'Light' }),
      ).toBe('NotADiscussion')
    }),
  )
})

describe('the configuration', () => {
  it.effect('sets a variable, and refuses a workspace with no configuration', () =>
    Effect.gen(function* () {
      const variable = { _tag: 'SetVariable', name: 'version', value: '0.2.0' } as const
      const answer = yield* edited(game, variable)
      expect([answer.made, answer.edits]).toEqual([[], []])
      expect(answer.configuration).toEqual(
        Option.some(
          lines(
            'languages:',
            '  typescript: {}',
            'corpus: corpus',
            'variables:',
            '  version: 0.2.0',
          ),
        ),
      )
      const failed = yield* Effect.flip(edited(game, variable, Option.none()))
      expect(failed._tag).toBe('NoConfiguration')
    }),
  )
})

describe('removals that break a loom they never touch', () => {
  it.effect('removes what another loom composes, and leaves that loom as it was', () =>
    Effect.gen(function* () {
      const bricks = {
        ...quiet,
        '/corpus/walls.loom': `${quiet['/corpus/walls.loom']}\n## Bricks\n\n=>\n\nexport const bricks = 4\n`,
        '/corpus/lamps.loom': `${lamps}\n=>\n\n${anchor('Walls, Bricks')}\n`,
      }
      const walled = yield* edited(bricks, { _tag: 'RemoveLoom', uri: '/corpus/walls.loom' })
      expect([walled.removed, walled.edits.map((edit) => edit.path)]).toEqual([
        ['/corpus/walls.loom'],
        [],
      ])
      const composing = {
        ...quiet,
        '/corpus/walls.loom': `${quiet['/corpus/walls.loom']}\n=>\n\n${anchor('Part I, Chapter 1, Cells')}\n`,
      }
      const celled = yield* afterEdit(composing, {
        _tag: 'RemoveSection',
        uri: '/corpus/grid.loom',
        section: 'Cells',
      })
      expect([
        celled['/corpus/grid.loom']?.includes('## Cells'),
        celled['/corpus/walls.loom'],
      ]).toEqual([false, composing['/corpus/walls.loom']])
      const noted = {
        ...quiet,
        '/corpus/notes.loom': lines(
          '---',
          'Chapter: Notes',
          'Book: The game',
          '---',
          '',
          '# Notes',
          '',
          '=>',
          '',
          anchor('The room, The grid, Cells'),
        ),
      }
      const parted = yield* afterEdit(noted, { _tag: 'RemovePart', book: 'The game', part: 'I' })
      expect(parted['/corpus/notes.loom']).toBe(noted['/corpus/notes.loom'])
    }),
  )
})

describe('numbered names that follow their loom', () => {
  const following = {
    ...quiet,
    '/corpus/lamps.loom': `${lamps}\n=>\n\n${anchor('Part I, Chapter 1, Cells')}\n`,
  }

  it.effect('writes the path to a loom that moves', () =>
    Effect.gen(function* () {
      const after = yield* afterEdit(following, {
        _tag: 'MoveLoom',
        uri: '/corpus/grid.loom',
        book: 'The game',
        part: 'II',
        after: '/corpus/lamps.loom',
      })
      expect(after['/corpus/lamps.loom']).toBe(
        `${lamps}\n=>\n\n${anchor('Part II, Chapter 2, Cells')}\n`,
      )
      expect(after['/corpus/grid.loom']).toBe(
        grid.replace(
          'Part I: The room\nChapter 1: The grid',
          'Part II: Light\nChapter 2: The grid',
        ),
      )
      expect(after['/corpus/walls.loom']).toBe(
        (quiet['/corpus/walls.loom'] ?? '').replace(
          'Part I, Chapter 2: Walls\n',
          'Part I: The room\nChapter 1: Walls\n',
        ),
      )
    }),
  )

  it.effect('names a removed loom by its title, so nothing composes another in its place', () =>
    Effect.gen(function* () {
      const failed = yield* refusal(following, { _tag: 'RemoveLoom', uri: '/corpus/grid.loom' })
      expect(failed._tag === 'EditBreaksLoom' ? failed.path : failed._tag).toBe(
        '/corpus/lamps.loom',
      )
      const after = yield* afterEdit(game, { _tag: 'RemoveLoom', uri: '/corpus/grid.loom' })
      expect(after['/corpus/walls.loom']).toBe(
        walls
          .replace('Part I, Chapter 2: Walls\n', 'Part I: The room\nChapter 1: Walls\n')
          .replace('Part I, Chapter 1, Cells', 'Part I, The grid, Cells'),
      )
    }),
  )
})

describe('words a writer cannot smuggle in', () => {
  const unfit = (intent: LoomIntent) =>
    Effect.map(refusal(game, intent), (failed) =>
      failed._tag === 'UnfitText' ? failed.line : failed._tag,
    )
  const cells = (text: string): LoomIntent => ({
    _tag: 'ReplaceSection',
    uri: '/corpus/grid.loom',
    section: 'Cells',
    body: [{ _tag: 'Prose', text }],
  })
  const message = (text: string): LoomIntent => ({
    _tag: 'AddMessage',
    uri: '/corpus/waking.loom',
    topic: 'Traps',
    author: 'Claude',
    text,
  })

  it.effect('refuses a line that would read as syntax, and keeps a quoted one', () =>
    Effect.gen(function* () {
      expect(yield* unfit(cells('Intro.\n\n## Smuggled\n\n=>\n\nrm()'))).toBe('## Smuggled')
      expect(yield* unfit(message('Agreed.\n---'))).toBe('---')
      expect(yield* unfit(message('~ Mallory\nI agree.'))).toBe('~ Mallory')
      expect(
        yield* unfit({
          _tag: 'AddBox',
          uri: '/corpus/grid.loom',
          section: 'Cells',
          text: 'Check.\n:::\nOutside.',
        }),
      ).toBe(':::')
      expect(yield* unfit(cells('A loom opens so:\n\n```\n## A heading'))).toBe('```')
      const quoted = yield* afterEdit(game, cells('A loom opens so:\n\n```\n## A heading\n```'))
      expect(quoted['/corpus/grid.loom']).toBe(
        grid.replace(
          'A cell holds one thing.\n\n=>\n\nexport const cells = 9\n',
          'A loom opens so:\n\n```\n## A heading\n```\n',
        ),
      )
    }),
  )
})

describe('looms written on Windows', () => {
  const crlf = (files: Record<string, string>): Record<string, string> =>
    Object.fromEntries(
      Object.entries(files).map(([path, text]) => [path, text.replace(/\n/g, '\r\n')]),
    )

  it.effect('writes an edit in the line ending of its loom', () =>
    Effect.gen(function* () {
      const note = {
        _tag: 'AddBox',
        uri: '/corpus/grid.loom',
        section: 'Cells',
        text: 'Count them again.',
      } as const
      const noted = yield* afterEdit(crlf(game), note)
      expect(noted['/corpus/grid.loom']).toBe(
        (yield* afterEdit(game, note))['/corpus/grid.loom']?.replace(/\n/g, '\r\n'),
      )
      const resolved = yield* afterEdit(noted, { ...note, _tag: 'ResolveNote' })
      expect(resolved['/corpus/grid.loom']).toBe(grid.replace(/\n/g, '\r\n'))
      const removed = yield* afterEdit(crlf(quiet), {
        _tag: 'RemoveSection',
        uri: '/corpus/grid.loom',
        section: 'Cells',
      })
      expect(removed['/corpus/grid.loom']).toBe(
        grid.slice(0, grid.indexOf('\n## Cells')).replace(/\n/g, '\r\n'),
      )
    }),
  )
})

describe('a new part before an old one', () => {
  it.effect('hands a part its new number with its announcement', () =>
    Effect.gen(function* () {
      const glow = lines(
        '---',
        'Part II, Chapter 2: Glow',
        'Book: The game',
        '---',
        '',
        '# Glow',
        '',
        'Lamps glow.',
      )
      const after = yield* afterEdit(
        { ...game, '/corpus/glow.loom': glow },
        {
          _tag: 'MoveLoom',
          uri: '/corpus/lamps.loom',
          book: 'The game',
          part: { name: 'Middle', after: 'I' },
        },
      )
      expect(after['/corpus/lamps.loom']).toBe(lamps.replace('Part II: Light', 'Part II: Middle'))
      expect(after['/corpus/glow.loom']).toBe(
        lines(
          '---',
          'Part III: Light',
          'Chapter 1: Glow',
          'Book: The game',
          '---',
          '',
          '# Glow',
          '',
          'Lamps glow.',
        ),
      )
    }),
  )
})

describe('sections beneath sections', () => {
  const nested = {
    '/corpus/order.loom': lines(
      '# Order',
      '',
      '## Cells',
      '',
      'One.',
      '',
      '### Deep',
      '',
      'Deeper.',
      '',
      '## Rows',
      '',
      'Two.',
    ),
  }
  const order = (intent: LoomIntent) =>
    Effect.map(afterEdit(nested, intent), (after) => after['/corpus/order.loom'])

  it.effect('removes, moves, and adds a section with the sections beneath it', () =>
    Effect.gen(function* () {
      const uri = '/corpus/order.loom'
      expect(yield* order({ _tag: 'RemoveSection', uri, section: 'Cells' })).toBe(
        lines('# Order', '', '## Rows', '', 'Two.'),
      )
      expect(yield* order({ _tag: 'MoveSection', uri, section: 'Cells', after: 'Rows' })).toBe(
        lines(
          '# Order',
          '',
          '## Rows',
          '',
          'Two.',
          '',
          '## Cells',
          '',
          'One.',
          '',
          '### Deep',
          '',
          'Deeper.',
        ),
      )
      const add = (after: string, name: string): LoomIntent => ({
        _tag: 'AddSection',
        uri,
        after,
        name,
        body: [{ _tag: 'Prose', text: 'New.' }],
      })
      expect(yield* order(add('Cells', 'Walls'))).toBe(
        lines(
          '# Order',
          '',
          '## Cells',
          '',
          'One.',
          '',
          '### Deep',
          '',
          'Deeper.',
          '',
          '## Walls',
          '',
          'New.',
          '',
          '## Rows',
          '',
          'Two.',
        ),
      )
      expect(yield* order(add('Deep', 'Deepest'))).toBe(
        lines(
          '# Order',
          '',
          '## Cells',
          '',
          'One.',
          '',
          '### Deep',
          '',
          'Deeper.',
          '',
          '### Deepest',
          '',
          'New.',
          '',
          '## Rows',
          '',
          'Two.',
        ),
      )
      expect(yield* refused(nested, { _tag: 'RemoveSection', uri, section: 'Order' })).toBe(
        'OpensTheLoom',
      )
      expect(yield* refused(nested, { _tag: 'MoveSection', uri, section: 'Order' })).toBe(
        'OpensTheLoom',
      )
    }),
  )
})

describe('a loom with no title heading', () => {
  it.effect('retitles the frontmatter alone, and adds a first section before the others', () =>
    Effect.gen(function* () {
      const notes = {
        '/corpus/notes.loom': lines('---', 'Chapter: Notes', '---', '', '## First', '', 'One.'),
      }
      const retitled = yield* afterEdit(notes, {
        _tag: 'RetitleLoom',
        uri: '/corpus/notes.loom',
        title: 'Jottings',
      })
      expect(retitled['/corpus/notes.loom']).toBe(
        lines('---', 'Chapter: Jottings', '---', '', '## First', '', 'One.'),
      )
      const added = yield* afterEdit(notes, {
        _tag: 'AddSection',
        uri: '/corpus/notes.loom',
        after: null,
        name: 'Zero',
        body: [{ _tag: 'Prose', text: 'Nothing.' }],
      })
      expect(added['/corpus/notes.loom']).toBe(
        lines(
          '---',
          'Chapter: Notes',
          '---',
          '',
          '## Zero',
          '',
          'Nothing.',
          '',
          '## First',
          '',
          'One.',
        ),
      )
    }),
  )
})

describe('a configuration kept as written', () => {
  it.effect('sets one value and leaves the rest of the file as it was', () =>
    Effect.gen(function* () {
      const settings = (version: string) =>
        lines(
          "# The game's settings",
          'corpus: corpus',
          'languages:',
          '  typescript: {}',
          'future: kept',
          'variables:',
          `  version: ${version}`,
        )
      const configured = { ...game, '/.loom/config.yaml': settings('0.1.19') }
      const answer = yield* edited(configured, {
        _tag: 'SetVariable',
        name: 'version',
        value: '0.2.0',
      })
      expect(answer.configuration).toEqual(Option.some(settings('0.2.0')))
      expect(
        yield* refused(configured, { _tag: 'SetVariable', name: 'not a name', value: '1' }),
      ).toBe('NotAVariableName')
    }),
  )
})

describe('kinds and languages on one line', () => {
  it.effect('refuses a kind or a language on two lines, and quotes a language in full', () =>
    Effect.gen(function* () {
      const doors = {
        _tag: 'MakeLoom',
        uri: '/corpus/doors.loom',
        kind: 'Chapter',
        book: 'The game',
        part: 'I',
        title: 'Doors',
      } as const
      expect(yield* refused(game, { ...doors, language: 'x\nBook: Other' })).toBe('UnfitName')
      expect(yield* refused(game, { ...doors, kind: 'Chapter\nBook: Other' })).toBe('UnfitName')
      const ghost = yield* afterEdit(game, {
        _tag: 'AddSection',
        uri: '/corpus/grid.loom',
        name: 'Ghost',
        language: 'my "lang"',
        body: [],
      })
      expect(ghost['/corpus/grid.loom']).toBe(`${grid}\n## Ghost {lang="my \\"lang\\""}\n`)
      const outline = yield* withCompiler(ghost, (compiler) =>
        compiler.outline('/corpus/grid.loom'),
      )
      expect(outline.sections.map((section) => section.language)).toContain('my "lang"')
    }),
  )
})

describe('parts that close their gaps', () => {
  const one = lines('---', 'Part I: First', 'Chapter 1: One', '---', '', '# One')
  const two = lines('---', 'Part II: Second', 'Chapter 1: Two', '---', '', '# Two')
  const rooms = { '/corpus/one.loom': one, '/corpus/two.loom': two }

  it.effect('numbers the parts after a part its last loom leaves', () =>
    Effect.gen(function* () {
      const answer = yield* edited(rooms, { _tag: 'RemoveLoom', uri: '/corpus/one.loom' })
      expect(answer.removed).toEqual(['/corpus/one.loom'])
      expect(appliedTo(rooms, answer)['/corpus/two.loom']).toBe(
        two.replace('Part II: Second', 'Part I: Second'),
      )
      const moved = yield* afterEdit(rooms, {
        _tag: 'MoveLoom',
        uri: '/corpus/one.loom',
        book: '',
        part: 'II',
        after: '/corpus/two.loom',
      })
      expect(moved['/corpus/one.loom']).toBe(
        lines('---', 'Part I: Second', 'Chapter 2: One', '---', '', '# One'),
      )
      expect(moved['/corpus/two.loom']).toBe(two.replace('Part II: Second', 'Part I: Second'))
    }),
  )

  it.effect('removes a part of discussions alone', () =>
    Effect.gen(function* () {
      const talk = lines(
        '---',
        'Part III, Discussion 1: Talk',
        'Book: The game',
        '---',
        '',
        '# Talk',
      )
      const answer = yield* edited(
        { ...game, '/corpus/talk.loom': talk },
        { _tag: 'RemovePart', book: 'The game', part: 'III' },
      )
      expect([answer.removed, answer.edits]).toEqual([['/corpus/talk.loom'], []])
    }),
  )

  it.effect('gives a new part no number among numberless parts, and no name like a number', () =>
    Effect.gen(function* () {
      const sketch = lines('---', 'Part: Drafts', 'Chapter: Sketch', '---', '', '# Sketch')
      const after = yield* afterEdit(
        { '/corpus/sketch.loom': sketch },
        {
          _tag: 'MakeLoom',
          uri: '/corpus/spark.loom',
          kind: 'Chapter',
          book: '',
          part: { name: 'Ideas' },
          title: 'Spark',
        },
      )
      expect(after['/corpus/spark.loom']).toBe(
        lines('---', 'Part: Ideas', 'Chapter 1: Spark', '---', '', '# Spark'),
      )
      expect(
        yield* refused(game, { _tag: 'RenamePart', book: 'The game', part: 'I', name: 'IV' }),
      ).toBe('PartNameIsNumber')
      expect(
        yield* refused(game, {
          _tag: 'MakeLoom',
          uri: '/corpus/keys.loom',
          kind: 'Chapter',
          book: 'The game',
          part: { name: 'IX' },
          title: 'Keys',
        }),
      ).toBe('PartNameIsNumber')
    }),
  )
})

describe('titles, followers, and things that stay', () => {
  it.effect(
    'folds titles, refuses a follower of another kind, and leaves a thing after itself',
    () =>
      Effect.gen(function* () {
        const doors = {
          _tag: 'MakeLoom',
          uri: '/corpus/doors.loom',
          kind: 'Chapter',
          book: 'The game',
          part: 'I',
          title: 'Doors',
        } as const
        expect(yield* refused(game, { ...doors, title: 'the grid' })).toBe('TitleTaken')
        expect(yield* refused(game, { ...doors, after: '/corpus/waking.loom' })).toBe('NotOfKind')
        const stayed = yield* edited(game, {
          _tag: 'MoveLoom',
          uri: '/corpus/grid.loom',
          book: 'The game',
          part: 'I',
          after: '/corpus/grid.loom',
        })
        expect(stayed.edits).toEqual([])
        const kept = yield* edited(game, {
          _tag: 'MovePart',
          book: 'The game',
          part: 'I',
          after: 'I',
        })
        expect(kept.edits).toEqual([])
      }),
  )
})
