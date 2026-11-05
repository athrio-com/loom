import { describe, expect, it as it_ } from 'bun:test'
import { effectify } from '@athrio/effect-test'
import { Effect, Layer, Option } from 'effect'
import type { Diagnostic } from '@athrio/loom-ast/LoomNode'
import { DocumentSource, LoomCompiler, type SummaryEdit } from '../src/LoomCompiler'
import { WorkspaceSettings } from '../src/WorkspaceSettings'
import { LoomDiskCache } from '../src/LoomDiskCache'
import { FileSystemSource } from '../src/WorkspaceSource'
import { defaultAnchorDelims } from '@athrio/loom-ast/LoomTokens'

const it = effectify(it_)

// A box of the `Chapter` kind points to the chapter its name titles. Before the
// chapter is written, the box carries a note whose fix writes the chapter, and an
// anchor beside the box resolves to it as a section to be settled. Once the chapter
// exists, the box's body is a copy of the chapter's opening prose: a copy that
// differs is a warning, whose fix copies the opening in, and `summaries` refreshes
// every copy at once. Navigation reads the box's name as a name for the chapter.

const lines = (...rows: ReadonlyArray<string>): string => `${rows.join('\n')}\n`

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

const withCompiler = <A>(
  files: Record<string, string>,
  use: (compiler: LoomCompiler['Service']) => Effect.Effect<A>,
) => LoomCompiler.pipe(Effect.flatMap(use), Effect.provide(layerOf(files)))

const diagnosed = (files: Record<string, string>, entry: string) =>
  withCompiler(files, (compiler) => compiler.diagnose(entry))

const world = '/corpus/02-shape/01-world.loom'
const light = '/corpus/02-shape/02-light.loom'
const rooms = '/corpus/02-shape/03-rooms.loom'

const worldLoom = (body: ReadonlyArray<string>) =>
  lines(
    '---',
    'Part II, Chapter 1: The world',
    'Language: TypeScript',
    '---',
    '',
    '# The world',
    '',
    'The world holds rooms.',
    '',
    '::: Rooms {Chapter}',
    ...body,
    ':::',
    '',
    '## The program [world.ts]',
    '',
    'The program places the rooms.',
    '',
    '=>',
    '::[Rooms]',
  )

const lightLoom = lines(
  '---',
  'Part II, Chapter 2: Light',
  'Language: TypeScript',
  '---',
  '',
  '# Light',
  '',
  'Light falls on every room.',
)

const roomsLoom = (opening: string) =>
  lines(
    '---',
    'Part II, Chapter 3: Rooms',
    'Status: Canvas',
    'Language: TypeScript',
    '---',
    '',
    '# Rooms',
    '',
    opening,
  )

const unwritten = { [world]: worldLoom(['A room is a grid of cells.']), [light]: lightLoom }

const messages = (found: ReadonlyArray<Diagnostic>) => found.map((d) => d.message)

describe('a chapter box whose chapter is not written', () => {
  it.effect('carries a note whose fix writes the chapter as the next of its part', () =>
    Effect.gen(function* () {
      const found = yield* diagnosed(unwritten, world)
      const note = found.find((d) => d.message.startsWith('To be settled: no chapter'))
      expect(note?.severity).toBe('info')
      expect(note?.message).toBe(
        "To be settled: no chapter is titled `Rooms` yet. Open it from this box, and the box's body becomes its opening.",
      )
      expect(note?.fixes).toEqual([
        {
          title: 'Open the chapter `Rooms`',
          file: rooms,
          text: roomsLoom('A room is a grid of cells.'),
        },
      ])
    }),
  )

  it.effect('lets an anchor beside it resolve, to be settled rather than missing', () =>
    Effect.gen(function* () {
      const found = messages(yield* diagnosed(unwritten, world))
      expect(found).toContain(
        'To be settled: `Rooms` holds no code yet, so this anchor composes nothing.',
      )
      expect(found.some((m) => m.startsWith('Unresolved anchor'))).toBe(false)
    }),
  )

  it.effect('opens a chapter of a part without numbers by its title alone', () =>
    Effect.gen(function* () {
      const ideas = '/corpus/wip/ideas.loom'
      const found = yield* diagnosed(
        {
          [ideas]: lines(
            '---',
            'Part: Work in progress',
            'Chapter: Ideas',
            '---',
            '',
            '# Ideas',
            '',
            '::: Rooms {Chapter}',
            ':::',
          ),
        },
        ideas,
      )
      const note = found.find((d) => d.message.startsWith('To be settled: no chapter'))
      expect(note?.fixes).toEqual([
        {
          title: 'Open the chapter `Rooms`',
          file: '/corpus/wip/rooms.loom',
          text: lines('---', 'Part: Work in progress', 'Chapter: Rooms', 'Status: Canvas', '---', '', '# Rooms'),
        },
      ])
    }),
  )
})

describe('a chapter box whose chapter is written', () => {
  it.effect('is in step when its body matches the opening of its chapter', () =>
    Effect.gen(function* () {
      const files = { ...unwritten, [rooms]: roomsLoom('A room is a grid of cells.') }
      const found = messages(yield* diagnosed(files, world))
      expect(found.some((m) => m.startsWith('To be settled: no chapter'))).toBe(false)
      expect(found.some((m) => m.startsWith('Summary out of step'))).toBe(false)
      expect(found).toContain(
        'Chapter `Rooms` opens with a section that holds no code, so this anchor composes nothing.',
      )
    }),
  )

  it.effect('warns when its body differs, with a fix that copies the opening in', () =>
    Effect.gen(function* () {
      const files = { ...unwritten, [rooms]: roomsLoom('Rooms are grids.') }
      const found = yield* diagnosed(files, world)
      const stale = found.find((d) => d.message.startsWith('Summary out of step'))
      expect(stale?.severity).toBe('warning')
      const fix = stale?.fixes?.[0]
      expect(fix?.title).toBe('Copy the opening of `Rooms`')
      const at = Option.getOrThrow(Option.fromNullishOr(fix?.at))
      const text = files[world]!
      const fixed = text.slice(0, at.start.offset) + fix!.text + text.slice(at.end.offset)
      expect(fixed).toBe(worldLoom(['Rooms are grids.']))
    }),
  )

  it.effect('refreshes every stale copy through summaries', () =>
    Effect.gen(function* () {
      const files = { ...unwritten, [rooms]: roomsLoom('Rooms are grids.') }
      const refreshed = yield* withCompiler(files, (compiler) => compiler.summaries(world))
      expect(refreshed).toEqual([{ path: world, text: worldLoom(['Rooms are grids.']) }])
    }),
  )

  it.effect('leaves the boxes out of the opening it copies', () =>
    Effect.gen(function* () {
      const files = {
        ...unwritten,
        [rooms]: lines(
          '---',
          'Part II, Chapter 3: Rooms',
          '---',
          '',
          '# Rooms',
          '',
          'A room is a grid of cells.',
          '',
          ':::',
          'A remark for the next author.',
          ':::',
        ),
      }
      const found = messages(yield* diagnosed(files, world))
      expect(found.some((m) => m.startsWith('Summary out of step'))).toBe(false)
    }),
  )
})

describe('navigating from a chapter box', () => {
  const files = { ...unwritten, [rooms]: roomsLoom('A room is a grid of cells.') }
  const boxName = files[world]!.indexOf('Rooms {Chapter}') + 1

  it.effect('follows its name to the chapter', () =>
    Effect.gen(function* () {
      const found = yield* withCompiler(files, (compiler) => compiler.definition(world, boxName))
      expect(found?.path).toBe(rooms)
      expect(found?.range.start.line).toBe(1)
    }),
  )

  it.effect('lists the box among the names of its chapter', () =>
    Effect.gen(function* () {
      const found = yield* withCompiler(files, (compiler) => compiler.references(world, boxName))
      expect(found.map((location) => location.path)).toContain(world)
      expect(found.map((location) => location.path)).toContain(rooms)
    }),
  )
})

describe('the place of a chapter box', () => {
  it.effect('faults a chapter box in a section that holds code', () =>
    Effect.gen(function* () {
      const loom = '/corpus/beside.loom'
      const found = messages(
        yield* diagnosed(
          { [loom]: lines('# Beside', '', '::: Rooms {Chapter}', ':::', '', '=>', 'const x = 1') },
          loom,
        ),
      )
      expect(found).toContain(
        'Chapter box beside code: this box marks where the chapter `Rooms` begins, so the code of its section belongs in that chapter. Move the code there, or move the box into a section of its own.',
      )
    }),
  )

  it.effect('faults a chapter box with no name', () =>
    Effect.gen(function* () {
      const loom = '/corpus/nameless.loom'
      const found = messages(
        yield* diagnosed({ [loom]: lines('# Nameless', '', '::: {Chapter}', ':::') }, loom),
      )
      expect(found).toContain(
        'Chapter box without a name: a box of the `Chapter` kind points to the chapter its name titles, so it needs a name, as in `::: Rooms {Chapter}`.',
      )
    }),
  )
})

describe('keeping a chapter box in step as the author types', () => {
  const offsetOf = (text: string, at: { readonly line: number; readonly character: number }) =>
    text.split('\n').slice(0, at.line).join('\n').length + (at.line > 0 ? 1 : 0) + at.character

  const applied = (text: string, edit: SummaryEdit) =>
    text.slice(0, offsetOf(text, edit.range.start)) + edit.text + text.slice(offsetOf(text, edit.range.end))

  const inStep = { ...unwritten, [rooms]: roomsLoom('A room is a grid of cells.') }

  const edits = (files: Record<string, string>, path: string, before: string, after: string) =>
    withCompiler(files, (compiler) => compiler.summaryEdits(path, before, after))

  it.effect('writes an edit to a box into the opening of its chapter', () =>
    Effect.gen(function* () {
      const found = yield* edits(inStep, world, inStep[world]!, worldLoom(['A room is a grid.']))
      expect(found.map((edit) => edit.path)).toEqual([rooms])
      expect(applied(inStep[rooms]!, found[0]!)).toBe(roomsLoom('A room is a grid.'))
    }),
  )

  it.effect('writes an edit to the opening of a chapter into its boxes', () =>
    Effect.gen(function* () {
      const found = yield* edits(inStep, rooms, inStep[rooms]!, roomsLoom('Rooms are grids.'))
      expect(found.map((edit) => edit.path)).toEqual([world])
      expect(applied(inStep[world]!, found[0]!)).toBe(worldLoom(['Rooms are grids.']))
    }),
  )

  it.effect('carries nothing from a box that was already out of step', () =>
    Effect.gen(function* () {
      const stale = { ...unwritten, [rooms]: roomsLoom('Rooms are grids.') }
      expect(
        yield* edits(stale, world, stale[world]!, worldLoom(['A room is a grid.'])),
      ).toEqual([])
    }),
  )

  it.effect('carries nothing when the edit leaves the box as it was', () =>
    Effect.gen(function* () {
      const after = inStep[world]!.replace('The world holds rooms.', 'The world holds many rooms.')
      expect(yield* edits(inStep, world, inStep[world]!, after)).toEqual([])
    }),
  )

  it.effect('leaves an opening that holds a box of its own to the author', () =>
    Effect.gen(function* () {
      const noted = lines(
        '---',
        'Part II, Chapter 3: Rooms',
        '---',
        '',
        '# Rooms',
        '',
        'A room is a grid of cells.',
        '',
        ':::',
        'A remark for the next author.',
        ':::',
      )
      const files = { ...unwritten, [rooms]: noted }
      expect(yield* edits(files, world, files[world]!, worldLoom(['A room is a grid.']))).toEqual([])
    }),
  )
})
