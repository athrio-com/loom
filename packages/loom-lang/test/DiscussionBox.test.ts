import { describe, expect, it as it_ } from 'bun:test'
import { effectify } from '@athrio/effect-test'
import { Effect, Layer, Option } from 'effect'
import type { Diagnostic } from '@athrio/loom-ast/LoomNode'
import { defaultAnchorDelims } from '@athrio/loom-ast/LoomTokens'
import { DocumentSource, LoomCompiler, type SummaryEdit } from '../src/LoomCompiler'
import { WorkspaceSettings } from '../src/WorkspaceSettings'
import { LoomDiskCache } from '../src/LoomDiskCache'
import { FileSystemSource } from '../src/WorkspaceSource'

const it = effectify(it_)

const lines = (...rows: ReadonlyArray<string>): string => `${rows.join('\n')}\n`

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

const withCompiler = <A>(
  files: Record<string, string>,
  use: (compiler: LoomCompiler['Service']) => Effect.Effect<A>,
) => LoomCompiler.pipe(Effect.flatMap(use), Effect.provide(layerOf(files)))

const diagnosed = (files: Record<string, string>, entry: string) =>
  withCompiler(files, (compiler) => compiler.diagnose(entry))

const messages = (found: ReadonlyArray<Diagnostic>) => found.map((d) => d.message)

const offsetOf = (text: string, at: { readonly line: number; readonly character: number }) =>
  text.split('\n').slice(0, at.line).join('\n').length + (at.line > 0 ? 1 : 0) + at.character

const applied = (text: string, edit: SummaryEdit) =>
  text.slice(0, offsetOf(text, edit.range.start)) +
  edit.text +
  text.slice(offsetOf(text, edit.range.end))

const rooms = '/corpus/02-shape/01-rooms.loom'
const monsters = '/corpus/02-shape/02-monsters.loom'
const waking = '/corpus/02-shape/discussions/waking.loom'

const roomsLoom = lines('---', 'Part II, Chapter 1: Rooms', '---', '', '# Rooms', '', 'A room.')

const monstersLoom = (body: ReadonlyArray<string>) =>
  lines(
    '---',
    'Part II, Chapter 2: Monsters',
    '---',
    '',
    '# Monsters',
    '',
    'A monster sleeps until something wakes it.',
    '',
    '::: Waking {Discussion}',
    ...body,
    ':::',
  )

const wakingLoom = (first: string) =>
  lines(
    '---',
    'Part II, Discussion 1: Waking',
    '---',
    '',
    '# Waking',
    '',
    'What wakes a monster?',
    '',
    '~ Yegor',
    'Noise, perhaps.',
    '',
    'What wakes it',
    '---',
    '',
    '::: {Conclusion}',
    first,
    ':::',
    '',
    'How it strikes',
    '---',
    '',
    '::: {Conclusion}',
    'It strikes from a distance.',
    ':::',
  )

const summary = (first: string): ReadonlyArray<string> => [
  'What wakes a monster?',
  '',
  first,
  '',
  'It strikes from a distance.',
]

const trap = 'A trap going off within its hearing wakes it.'

const written = (body: ReadonlyArray<string>) => ({
  [rooms]: roomsLoom,
  [monsters]: monstersLoom(body),
  [waking]: wakingLoom(trap),
})

describe('a discussion box whose discussion is not written', () => {
  const unwritten = { [rooms]: roomsLoom, [monsters]: monstersLoom(['What wakes a monster?']) }

  it.effect('carries a note whose fix opens the discussion in its folder', () =>
    Effect.gen(function* () {
      const found = yield* diagnosed(unwritten, monsters)
      const note = found.find((d) => d.message.startsWith('No discussion is titled'))
      expect(note?.severity).toBe('info')
      expect(note?.message).toBe(
        "No discussion is titled `Waking` yet. Open it from this box, and the box's body becomes its opening.",
      )
      expect(note?.fixes).toEqual([
        {
          title: 'Open the discussion `Waking`',
          file: waking,
          text: lines(
            '---',
            'Part II, Discussion 1: Waking',
            '---',
            '',
            '# Waking',
            '',
            'What wakes a monster?',
          ),
        },
      ])
    }),
  )

  it.effect('numbers the new discussion after the discussions of its part', () =>
    Effect.gen(function* () {
      const sleeping = lines('---', 'Part II, Discussion 1: Sleeping', '---', '', '# Sleeping')
      const files = { ...unwritten, '/corpus/02-shape/discussions/sleeping.loom': sleeping }
      const found = yield* diagnosed(files, monsters)
      const note = found.find((d) => d.message.startsWith('No discussion is titled'))
      expect(note?.fixes?.[0]?.text).toContain('Part II, Discussion 2: Waking')
    }),
  )

  it.effect('opens a discussion of a part without numbers by its title alone', () =>
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
            '::: Waking {Discussion}',
            ':::',
          ),
        },
        ideas,
      )
      const note = found.find((d) => d.message.startsWith('No discussion is titled'))
      expect(note?.fixes).toEqual([
        {
          title: 'Open the discussion `Waking`',
          file: '/corpus/wip/discussions/waking.loom',
          text: lines('---', 'Part: Work in progress', 'Discussion: Waking', '---', '', '# Waking'),
        },
      ])
    }),
  )

  it.effect('never points to a chapter of the same title', () =>
    Effect.gen(function* () {
      const chapter = lines(
        '---',
        'Part II, Chapter 3: Waking',
        '---',
        '',
        '# Waking',
        '',
        'A chapter.',
      )
      const files = { ...unwritten, '/corpus/02-shape/03-waking.loom': chapter }
      const found = messages(yield* diagnosed(files, monsters))
      expect(found).toContain(
        "No discussion is titled `Waking` yet. Open it from this box, and the box's body becomes its opening.",
      )
    }),
  )

  it.effect('lets an anchor beside it resolve, to be settled rather than missing', () =>
    Effect.gen(function* () {
      const beside = lines(
        '---',
        'Part II, Chapter 2: Monsters',
        '---',
        '',
        '# Monsters [monsters.ts]',
        '',
        '::: Waking {Discussion}',
        ':::',
        '',
        '=>',
        anchor('Waking'),
      )
      const found = messages(yield* diagnosed({ [rooms]: roomsLoom, [monsters]: beside }, monsters))
      expect(found).toContain('`Waking` holds no code yet, so this anchor composes nothing.')
      expect(found.some((m) => m.startsWith('No section or chapter is called'))).toBe(false)
    }),
  )
})

describe("a discussion box's summary", () => {
  it.effect('is in step when its body holds the opening and the conclusions', () =>
    Effect.gen(function* () {
      const found = messages(yield* diagnosed(written(summary(trap)), monsters))
      expect(found.some((m) => m.startsWith('No discussion is titled'))).toBe(false)
      expect(found.some((m) => m.startsWith('This box no longer matches'))).toBe(false)
    }),
  )

  it.effect('warns when its body differs, with a fix that copies the summary in', () =>
    Effect.gen(function* () {
      const files = written(['What wakes a monster?'])
      const found = yield* diagnosed(files, monsters)
      const stale = found.find((d) => d.message.startsWith('This box no longer matches'))
      expect(stale?.severity).toBe('warning')
      expect(stale?.message).toBe(
        'This box no longer matches the summary of the discussion `Waking`. Copy that summary into it, or run `loom refresh`.',
      )
      const fix = stale?.fixes?.[0]
      expect(fix?.title).toBe('Copy the summary of `Waking`')
      const at = Option.getOrThrow(Option.fromNullishOr(fix?.at))
      const text = files[monsters]!
      const fixed = text.slice(0, at.start.offset) + fix!.text + text.slice(at.end.offset)
      expect(fixed).toBe(monstersLoom(summary(trap)))
    }),
  )

  it.effect('refreshes through summaries', () =>
    Effect.gen(function* () {
      const files = written(['What wakes a monster?'])
      const refreshed = yield* withCompiler(files, (compiler) => compiler.summaries(monsters))
      expect(refreshed).toEqual([{ path: monsters, text: monstersLoom(summary(trap)) }])
    }),
  )
})

describe('the place of a discussion box', () => {
  it.effect('stands beside code without a fault', () =>
    Effect.gen(function* () {
      const loom = '/corpus/beside.loom'
      const found = messages(
        yield* diagnosed(
          {
            [loom]: lines(
              '# Beside',
              '',
              '::: Waking {Discussion}',
              ':::',
              '',
              '=>',
              'const x = 1',
            ),
          },
          loom,
        ),
      )
      expect(found.some((m) => m.includes('beside code'))).toBe(false)
    }),
  )

  it.effect('faults a discussion box with no name', () =>
    Effect.gen(function* () {
      const loom = '/corpus/nameless.loom'
      const found = messages(
        yield* diagnosed({ [loom]: lines('# Nameless', '', '::: {Discussion}', ':::') }, loom),
      )
      expect(found).toContain(
        'This box needs a name. Write it before `{Discussion}`, as in `::: Waking {Discussion}`.',
      )
    }),
  )
})

describe('navigating from a discussion box', () => {
  const files = written(summary(trap))
  const boxName = files[monsters]!.indexOf('Waking {Discussion}') + 1

  it.effect('follows its name to the discussion', () =>
    Effect.gen(function* () {
      const found = yield* withCompiler(files, (compiler) => compiler.definition(monsters, boxName))
      expect(found?.path).toBe(waking)
      expect(found?.range.start.line).toBe(1)
    }),
  )

  it.effect('lists the box among the names of its discussion', () =>
    Effect.gen(function* () {
      const found = yield* withCompiler(files, (compiler) => compiler.references(monsters, boxName))
      expect(found.map((location) => location.path)).toContain(monsters)
      expect(found.map((location) => location.path)).toContain(waking)
    }),
  )
})

describe('keeping a discussion box in step as the author types', () => {
  const inStep = written(summary(trap))
  const edits = (path: string, before: string, after: string) =>
    withCompiler(inStep, (compiler) => compiler.summaryEdits(path, before, after))

  it.effect('writes an edit to a conclusion into the box', () =>
    Effect.gen(function* () {
      const sound = 'A sound within its hearing wakes it.'
      const found = yield* edits(waking, inStep[waking]!, wakingLoom(sound))
      expect(found.map((edit) => edit.path)).toEqual([monsters])
      expect(applied(inStep[monsters]!, found[0]!)).toBe(monstersLoom(summary(sound)))
    }),
  )

  it.effect('carries nothing from an edit to the box', () =>
    Effect.gen(function* () {
      const after = monstersLoom(['What wakes a monster?', '', 'Something else.'])
      expect(yield* edits(monsters, inStep[monsters]!, after)).toEqual([])
    }),
  )
})
