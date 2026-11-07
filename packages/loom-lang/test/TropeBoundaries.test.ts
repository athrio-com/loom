import { describe, expect, it } from 'bun:test'
import { Effect, Layer, Option as Opt } from 'effect'
import { defaultAnchorDelims } from '@athrio/loom-ast/LoomTokens'
import { DocumentSource, LoomCompiler } from '../src/LoomCompiler'
import { WorkspaceSettings } from '../src/WorkspaceSettings'
import { LoomDiskCache } from '../src/LoomDiskCache'
import { FileSystemSource } from '../src/WorkspaceSource'

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

const diagnosed = (files: Record<string, string>, entry: string) =>
  Effect.runPromise(
    LoomCompiler.pipe(
      Effect.flatMap((compiler) => compiler.diagnose(entry)),
      Effect.provide(layerOf(files)),
    ),
  ).then((found) => found.map((d) => ({ line: d.position.start.line, message: d.message })))

const opening = (
  identity: string,
  title: string,
  fields: ReadonlyArray<string>,
  code: ReadonlyArray<string>,
) => lines('---', identity, ...fields, '---', '', `# ${title}`, '', '=>', '', ...code)

const chapter = (
  number: number,
  title: string,
  fields: ReadonlyArray<string>,
  code: ReadonlyArray<string>,
) => opening(`Part I, Chapter ${number}: ${title}`, title, fields, code)

const tropeChapter = (
  number: number,
  title: string,
  fields: ReadonlyArray<string>,
  code: ReadonlyArray<string>,
) => opening(`Part I, Trope Chapter ${number}: ${title}`, title, fields, code)

const faultsOf = (found: ReadonlyArray<{ readonly message: string }>) =>
  found
    .map((d) => d.message)
    .filter((message) =>
      [
        'is private to the',
        'No chapter is called',
        'belongs to the',
        'No trope chapter is called',
        'Only a trope chapter can list entries',
        'Undeclared relation',
        'Circular roots',
      ].some((phrase) => message.includes(phrase)),
    )

const root = '/corpus/payments.loom'
const charging = '/corpus/charging.loom'
const ledger = '/corpus/ledger.loom'
const shop = '/corpus/shop.loom'

const payments = (...entries: ReadonlyArray<string>): Record<string, string> => ({
  [root]: tropeChapter(
    1,
    'Payments',
    entries.length > 0 ? [`Entries: ${entries.join(', ')}`] : [],
    [anchor('Charging')],
  ),
  [charging]: chapter(
    2,
    'Charging',
    ['Rooted in: Payments'],
    [anchor('Ledger'), 'const charge = 1'],
  ),
  [ledger]: chapter(3, 'Ledger', ['Rooted in: Payments'], ['const ledger = 1']),
})

const withShop = (...code: ReadonlyArray<string>): Record<string, string> => ({
  ...payments('Charging'),
  [shop]: chapter(4, 'Shop', [], code),
})

describe('a trope that draws no line', () => {
  it('lets every chapter reach a trope of one chapter', async () => {
    const files = {
      [ledger]: tropeChapter(1, 'Books', [], ['const ledger = 1']),
      [shop]: chapter(2, 'Shop', [], [anchor('Books')]),
    }
    expect(faultsOf(await diagnosed(files, ledger))).toEqual([])
    expect(faultsOf(await diagnosed(files, shop))).toEqual([])
  })

  it('notes a chapter rooted in a trope no chapter roots', async () => {
    const files = {
      [charging]: chapter(1, 'Charging', ['Rooted in: Payments'], ['const charge = 1']),
      [ledger]: chapter(2, 'Ledger', ['Rooted in: Payments'], ['const ledger = 1']),
      [shop]: chapter(3, 'Shop', [], [anchor('Ledger')]),
    }
    const unrooted = 'No trope chapter is called `Payments`.'
    expect(await diagnosed(files, ledger)).toContainEqual({ line: 3, message: unrooted })
    expect(faultsOf(await diagnosed(files, charging))).toEqual([unrooted])
    expect(faultsOf(await diagnosed(files, shop))).toEqual([])
  })
})

describe('the entries a root lists', () => {
  it('raises nothing when each leads to a member', async () => {
    expect(faultsOf(await diagnosed(payments('Charging'), root))).toEqual([])
  })

  it('faults a name that leads to no chapter', async () => {
    expect(faultsOf(await diagnosed(payments('Charging', 'Billing'), root))).toEqual([
      'No chapter is called `Billing`.',
    ])
  })

  it("faults a name that leads to another trope's chapter", async () => {
    const files = {
      ...payments('Charging', 'Diagrams'),
      '/corpus/diagrams.loom': tropeChapter(5, 'Diagrams', [], ['const d = 1']),
    }
    expect(faultsOf(await diagnosed(files, root))).toEqual([
      'Chapter `Diagrams` belongs to the `Diagrams` trope, not to this one.',
    ])
  })

  it('faults an Entries line on a chapter that is no trope chapter', async () => {
    const files = {
      ...payments('Charging'),
      [ledger]: chapter(3, 'Ledger', ['Rooted in: Payments', 'Entries: Ledger'], ['const l = 1']),
    }
    expect(faultsOf(await diagnosed(files, ledger))).toEqual([
      'Only a trope chapter can list entries.',
    ])
  })
})

describe('reaching across the boundary', () => {
  const inside =
    'Chapter `Ledger` is private to the `Payments` trope. Use it via `Charging` instead.'

  it('lets a chapter outside reach an entry', async () => {
    expect(faultsOf(await diagnosed(withShop(anchor('Charging')), shop))).toEqual([])
  })

  it('lets members reach one another', async () => {
    expect(faultsOf(await diagnosed(withShop(), charging))).toEqual([])
  })

  it('faults an anchor that reaches inside', async () => {
    const found = await diagnosed(withShop(anchor('Charging'), anchor('Ledger')), shop)
    expect(faultsOf(found)).toEqual([inside])
    expect(found).toContainEqual({ line: 10, message: inside })
  })

  it('faults a trope box whose anchors name a chapter inside', async () => {
    const files = {
      ...payments('Charging'),
      [shop]: lines(
        '---',
        'Part I, Chapter 4: Shop',
        '---',
        '',
        '# Shop',
        '',
        '::: Books {kind=Trope anchors=Ledger}',
        ':::',
      ),
    }
    expect(faultsOf(await diagnosed(files, shop))).toEqual([inside])
  })

  it('guards the root unless it lists itself as an entry', async () => {
    const guarded = withShop(anchor('Payments'))
    expect(faultsOf(await diagnosed(guarded, shop))).toEqual([
      'Chapter `Payments` is private to the `Payments` trope. Use it via `Charging` instead.',
    ])
    const entered = { ...guarded, ...payments('Payments', 'Charging') }
    expect(faultsOf(await diagnosed(entered, shop))).toEqual([])
  })

  it('makes a root with no Entries line the only entry', async () => {
    const files = { ...payments(), [shop]: chapter(4, 'Shop', [], [anchor('Charging')]) }
    expect(faultsOf(await diagnosed(files, shop))).toEqual([
      'Chapter `Charging` is private to the `Payments` trope. Use it via `Payments` instead.',
    ])
  })
})

describe('tropes inside tropes', () => {
  const outer = '/corpus/shop.loom'
  const storefront = '/corpus/storefront.loom'
  const visitor = '/corpus/visitor.loom'
  const nested = (
    entries: ReadonlyArray<string>,
    front: ReadonlyArray<string> = [],
    visit: ReadonlyArray<string> = [],
  ): Record<string, string> => ({
    [outer]: tropeChapter(1, 'Shop', [`Entries: ${entries.join(', ')}`], [anchor('Storefront')]),
    [storefront]: chapter(2, 'Storefront', ['Rooted in: Shop'], [anchor('Charging'), ...front]),
    '/corpus/inventory.loom': chapter(3, 'Inventory', ['Rooted in: Shop'], ['const stock = 1']),
    [root]: tropeChapter(
      4,
      'Payments',
      ['Rooted in: Shop', 'Entries: Charging'],
      [anchor('Charging')],
    ),
    [charging]: chapter(
      5,
      'Charging',
      ['Rooted in: Payments'],
      [anchor('Ledger'), anchor('Inventory')],
    ),
    [ledger]: chapter(6, 'Ledger', ['Rooted in: Payments'], ['const ledger = 1']),
    [visitor]: chapter(7, 'Visitor', [], visit),
  })

  it('lets an inner trope see the outer one', async () => {
    const files = nested(['Storefront'])
    expect(faultsOf(await diagnosed(files, charging))).toEqual([])
    expect(faultsOf(await diagnosed(files, storefront))).toEqual([])
  })

  it("keeps an inner trope's inside from the outer one", async () => {
    const files = nested(['Storefront'], [anchor('Ledger')])
    expect(faultsOf(await diagnosed(files, storefront))).toEqual([
      'Chapter `Ledger` is private to the `Payments` trope. Use it via `Charging` instead.',
    ])
  })

  it('asks a chapter outside both for an entry at each boundary', async () => {
    expect(
      faultsOf(await diagnosed(nested(['Storefront'], [], [anchor('Charging')]), visitor)),
    ).toEqual([
      'Chapter `Charging` is private to the `Shop` trope. Use it via `Storefront` instead.',
    ])
    expect(
      faultsOf(await diagnosed(nested(['Storefront'], [], [anchor('Storefront')]), visitor)),
    ).toEqual([])
  })

  it('lets the outer trope offer an entry of the inner one', async () => {
    const files = nested(['Storefront', 'Charging'], [], [anchor('Charging')])
    expect(faultsOf(await diagnosed(files, visitor))).toEqual([])
    expect(faultsOf(await diagnosed(files, outer))).toEqual([])
  })

  it('refuses to offer a chapter the inner trope keeps private', async () => {
    expect(faultsOf(await diagnosed(nested(['Storefront', 'Ledger']), outer))).toEqual([
      "Chapter `Ledger` is private to the `Payments` trope, so this trope can't list it.",
    ])
  })

  it('faults tropes rooted in each other', async () => {
    const alpha = '/corpus/alpha.loom'
    const files = {
      [alpha]: tropeChapter(1, 'Alpha', ['Rooted in: Beta'], ['const a = 1']),
      '/corpus/beta.loom': tropeChapter(2, 'Beta', ['Rooted in: Alpha'], ['const b = 1']),
    }
    expect(faultsOf(await diagnosed(files, alpha))).toEqual([
      'Circular roots: `Alpha` → `Beta` → `Alpha`. Remove the `Rooted in:` line here, or the one in `Beta`.',
    ])
  })
})

describe('chapters whose relation is undeclared', () => {
  const rates = '/corpus/rates.loom'
  const undeclared = (code: ReadonlyArray<string>) => ({
    ...withShop(anchor('Rates')),
    [ledger]: chapter(3, 'Ledger', ['Rooted in: Payments'], [anchor('Rates')]),
    [rates]: chapter(5, 'Rates', [], code),
    '/corpus/fees.loom': chapter(6, 'Fees', ['Rooted in: Payments'], ['const fee = 1']),
  })
  const note =
    'Undeclared relation to the `Payments` trope. Add `Rooted in: Payments` to its frontmatter.'

  it('notes a chapter a trope reaches that names no trope', async () => {
    expect(await diagnosed(undeclared(['const rate = 1']), rates)).toContainEqual({
      line: 2,
      message: note,
    })
  })

  it('lets such a chapter see inside the trope, and stays open to others', async () => {
    const files = undeclared([anchor('Fees')])
    expect(faultsOf(await diagnosed(files, rates))).toEqual([note])
    expect(faultsOf(await diagnosed(files, shop))).toEqual([])
  })
})
