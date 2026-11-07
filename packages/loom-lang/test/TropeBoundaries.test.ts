import { describe, expect, it } from 'bun:test'
import { Effect, Layer, Option } from 'effect'
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
  ).then((found) => found.map((d) => ({ line: d.position.start.line, message: d.message })))

const chapter = (
  number: number,
  title: string,
  fields: ReadonlyArray<string>,
  code: ReadonlyArray<string>,
) =>
  lines(
    '---',
    `Part I, Chapter ${number}: ${title}`,
    ...fields,
    '---',
    '',
    `# ${title}`,
    '',
    '=>',
    '',
    ...code,
  )

const faultsOf = (found: ReadonlyArray<{ readonly message: string }>) =>
  found
    .map((d) => d.message)
    .filter((message) =>
      [
        'Reaching inside',
        'Unknown entry',
        'Entries off the root',
        'Unreached member',
        'To be settled: the trope',
        'To be settled: no chapter roots',
      ].some((prefix) => message.startsWith(prefix)),
    )

const root = '/corpus/payments.loom'
const charging = '/corpus/charging.loom'
const ledger = '/corpus/ledger.loom'
const shop = '/corpus/shop.loom'

const payments = (...entries: ReadonlyArray<string>): Record<string, string> => ({
  [root]: chapter(
    1,
    'Payments',
    ['Trope: Payments', ...(entries.length > 0 ? [`Entries: ${entries.join(', ')}`] : [])],
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
      [ledger]: chapter(1, 'Ledger', ['Trope: Books'], ['const ledger = 1']),
      [shop]: chapter(2, 'Shop', [], [anchor('Ledger')]),
    }
    expect(faultsOf(await diagnosed(files, ledger))).toEqual([])
    expect(faultsOf(await diagnosed(files, shop))).toEqual([])
  })

  it('notes each member of a trope with no root', async () => {
    const files = {
      [charging]: chapter(1, 'Charging', ['Rooted in: Payments'], ['const charge = 1']),
      [ledger]: chapter(2, 'Ledger', ['Rooted in: Payments'], ['const ledger = 1']),
      [shop]: chapter(3, 'Shop', [], [anchor('Ledger')]),
    }
    const unrooted =
      'To be settled: no chapter roots the trope `Payments` yet, so Loom draws no boundary around it. Name the trope with a `Trope:` line in the chapter that roots it.'
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
      'Unknown entry: `Billing` leads to no one chapter of the book, so the trope has no entry by that name.',
    ])
  })

  it("faults a name that leads to another trope's chapter", async () => {
    const files = {
      ...payments('Charging', 'Diagrams'),
      '/corpus/diagrams.loom': chapter(5, 'Diagrams', ['Trope: Diagrams'], ['const d = 1']),
    }
    expect(faultsOf(await diagnosed(files, root))).toEqual([
      'Unknown entry: `Diagrams` is a chapter of the trope `Diagrams`, and only that trope can make it an entry.',
    ])
  })

  it('faults an Entries line on a member', async () => {
    const files = {
      ...payments('Charging'),
      [ledger]: chapter(3, 'Ledger', ['Rooted in: Payments', 'Entries: Ledger'], ['const l = 1']),
    }
    expect(faultsOf(await diagnosed(files, ledger))).toEqual([
      "Entries off the root: only a trope's root, the chapter that names the trope with a `Trope:` line, lists the trope's entries, so Loom reads nothing from this line. Move it to the root.",
    ])
  })
})

describe('reaching across the boundary', () => {
  const inside =
    'Reaching inside: `Ledger` lies inside the trope `Payments`, and a chapter outside the trope reaches only its entries: `Charging`.'

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
      'Reaching inside: `Payments` lies inside the trope `Payments`, and a chapter outside the trope reaches only its entries: `Charging`.',
    ])
    const entered = { ...guarded, ...payments('Payments', 'Charging') }
    expect(faultsOf(await diagnosed(entered, shop))).toEqual([])
  })

  it('makes a root with no Entries line the only entry', async () => {
    const files = { ...payments(), [shop]: chapter(4, 'Shop', [], [anchor('Charging')]) }
    expect(faultsOf(await diagnosed(files, shop))).toEqual([
      'Reaching inside: `Charging` lies inside the trope `Payments`, and a chapter outside the trope reaches only its entries: `Payments`.',
    ])
  })
})

describe('chapters out of step with the trope', () => {
  it('warns of a member nothing reaches', async () => {
    const refunds = '/corpus/refunds.loom'
    const files = {
      ...payments('Charging'),
      [refunds]: chapter(5, 'Refunds', ['Rooted in: Payments'], ['const refund = 1']),
    }
    const unreached =
      "Unreached member: this chapter names the trope `Payments`, but neither the trope's root nor its entries reach it, so it is a missing link or dead code. Reach it from the trope, or take its `Rooted in:` line off."
    expect(await diagnosed(files, refunds)).toContainEqual({ line: 3, message: unreached })
    expect(faultsOf(await diagnosed(files, ledger))).toEqual([])
  })

  it('notes a chapter the trope reaches by use alone', async () => {
    const rates = '/corpus/rates.loom'
    const files = {
      ...payments('Charging'),
      [ledger]: chapter(3, 'Ledger', ['Rooted in: Payments'], [anchor('Rates')]),
      [rates]: chapter(5, 'Rates', [], ['const rate = 1']),
    }
    const unsettled =
      'To be settled: the trope `Payments` reaches this chapter, which names no trope, so it belongs to `Payments` by use alone. Add `Rooted in: Payments` to its frontmatter to settle it.'
    expect(await diagnosed(files, rates)).toContainEqual({ line: 2, message: unsettled })
  })
})
