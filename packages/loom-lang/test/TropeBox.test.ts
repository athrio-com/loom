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

const compiled = <A, E>(
  files: Record<string, string>,
  use: (compiler: LoomCompiler['Service']) => Effect.Effect<A, E>,
) => Effect.runPromise(LoomCompiler.pipe(Effect.flatMap(use), Effect.provide(layerOf(files))))

const diagnosed = (files: Record<string, string>, entry: string) =>
  compiled(files, (compiler) => compiler.diagnose(entry)).then((found) =>
    found.map((d) => d.message),
  )

const shop = '/corpus/shop.loom'
const billing = '/corpus/billing.loom'

const shopLoom = (braces: string, body: ReadonlyArray<string>, after: ReadonlyArray<string> = []) =>
  lines(
    '---',
    'Part I, Chapter 1: The shop',
    '---',
    '',
    '# The shop',
    '',
    'A shop sells, and charges for what it sells.',
    '',
    `::: Payments ${braces}`,
    ...body,
    ':::',
    '',
    '## The program [shop.ts]',
    '',
    '=>',
    anchor('Payments'),
    ...after,
  )

const billingSection = [
  '',
  '## Billing',
  '',
  'Charge a member monthly.',
  '',
  '=>',
  'const charge = () => 1',
]

const billingLoom = (opening: string) =>
  lines(
    '---',
    'Part I, Chapter 2: Billing',
    '---',
    '',
    '# Billing',
    '',
    opening,
    '',
    '=>',
    'const charge = () => 1',
  )

describe('a trope nobody has settled', () => {
  it('carries a note, and its anchors are to be settled', async () => {
    const found = await diagnosed(
      { [shop]: shopLoom('{Trope}', ['Charge a member monthly.']) },
      shop,
    )
    expect(found).toContain(
      'The `Payments` trope points nowhere yet. Name the section or chapter that holds it with `anchors`.',
    )
    expect(found).toContain(
      'To be settled: `Payments` holds no code yet, so this anchor composes nothing.',
    )
    expect(found.some((message) => message.startsWith('Unresolved anchor'))).toBe(false)
  })

  it('names an anchors value that finds nothing', async () => {
    const found = await diagnosed(
      { [shop]: shopLoom('{kind=Trope anchors=Ledger}', ['Charge a member monthly.']) },
      shop,
    )
    expect(found).toContain(
      'No single section or chapter is called `Ledger`, so the `Payments` trope points nowhere yet.',
    )
  })

  it('faults a trope box with no name', async () => {
    const path = '/corpus/nameless.loom'
    expect(
      await diagnosed({ [path]: lines('# Nameless', '', '::: {Trope}', ':::') }, path),
    ).toContain(
      'Trope box without a name: a box of the `Trope` kind names a trope, so it needs a name, as in `::: Payments {Trope}`.',
    )
  })

  it('faults a trope key on a box of another kind', async () => {
    const path = '/corpus/rooms.loom'
    const found = await diagnosed(
      { [path]: lines('# Rooms', '', '::: Rooms {kind=Chapter anchors=Rooms}', ':::') },
      path,
    )
    expect(found).toContain('Only a trope box takes the `anchors` key.')
  })
})

describe('a settled trope', () => {
  const contentOf = (files: Record<string, string>) =>
    compiled(files, (compiler) => compiler.tangle(shop)).then((tangled) =>
      tangled.map((file) => file.content),
    )

  it('composes a section beside it', async () => {
    const files = {
      [shop]: shopLoom(
        '{kind=Trope anchors=Billing}',
        ['Charge a member monthly.'],
        billingSection,
      ),
    }
    expect(await contentOf(files)).toEqual(['const charge = () => 1\n'])
  })

  it('composes a chapter of its own, through the same anchor', async () => {
    const files = {
      [shop]: shopLoom('{kind=Trope anchors=Billing}', ['Charge a member monthly.']),
      [billing]: billingLoom('Charge a member monthly.'),
    }
    expect(await contentOf(files)).toEqual(['const charge = () => 1\n'])
  })
})

describe("a trope box's summary", () => {
  it('is in step when its body holds the opening', async () => {
    const files = {
      [shop]: shopLoom(
        '{kind=Trope anchors=Billing}',
        ['Charge a member monthly.'],
        billingSection,
      ),
    }
    const found = await diagnosed(files, shop)
    expect(found.some((message) => message.startsWith('Summary out of step'))).toBe(false)
    expect(
      found.some(
        (message) => message.startsWith('To be settled') || message.includes('points nowhere'),
      ),
    ).toBe(false)
  })

  it('warns when its body differs, with a fix that copies the opening in', async () => {
    const files = {
      [shop]: shopLoom('{kind=Trope anchors=Billing}', ['Payments, somehow.'], billingSection),
    }
    const found = await compiled(files, (compiler) => compiler.diagnose(shop))
    const stale = found.find((d) => d.message.startsWith('Summary out of step'))
    expect(stale?.message).toBe(
      "Summary out of step: this box holds a copy of the opening of the section `Billing`, and the two differ. Copy the section's opening into the box, or edit the section to match.",
    )
    expect(stale?.fixes?.[0]?.title).toBe('Copy the opening of `Billing`')
  })
})

describe('navigating a trope', () => {
  const settled = shopLoom(
    '{kind=Trope anchors=Billing}',
    ['Charge a member monthly.'],
    billingSection,
  )
  const files = { [shop]: settled }
  const lineOf = (text: string) => settled.split('\n').findIndex((line) => line.includes(text))

  it('follows its name to the entry point', async () => {
    const at = settled.indexOf('Payments {') + 1
    const found = await compiled(files, (compiler) => compiler.definition(shop, at))
    expect(found?.range.start.line).toBe(lineOf('## Billing'))
  })

  it('renames the anchors that name it with its name', async () => {
    const at = settled.indexOf('Payments {') + 1
    const found = await compiled(files, (compiler) => compiler.rename(shop, at))
    expect(found.map((location) => location.range.start.line).sort()).toEqual(
      [lineOf('::: Payments'), lineOf(anchor('Payments'))].sort(),
    )
  })

  it('moves its anchors value with a renamed entry point, and nothing else', async () => {
    const at = settled.indexOf('## Billing') + 4
    const found = await compiled(files, (compiler) => compiler.rename(shop, at))
    expect(found.map((location) => location.range.start.line).sort()).toEqual(
      [lineOf('::: Payments'), lineOf('## Billing')].sort(),
    )
  })
})

describe("a trope's promise", () => {
  it('promises its names while it is unsettled', async () => {
    const files = { [shop]: shopLoom('{kind=Trope provides=[charge, refund]}', ['Charges.']) }
    const promised = await compiled(files, (compiler) => compiler.promised(shop, 'theprogram'))
    expect(promised.map((name) => [name.name, name.section])).toEqual([
      ['charge', 'Payments'],
      ['refund', 'Payments'],
    ])
  })

  it('checks its names against the entry point once it is settled', async () => {
    const files = {
      [shop]: shopLoom(
        '{kind=Trope provides=[charge, refund] anchors=Billing}',
        ['Charge a member monthly.'],
        billingSection,
      ),
    }
    const contracts = await compiled(files, (compiler) => compiler.contracts(shop))
    const expected = contracts.flatMap((contract) => contract.expected)
    expect(expected.map((name) => name.diagnostic.message)).toEqual([
      'Missing symbol: `Billing` declares no `charge`, which the trope `Payments` promises.',
      'Missing symbol: `Billing` declares no `refund`, which the trope `Payments` promises.',
    ])
  })
})

describe('keeping a trope box in step as the author types', () => {
  const inStep = {
    [shop]: shopLoom('{kind=Trope anchors=Billing}', ['Charge a member monthly.']),
    [billing]: billingLoom('Charge a member monthly.'),
  }
  const edits = (path: string, before: string, after: string) =>
    compiled(inStep, (compiler) => compiler.summaryEdits(path, before, after))

  it('writes an edit to the entry point into the box', async () => {
    const found = await edits(billing, inStep[billing]!, billingLoom('Charge a member yearly.'))
    expect(found.map((edit) => [edit.path, edit.text])).toEqual([
      [shop, 'Charge a member yearly.\n'],
    ])
  })

  it('writes an edit to the box into the entry point', async () => {
    const after = shopLoom('{kind=Trope anchors=Billing}', ['Charge a member yearly.'])
    const found = await edits(shop, inStep[shop]!, after)
    expect(found.map((edit) => [edit.path, edit.text])).toEqual([
      [billing, 'Charge a member yearly.'],
    ])
  })
})
