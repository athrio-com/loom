import { describe, expect, it as it_ } from 'bun:test'
import { effectify } from '@athrio/effect-test'
import { Effect, Layer, Match, Option as Opt } from 'effect'
import { defaultAnchorDelims } from '@athrio/loom-ast/LoomTokens'
import type { WovenBlock } from '../src/weave/WovenCorpus'
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
        list: Opt.some(() => Effect.succeed(Object.keys(files))),
        hold: () => Effect.void,
        forget: () => Effect.void,
      }),
      Layer.succeed(WorkspaceSettings, {
        manifest: () => Effect.succeed(Opt.none()),
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

const offsetOf = (text: string | undefined, phrase: string, word: string = phrase): number =>
  (text ?? '').indexOf(phrase) + phrase.indexOf(word) + 1

const cardAt = (files: Record<string, string>, path: string, phrase: string, word: string) =>
  asked(files, (compiler) => compiler.hover(path, offsetOf(files[path], phrase, word))).pipe(
    Effect.map((card) => card?.markdown),
  )

const root = '/corpus/book.loom'
const accounts = '/corpus/accounts.loom'
const invoices = '/corpus/invoices.loom'
const parcels = '/corpus/parcels.loom'

const money = lines(
  '# Money',
  '',
  'A corpus about money.',
  '',
  '## Currency {Concept}',
  '',
  'A unit of money that a country issues.',
)

const book = (looms: Record<string, string>): Record<string, string> => ({
  [root]: money,
  [accounts]: chapter(
    ['Part I: Billing', 'Chapter 1: Accounts'],
    '# Accounts',
    '',
    'Billing keeps money in accounts.',
    '',
    '## Account {Concept}',
    '',
    "A ledger that holds one customer's balance.",
    '',
    'Lexical forms:',
    '- accounts',
  ),
  [invoices]: chapter(
    ['Part I, Chapter 2: Invoices'],
    '# Invoices',
    '',
    'An invoice charges an account in one currency.',
    '',
    'Accounts close once they owe nothing, and `account` in code is no word.',
  ),
  [parcels]: chapter(
    ['Part II: Shipping', 'Chapter 3: Parcels'],
    '# Parcels',
    '',
    'A parcel ships to the address an account gives, paid in a currency.',
  ),
  ...looms,
})

const accountCard = "**Account**\n\nA ledger that holds one customer's balance.\n\nAlso: accounts"

const currencyCard = '**Currency**\n\nA unit of money that a country issues.'

describe('the words a chapter recognises', () => {
  it.effect("recognises a concept of the chapter's own part", () =>
    Effect.gen(function* () {
      const files = book({})
      const card = yield* cardAt(files, invoices, 'charges an account', 'account')
      const target = yield* asked(files, (compiler) =>
        compiler.definition(invoices, offsetOf(files[invoices], 'charges an account', 'account')),
      )
      expect([card, target?.path, target?.range.start]).toEqual([
        accountCard,
        accounts,
        { line: 9, character: 3 },
      ])
    }),
  )

  it.effect('reads a form whatever the case of its first letter, and never inside code', () =>
    Effect.gen(function* () {
      const files = book({})
      expect([
        yield* cardAt(files, invoices, 'Accounts close', 'Accounts'),
        yield* cardAt(files, invoices, '`account` in code', 'account'),
      ]).toEqual([accountCard, undefined])
    }),
  )

  it.effect("keeps a part's concepts to the part, and the corpus's to every chapter", () =>
    Effect.gen(function* () {
      const files = book({})
      expect([
        yield* cardAt(files, parcels, 'an account gives', 'account'),
        yield* cardAt(files, parcels, 'a currency', 'currency'),
      ]).toEqual([undefined, currencyCard])
    }),
  )
})

describe('a link imports its concept', () => {
  it.effect('lets the rest of the part recognise the word', () =>
    Effect.gen(function* () {
      const returns = '/corpus/returns.loom'
      const files = book({
        [parcels]: chapter(
          ['Part II: Shipping', 'Chapter 3: Parcels'],
          '# Parcels',
          '',
          `A parcel ships to the address an ${anchor('account')} gives.`,
        ),
        [returns]: chapter(
          ['Part II, Chapter 4: Returns'],
          '# Returns',
          '',
          'A return refunds the account that paid.',
        ),
      })
      expect(yield* cardAt(files, returns, 'the account that', 'account')).toBe(accountCard)
    }),
  )
})

describe('books and tropes', () => {
  it.effect("lets a book loom's concepts reach its own book alone", () =>
    Effect.gen(function* () {
      const game = '/corpus/game.loom'
      const board = '/corpus/board.loom'
      const files = book({
        [game]: chapter(
          ['Book: Games'],
          '# Games',
          '',
          '## Move {Concept}',
          '',
          'One turn of a player.',
        ),
        [board]: chapter(
          ['Book: Games', 'Part I: Play', 'Chapter 1: Board'],
          '# Board',
          '',
          'Each move places a stone.',
        ),
        [invoices]: chapter(
          ['Part I, Chapter 2: Invoices'],
          '# Invoices',
          '',
          'A move of money is no game.',
        ),
      })
      expect([
        yield* cardAt(files, board, 'Each move', 'move'),
        yield* cardAt(files, invoices, 'A move of', 'move'),
      ]).toEqual(['**Move**\n\nOne turn of a player.', undefined])
    }),
  )

  it.effect('keeps a trope private but for its entries', () =>
    Effect.gen(function* () {
      const ledger = '/corpus/ledger.loom'
      const files = book({
        '/corpus/payments.loom': chapter(
          ['Part I, Trope Chapter 4: Payments', 'Entries: Charging'],
          '# Payments',
          '',
          'Payments takes money.',
        ),
        '/corpus/charging.loom': chapter(
          ['Part I, Chapter 5: Charging', 'Rooted in: Payments'],
          '# Charging',
          '',
          '## Charge {Concept}',
          '',
          'A sum a customer owes.',
        ),
        [ledger]: chapter(
          ['Part I, Chapter 6: Ledger', 'Rooted in: Payments'],
          '# Ledger',
          '',
          'Each posting records a charge against an account.',
          '',
          '## Posting {Concept}',
          '',
          'One line of the ledger.',
        ),
        [invoices]: chapter(
          ['Part I, Chapter 2: Invoices'],
          '# Invoices',
          '',
          'An invoice lists each charge, and never a posting.',
        ),
      })
      const charge = '**Charge**\n\nA sum a customer owes.'
      expect([
        yield* cardAt(files, ledger, 'Each posting', 'posting'),
        yield* cardAt(files, ledger, 'a charge against', 'charge'),
        yield* cardAt(files, ledger, 'an account.', 'account'),
        yield* cardAt(files, invoices, 'each charge', 'charge'),
        yield* cardAt(files, invoices, 'a posting', 'posting'),
      ]).toEqual(['**Posting**\n\nOne line of the ledger.', charge, accountCard, charge, undefined])
    }),
  )
})

describe('a word two concepts claim', () => {
  it.effect('is not recognised, and offers a link to each concept', () =>
    Effect.gen(function* () {
      const files = book({
        '/corpus/signing-in.loom': chapter(
          ['Part I, Chapter 7: Signing in'],
          '# Signing in',
          '',
          '## Account {Concept}',
          '',
          'The person who signs in.',
        ),
      })
      const at = offsetOf(files[invoices], 'charges an account', 'account')
      const card = yield* asked(files, (compiler) => compiler.hover(invoices, at))
      const offers = yield* asked(files, (compiler) => compiler.links(invoices, at, at))
      expect([
        card,
        offers.map((offer) => [offer.title, offer.edits.map((edit) => edit.text)]),
      ]).toEqual([
        undefined,
        [
          ['Link to `Accounts, account`', [anchor('Accounts, account')]],
          ['Link to `Signing in, account`', [anchor('Signing in, account')]],
        ],
      ])
    }),
  )
})

const wordsOf = (block: WovenBlock): string =>
  Match.value(block).pipe(
    Match.when({ type: 'heading' }, (heading) => `# ${heading.title}`),
    Match.when({ type: 'prose' }, (prose) => prose.markdown),
    Match.orElse((other) => other.type),
  )

describe('uses in the editor and the index', () => {
  it.effect('finds every word that recognises a concept', () =>
    Effect.gen(function* () {
      const files = book({})
      const found = yield* asked(files, (compiler) =>
        compiler.references(accounts, offsetOf(files[accounts], '## Account', 'Account')),
      )
      expect(found.map((place) => [place.path, place.range.start.line])).toEqual([
        [accounts, 9],
        [accounts, 7],
        [invoices, 6],
        [invoices, 8],
      ])
    }),
  )

  it.effect('counts recognised words as uses, and marks them on the page', () =>
    Effect.gen(function* () {
      const site = yield* asked(book({}), (compiler) => compiler.weave(root))
      const index = site.pages.find((page) => page.slug === 'index')?.blocks ?? []
      const page = site.pages.find((page) => page.slug === 'corpus/invoices')?.blocks ?? []
      const marks = page.flatMap((block) =>
        block.type === 'prose' ? (block.recognised ?? []) : [],
      )
      expect([
        index.map(wordsOf).filter((words) => words.startsWith('Defined in')),
        marks.map((mark) => [mark.concept, mark.definition]),
      ]).toEqual([
        [
          'Defined in Accounts. Used in Accounts, Invoices.',
          'Defined in Money. Used in Invoices, Parcels.',
        ],
        [
          ['Account', "A ledger that holds one customer's balance."],
          ['Currency', 'A unit of money that a country issues.'],
          ['Account', "A ledger that holds one customer's balance."],
        ],
      ])
    }),
  )
})

describe('moving a concept up', () => {
  it.effect('moves a concept of a part to the corpus loom', () =>
    Effect.gen(function* () {
      const files = book({})
      const moves = yield* asked(files, (compiler) =>
        compiler.moves(accounts, offsetOf(files[accounts], '## Account', 'Account')),
      )
      expect(
        moves.map((move) => [
          move.concept,
          move.targets.map((target) => [
            target.title,
            target.edits.map((edit) => [edit.path, edit.text]),
          ]),
        ]),
      ).toEqual([
        [
          'Account',
          [
            [
              'Move `Account` up to the corpus',
              [
                [accounts, ''],
                [
                  root,
                  "\n## Account {Concept}\n\nA ledger that holds one customer's balance.\n\nLexical forms:\n- accounts\n",
                ],
              ],
            ],
          ],
        ],
      ])
    }),
  )

  it.effect('moves a concept of a trope to its part, or on to the corpus', () =>
    Effect.gen(function* () {
      const ledger = '/corpus/ledger.loom'
      const files = book({
        '/corpus/payments.loom': chapter(
          ['Part I, Trope Chapter 4: Payments'],
          '# Payments',
          '',
          'Payments takes money.',
        ),
        [ledger]: chapter(
          ['Part I, Chapter 6: Ledger', 'Rooted in: Payments'],
          '# Ledger',
          '',
          '## Posting {Concept}',
          '',
          'One line of the ledger.',
        ),
      })
      const moves = yield* asked(files, (compiler) =>
        compiler.moves(ledger, offsetOf(files[ledger], '## Posting', 'Posting')),
      )
      expect(
        moves.map((move) =>
          move.targets.map((target) => [target.title, target.edits.map((edit) => edit.path)]),
        ),
      ).toEqual([
        [
          ['Move `Posting` up to Part I', [ledger, accounts]],
          ['Move `Posting` up to the corpus', [ledger, root]],
        ],
      ])
    }),
  )
})
