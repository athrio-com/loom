import { describe, expect, it as it_ } from 'bun:test'
import { effectify } from '@athrio/effect-test'
import { Effect, Layer, Option } from 'effect'
import { defaultAnchorDelims } from '@athrio/loom-ast/LoomTokens'
import { DocumentSource, LoomCompiler } from '../src/LoomCompiler'
import { WorkspaceSettings } from '../src/WorkspaceSettings'
import { LoomDiskCache } from '../src/LoomDiskCache'
import { FileSystemSource } from '../src/WorkspaceSource'

const it = effectify(it_)

const lines = (...rows: ReadonlyArray<string>): string => `${rows.join('\n')}\n`

const anchor = (name: string): string => `::${'['}${name}]`

const chapter = (identity: ReadonlyArray<string>, ...body: ReadonlyArray<string>): string =>
  lines('---', ...identity, '---', '', ...body)

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

const asked = <A, E>(
  files: Record<string, string>,
  use: (compiler: LoomCompiler['Service']) => Effect.Effect<A, E>,
) => LoomCompiler.pipe(Effect.flatMap(use), Effect.provide(layerOf(files)))

const diagnosed = (files: Record<string, string>, entry: string) =>
  asked(files, (compiler) => compiler.diagnose(entry)).pipe(
    Effect.map((found) => found.map((diagnostic) => diagnostic.message)),
  )

const refusal = (files: Record<string, string>, entry: string) =>
  asked(files, (compiler) => compiler.tangle(entry)).pipe(
    Effect.flip,
    Effect.map((error) => error.message),
  )

const billing = chapter(
  ['Part I: Money', 'Chapter 1: Billing'],
  '# Billing',
  '',
  'Billing charges a customer for each order.',
  '',
  '## Account {Concept}',
  '',
  "A ledger that holds one customer's balance, charges, and payments.",
  '',
  'Lexical forms:',
  '- accounts',
  "- account's",
  '',
  "Billing opens an account with a customer's first order.",
)

const ordersOf = (first: string, second: string): string =>
  chapter(['Part I, Chapter 2: Orders'], '# Orders', '', first, '', second)

const orders = ordersOf(
  `Every order lands on one of a customer's ${anchor('accounts')}.`,
  `An ${anchor('Account')} stays open while it owes.`,
)

const corpus = (looms: Record<string, string>): Record<string, string> => ({
  '/corpus/billing.loom': billing,
  '/corpus/orders.loom': orders,
  ...looms,
})

describe('a link names a concept by any of its forms', () => {
  const formOffset = orders.indexOf(anchor('accounts')) + 4

  it.effect('leads from a form to the heading of its concept', () =>
    Effect.gen(function* () {
      const target = yield* asked(corpus({}), (compiler) =>
        compiler.definition('/corpus/orders.loom', formOffset),
      )
      expect([target?.path, target?.range.start]).toEqual([
        '/corpus/billing.loom',
        { line: 9, character: 3 },
      ])
    }),
  )

  it.effect("shows the concept's card where the link stands", () =>
    Effect.gen(function* () {
      const card = yield* asked(corpus({}), (compiler) =>
        compiler.hover('/corpus/orders.loom', formOffset),
      )
      expect(card?.markdown).toBe(
        "**Account**\n\nA ledger that holds one customer's balance, charges, and payments.\n\nAlso: accounts, account's",
      )
    }),
  )

  it.effect('raises no fault for a link that finds its concept', () =>
    Effect.gen(function* () {
      expect(yield* diagnosed(corpus({}), '/corpus/orders.loom')).toEqual([])
    }),
  )
})

describe('the faults a concept raises', () => {
  const signingIn = chapter(
    ['Part I, Chapter 3: Signing in'],
    '# Signing in',
    '',
    'A person signs in before an order.',
    '',
    '## Account {Concept}',
    '',
    'The person who signs in.',
    '',
    'Lexical forms:',
    '- accounts',
  )

  const program = (line: string): string =>
    chapter(
      ['Part I, Chapter 4: The program'],
      '# The program [bill.ts]',
      '',
      'The program bills a customer.',
      '',
      '=>',
      line,
      'export const bill = 1',
    )

  it.effect('offers a path to each concept a shared form names', () =>
    Effect.gen(function* () {
      const messages = yield* diagnosed(
        corpus({ '/corpus/signing-in.loom': signingIn }),
        '/corpus/orders.loom',
      )
      expect(messages).toContain(
        '`accounts` names 2 sections. Write the path to the one you mean: `Billing, Account` or `Signing in, Account`.',
      )
    }),
  )

  it.effect('warns of a link whose form no concept carries', () =>
    Effect.gen(function* () {
      const messages = yield* diagnosed(
        corpus({
          '/corpus/orders.loom': ordersOf(
            `Every order lands on one of a customer's ${anchor('ledgers')}.`,
            'Nothing else is linked.',
          ),
        }),
        '/corpus/orders.loom',
      )
      expect(messages).toEqual([
        'Nothing is called `ledgers`, so this link leads nowhere. Name a section, a chapter, or a form of a concept.',
      ])
    }),
  )

  it.effect('faults code in a concept', () =>
    Effect.gen(function* () {
      const messages = yield* diagnosed(
        corpus({
          '/corpus/billing.loom': chapter(
            ['Part I: Money', 'Chapter 1: Billing'],
            '# Billing',
            '',
            '## Account {Concept}',
            '',
            'A ledger.',
            '',
            '=>',
            'const ledger = 1',
          ),
        }),
        '/corpus/billing.loom',
      )
      expect(messages).toContain(
        'A concept holds no code. Quote this code in a fence, or move it to a section that realises the concept.',
      )
    }),
  )

  it.effect('faults a code anchor that names a concept, by any form', () =>
    Effect.gen(function* () {
      const byHeading = yield* refusal(
        corpus({ '/corpus/program.loom': program(anchor('Account')) }),
        '/corpus/program.loom',
      )
      const byForm = yield* refusal(
        corpus({ '/corpus/program.loom': program(anchor('accounts')) }),
        '/corpus/program.loom',
      )
      const message =
        '`Account` is a concept, and a concept holds no code. Name the section whose code you mean.'
      expect([byHeading.includes(message), byForm.includes(message)]).toEqual([true, true])
    }),
  )
})

describe('a concept in the editor', () => {
  const headingOffset = billing.indexOf('## Account') + 4

  it.effect('finds every link to a concept, whichever form it names', () =>
    Effect.gen(function* () {
      const found = yield* asked(corpus({}), (compiler) =>
        compiler.references('/corpus/billing.loom', headingOffset),
      )
      expect(found.map((reference) => [reference.path, reference.range.start.line])).toEqual([
        ['/corpus/billing.loom', 9],
        ['/corpus/orders.loom', 6],
        ['/corpus/orders.loom', 8],
      ])
    }),
  )

  it.effect('keeps the old name as a form on a rename', () =>
    Effect.gen(function* () {
      const edits = yield* asked(corpus({}), (compiler) =>
        compiler.rename('/corpus/billing.loom', headingOffset),
      )
      expect(edits.map((edit) => [edit.path, edit.range.start, edit.text])).toEqual([
        ['/corpus/billing.loom', { line: 9, character: 3 }, undefined],
        ['/corpus/billing.loom', { line: 13, character: 14 }, '\n- Account'],
      ])
    }),
  )
})
