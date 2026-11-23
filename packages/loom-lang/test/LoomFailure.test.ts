import { expect, it } from 'bun:test'
import { Cause, Data, Match, Option } from 'effect'
import type { Position } from '@athrio/loom-ast/LoomNode'
import {
  EmptyAnchorDelims,
  IdenticalAnchorDelims,
  ReservedAnchorDelims,
  WhitespaceAnchorDelims,
} from '@athrio/loom-ast/LoomTokens'
import { ClassicTypeScriptMissing, ServiceError } from '@athrio/loom-lang-services/LanguageService'
import { StoreError } from '@athrio/loom-lang-services/LoomStore'
import { ReadError } from '#ast/LoomCorpusAstBuilder'
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
} from '../src/LoomFailure'
import { TypeScriptNotFetched } from '../src/LoomServer'
import { RelationsNotKept } from '../src/WorkspaceSource'

const nowhere: Position = { start: { line: 1, offset: 0 }, end: { line: 1, offset: 0 } }

const samples: {
  readonly [Tag in LoomFailure['_tag']]: Extract<LoomFailure, { readonly _tag: Tag }>
} = {
  ReadError: new ReadError({ path: '/book/ledger.loom', cause: new Error('no such file') }),
  EmptyAnchorDelims: new EmptyAnchorDelims({ open: '', close: ')' }),
  IdenticalAnchorDelims: new IdenticalAnchorDelims({ delim: '|' }),
  WhitespaceAnchorDelims: new WhitespaceAnchorDelims({ open: '( ', close: ')' }),
  ReservedAnchorDelims: new ReservedAnchorDelims({ marker: '#' }),
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
    cause: 'remote storage takes no write',
  }),
  Broke: new Broke({ program: 'server', cause: 'no such function' }),
}

it('words every failure as a sentence', () => {
  const worded = Object.values(samples).map(describe)
  expect(worded.filter(({ summary }) => !/^[A-Z][^\n]*\.$/.test(summary))).toEqual([])
  expect(worded.filter(({ summary }) => summary.startsWith('loom:'))).toEqual([])
  expect(worded.filter(({ detail }) => !/(^|[.!?])$/.test(detail))).toEqual([])
})

it('reads a cause in its own words', () => {
  expect(reasonOf(new Error('no such file'))).toBe('no such file.')
  expect(reasonOf('remote storage takes no write')).toBe('remote storage takes no write.')
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

it('names the program a defect struck', () => {
  const failure = broke('server', Cause.die(new Error('no such function')))
  expect(describe(failure)).toEqual({
    summary: "Something broke in Loom's language server.",
    detail: 'no such function.',
  })
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
