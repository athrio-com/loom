import { describe, expect, it as it_ } from 'bun:test'
import { effectify } from '@athrio/effect-test'
import { Effect, Layer, Option } from 'effect'
import { defaultAnchorDelims } from '@athrio/loom-ast/LoomTokens'
import type { WorkspaceManifest } from '@athrio/loom-config/LoomConfig'
import { DocumentSource, LoomCompiler } from '../src/LoomCompiler'
import { coreTypes } from '../src/OutlineBuilder'
import { ReadError } from '#ast/LoomCorpusAstBuilder'
import { WorkspaceSettings } from '../src/WorkspaceSettings'
import { LoomDiskCache } from '../src/LoomDiskCache'
import { FileSystemSource } from '../src/WorkspaceSource'

const it = effectify(it_)

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

const tasksManifest = JSON.stringify({
  contract: '1',
  contributes: {
    kinds: {
      loom: [{ kind: 'Plan' }],
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
})

const files: Record<string, string> = {
  '/corpus/game.loom': lines(
    '---',
    'Book: The game',
    '---',
    '',
    '# The game',
    '',
    'A game of rooms that wake one at a time.',
    '',
    '## Room {Concept}',
    '',
    'A room is a place the player stands in.',
    '',
    'Lexical forms:',
    '- rooms',
  ),
  '/corpus/words.loom': lines(
    '---',
    'Part I: The room',
    'Chapter 2: Words',
    'Book: The game',
    'Language: TypeScript',
    '---',
    '',
    '# Words',
    '',
    `What the program says in its ${anchor('rooms')}.`,
    '',
    ':::',
    'Check the greeting with a reader.',
    ':::',
    '',
    '## Saying hello [hello.ts]',
    '',
    'The greeting {{ word = "hi" }} is short.',
    '',
    `=> export const hi = '${anchor('word')}'`,
    'export const twice = hi + hi',
    '',
    '~ After the code comes more prose.',
    '',
    '## Installing it {Bash}',
    '',
    '=>',
    '',
    '```',
    '# fetch the game',
    'curl -fsSL example.com',
    '```',
  ),
  '/corpus/waking.loom': lines(
    '---',
    'Part I, Discussion 1: Waking',
    'Book: The game',
    '---',
    '',
    '# Waking',
    '',
    'What should wake a monster.',
    '',
    'What wakes a monster',
    '---',
    '',
    '~ Yegor',
    'What should wake a monster?',
    '',
    '~ Claude',
    "A trap's radius.",
    '',
    '::: {Conclusion}',
    'A trap going off wakes it.',
    ':::',
  ),
  '/corpus/notes.loom': lines('# Notes', '', 'Loose words.'),
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
    tasksManifest,
  ),
  '/corpus/plan.loom': lines(
    '# The plan',
    '',
    '## Paint the walls {kind=Task status=todo tags=[walls, "first coat"] owner=Yegor}',
    '',
    'Two coats.',
  ),
}

const outlined = (path: string) => withCompiler(files, (compiler) => compiler.outline(path))

describe('the outline of a loom', () => {
  it.effect('outlines a chapter, its sections, and its variables', () =>
    Effect.gen(function* () {
      const outline = yield* outlined('/corpus/words.loom')
      expect([outline.kind, outline.title, outline.book, outline.number, outline.language]).toEqual(
        ['Chapter', 'Words', 'The game', '2', 'TypeScript'],
      )
      expect(outline.part).toEqual({ number: 'I', name: 'The room' })
      expect(
        outline.sections.map((section) => [section.name, section.line, section.level]),
      ).toEqual([
        ['Words', 7, 1],
        ['Saying hello', 15, 2],
        ['Installing it', 24, 2],
      ])
      expect(outline.sections[0]?.body).toEqual([
        { _tag: 'Prose', text: `What the program says in its ${anchor('rooms')}.` },
      ])
      expect(outline.sections[0]?.notes).toEqual([{ text: 'Check the greeting with a reader.' }])
      expect(outline.sections[1]?.file).toBe('hello.ts')
      expect(outline.sections[1]?.body).toEqual([
        { _tag: 'Prose', text: 'The greeting {{ word = "hi" }} is short.' },
        {
          _tag: 'Code',
          text: `export const hi = '${anchor('word')}'\nexport const twice = hi + hi`,
        },
        { _tag: 'Prose', text: 'After the code comes more prose.' },
      ])
      expect([outline.sections[2]?.language, outline.sections[2]?.body]).toEqual([
        'Bash',
        [{ _tag: 'Code', text: '# fetch the game\ncurl -fsSL example.com' }],
      ])
      expect(outline.variables).toEqual([{ name: 'word', value: '"hi"', section: 'Saying hello' }])
      expect(outline.configuration).toEqual({ version: '0.1.19' })
    }),
  )

it.effect('outlines a discussion, its messages, and its conclusion', () =>
  Effect.gen(function* () {
    const outline = yield* outlined('/corpus/waking.loom')
    expect([outline.kind, outline.number, outline.part]).toEqual([
      'Discussion',
      '1',
      { number: 'I', name: 'The room' },
    ])
    const topic = outline.sections[1]
    expect([topic?.name, topic?.level, topic?.body]).toEqual(['What wakes a monster', 0, []])
    expect(topic?.messages).toEqual([
      { author: 'Yegor', text: 'What should wake a monster?' },
      { author: 'Claude', text: "A trap's radius." },
    ])
    expect(topic?.conclusion).toBe('A trap going off wakes it.')
  }),
)

it.effect('tells a book loom and a loose loom', () =>
  Effect.gen(function* () {
    const book = yield* outlined('/corpus/game.loom')
    const loose = yield* outlined('/corpus/notes.loom')
    expect([book.kind, book.title, book.book, book.part, book.number]).toEqual([
      'Book',
      'The game',
      'The game',
      undefined,
      undefined,
    ])
    expect([loose.kind, loose.title, loose.book]).toEqual(['Loose', 'Notes', ''])
  }),
)

  it.effect('fails for a loom the workspace does not hold', () =>
    Effect.gen(function* () {
      const failed = yield* Effect.flip(outlined('/corpus/missing.loom'))
      expect([failed._tag, failed.path]).toEqual(['NoSuchLoom', '/corpus/missing.loom'])
    }),
  )
})

describe('the keys of a section', () => {
  it.effect('gives the keys a heading holds beside its kind and its language', () =>
    Effect.gen(function* () {
      const plan = yield* outlined('/corpus/plan.loom')
      expect(plan.sections[1]?.parameters).toEqual({
        status: 'todo',
        tags: ['walls', 'first coat'],
        owner: 'Yegor',
      })
      const words = yield* outlined('/corpus/words.loom')
      expect(words.sections[2]?.parameters).toEqual({})
    }),
  )
})

describe('the concepts of a workspace', () => {
  it.effect('lists each concept with the places that use it', () =>
    Effect.gen(function* () {
      const { concepts } = yield* withCompiler(files, (compiler) =>
        compiler.concepts('/corpus/game.loom'),
      )
      expect(
        concepts.map((concept) => [concept.name, concept.forms, concept.path, concept.section]),
      ).toEqual([['Room', ['rooms'], '/corpus/game.loom', 'Room']])
      expect(concepts[0]?.uses).toContainEqual({ path: '/corpus/words.loom', section: 'Words' })
    }),
  )
})

describe('the types of a workspace', () => {
  it.effect('lists the core kinds, then the kinds its tropes declare', () =>
    Effect.gen(function* () {
      const types = yield* withCompiler(files, (compiler) => compiler.types('/corpus/game.loom'))
      expect(types.looms).toEqual([
        { kind: 'Chapter' },
        { kind: 'Discussion' },
        { kind: 'Plan', trope: 'Tasks' },
      ])
      expect(types.sections).toEqual([
        { kind: 'Tangle', parameters: {}, codeless: false },
        { kind: 'Concept', parameters: {}, codeless: true },
        { kind: 'Manifest', parameters: {}, codeless: false },
        {
          kind: 'Task',
          trope: 'Tasks',
          parameters: { status: { choice: ['todo', 'done'] }, tags: { list: 'text' } },
          codeless: false,
        },
      ])
      expect(types.boxes.map((box) => box.kind)).toEqual([
        'Note',
        'Chapter',
        'Discussion',
        'Trope',
        'Conclusion',
        'Estimate',
      ])
      expect(types.boxes[3]?.parameters).toEqual({
        provides: { list: 'text' },
        anchors: 'reference',
      })
      expect(types.boxes[5]).toEqual({
        kind: 'Estimate',
        trope: 'Tasks',
        parameters: { days: 'number' },
        body: 'text',
      })
      expect(types.headings).toEqual({ owner: 'text' })
      expect(coreTypes.boxes.length).toBe(5)
    }),
  )
})
