import { expect, it } from 'bun:test'
import { Cause, Data, Effect, Match, Option } from 'effect'
import type { Position } from '@athrio/loom-ast/LoomNode'
import {
  type AnchorDelims,
  EmptyAnchorDelims,
  IdenticalAnchorDelims,
  ReservedAnchorDelims,
  WhitespaceAnchorDelims,
} from '@athrio/loom-ast/LoomTokens'
import { ServiceError } from '@athrio/loom-lang-services/LanguageService'
import { StoreError } from '@athrio/loom-lang-services/LoomStore'
import { LoomCorpusAstBuilder, ReadError, type Source } from '#ast/LoomCorpusAstBuilder'
import { TangleError } from '../src/LoomCompiler'
import {
  Broke,
  broke,
  describe,
  failureWording,
  type LoomFailure,
  lineOf,
  type Problem,
  reasonOf,
  refusedBy,
} from '#ast/LoomFailure'
import { ClassicTypeScriptMissing, TypeScriptNotFetched } from '../src/LoomServer'
import { NotRemoved, NotWritten } from '../src/LoomTangler'
import { RelationsNotKept, StorageTakesNoWrite } from '../src/WorkspaceSource'

const nowhere: Position = { start: { line: 1, offset: 0 }, end: { line: 1, offset: 0 } }

const samples: {
  readonly [Tag in LoomFailure['_tag']]: Extract<LoomFailure, { readonly _tag: Tag }>
} = {
  ReadError: new ReadError({ path: '/book/ledger.loom', cause: new Error('no such file') }),
  EmptyAnchorDelims: new EmptyAnchorDelims({ open: '', close: ')' }),
  IdenticalAnchorDelims: new IdenticalAnchorDelims({ delim: '|' }),
  WhitespaceAnchorDelims: new WhitespaceAnchorDelims({ open: '( ', close: ')' }),
  ReservedAnchorDelims: new ReservedAnchorDelims({ marker: '#' }),
  NotWritten: new NotWritten({ path: '/book/out/ledger.ts', cause: new Error('read-only disk') }),
  NotRemoved: new NotRemoved({ path: '/book/out/old.ts', cause: new Error('read-only disk') }),
  TangleError: new TangleError({
    entry: '/book/book.loom',
    failures: [
      {
        path: '/book/ledger.loom',
        diagnostics: [
          { message: 'This anchor names no section.', position: nowhere, severity: 'error' },
        ],
      },
    ],
  }),
  StoreError: new StoreError({ packageName: 'a-package', cause: new Error('offline') }),
  TypeScriptNotFetched: new TypeScriptNotFetched({
    version: '7.0.0',
    folder: '/home/.loom/typescript',
    cause: new Error('offline'),
  }),
  ClassicTypeScriptMissing: new ClassicTypeScriptMissing({ folder: '/book', tsdk: Option.none() }),
  ServiceError: new ServiceError({ service: 'typescript', reason: 'the formatter did not load' }),
  RelationsNotKept: new RelationsNotKept({
    workspace: '/book',
    cause: new Error('read-only disk'),
  }),
  StorageTakesNoWrite: new StorageTakesNoWrite({ workspace: 'https://example.com/workspace' }),
  Broke: new Broke({ work: 'rereading', subject: '', cause: 'no such function' }),
}

it('words every failure as a sentence', () => {
  const worded = Object.values(samples).map(describe)
  expect(worded.filter(({ summary }) => !/^[A-Z][^\n]*\.$/.test(summary))).toEqual([])
  expect(worded.filter(({ summary }) => summary.startsWith('loom:'))).toEqual([])
  expect(worded.filter(({ detail }) => !/(^|[.!?])$/.test(detail))).toEqual([])
})

it('reads a cause in its own words', () => {
  expect(reasonOf(new Error('no such file'))).toBe('no such file.')
  expect(reasonOf('the disk is full')).toBe('the disk is full.')
  expect(reasonOf('It stopped!')).toBe('It stopped!')
  expect(describe(samples.ReadError)).toEqual({
    summary: 'Loom could not read /book/ledger.loom.',
    detail: 'no such file.',
  })
})

it('lists and counts the diagnostics that refused a tangle', () => {
  expect(refusedBy(samples.TangleError)).toEqual([
    '/book/ledger.loom:1: This anchor names no section.',
  ])
  const twice = new TangleError({
    entry: '/book/book.loom',
    failures: [...samples.TangleError.failures, ...samples.TangleError.failures],
  })
  expect(describe(samples.TangleError).detail).toBe('Its looms hold one problem.')
  expect(describe(twice).detail).toBe('Its looms hold 2 problems.')
})

it('tells a TypeScript that is missing from one that did not load', () => {
  const unloaded = new ClassicTypeScriptMissing({
    folder: '/book',
    tsdk: Option.some('/book/node_modules/typescript/lib'),
    cause: new Error('not a module'),
  })
  expect(describe(samples.ClassicTypeScriptMissing).summary).toBe(
    'Loom found no TypeScript 6 for /book, in the project or beside Loom.',
  )
  expect(describe(unloaded)).toEqual({
    summary: 'The TypeScript in /book/node_modules/typescript/lib did not load.',
    detail: 'not a module.',
  })
})

it('joins the two parts of a problem in one line', () => {
  expect(lineOf({ summary: 'It failed.', detail: '' })).toBe('It failed.')
  expect(lineOf({ summary: 'It failed.', detail: 'Try again.' })).toBe('It failed. Try again.')
})

const held = (text: string): Source => ({ read: () => Effect.succeed(text), list: Option.none() })

const refusing: Source = {
  read: (path) => Effect.fail(new ReadError({ path, cause: new Error('no such file') })),
  list: Option.none(),
}

const messagesFrom = (source: Source, delims?: AnchorDelims): ReadonlyArray<string> =>
  Effect.runSync(
    LoomCorpusAstBuilder.pipe(
      Effect.flatMap((builder) => builder.build(source, '/book/ledger.loom', delims)),
      Effect.provide(LoomCorpusAstBuilder.layer),
    ),
  ).doc.health.diagnostics.map((diagnostic) => diagnostic.message)

it('gives a loom the source refused the line of its failure', () => {
  expect(messagesFrom(refusing)).toEqual(['Loom could not read /book/ledger.loom. no such file.'])
})

it('gives a loom read with a bad pair of delimiters the line of that failure', () => {
  expect(messagesFrom(held('# Ledger\n'), { open: '@@', close: '@@' })).toEqual([
    lineOf(describe(new IdenticalAnchorDelims({ delim: '@@' }))),
  ])
})

it('gives a loom that mixes line endings the words of a fault', () => {
  expect(messagesFrom(held('one\r\ntwo\nthree'))).toEqual([
    'This loom ends its lines in two ways: line 1 with CRLF (Windows) and line 2 with LF (Unix). End every line the same way.',
  ])
})

it('names the work a defect struck, and what the work was on', () => {
  const failure = broke('rebuilding', '/book/ledger.loom', Cause.die(new Error('no such function')))
  expect(describe(failure)).toEqual({
    summary: 'Something broke while Loom rebuilt /book/ledger.loom after an edit.',
    detail: 'no such function.',
  })
  expect(describe(broke('command', '', Cause.die('gone'))).summary).toBe(
    "Something broke in Loom's command line.",
  )
})

it('tells relations a disk did not keep from relations remote storage never takes', () => {
  expect(describe(samples.RelationsNotKept).detail).toBe('read-only disk.')
  expect(describe(samples.StorageTakesNoWrite).detail).toBe('Remote storage takes no write.')
})

class Unreachable extends Data.TaggedError('Unreachable')<{ readonly url: string }> {}

type CommandFailure = LoomFailure | Unreachable

const describeCommand: (failure: CommandFailure) => Problem = Match.type<CommandFailure>().pipe(
  Match.tagsExhaustive({
    ...failureWording,
    Unreachable: ({ url }): Problem => ({ summary: `Loom could not reach ${url}.`, detail: '' }),
  }),
)

it('words its own failures and those of the catalog through one matcher', () => {
  const unreachable = new Unreachable({ url: 'https://example.com/latest' })
  expect(describeCommand(unreachable).summary).toBe(
    'Loom could not reach https://example.com/latest.',
  )
  expect(describeCommand(samples.ReadError)).toEqual(describe(samples.ReadError))
})
