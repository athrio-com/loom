import { describe, expect, it } from 'bun:test'
import { Effect, Layer, Option } from 'effect'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { catalogueOf, type LoomModule } from '@athrio/loom-ast/LoomCorpusAst'
import { defaultAnchorDelims } from '@athrio/loom-ast/LoomTokens'
import { LoomCorpusAstBuilder, type Source } from '#ast/LoomCorpusAstBuilder'
import { approvedRelations, driftFaults, fingerprintOf, relationsOf } from '#ast/Relations'
import { DocumentSource, LoomCompiler } from '../src/LoomCompiler'
import { LoomDiskCache } from '../src/LoomDiskCache'
import { WorkspaceSettings } from '../src/WorkspaceSettings'
import { FileSystemSource } from '../src/WorkspaceSource'

const lines = (...rows: ReadonlyArray<string>): string => `${rows.join('\n')}\n`

const anchor = (name: string): string => `::${'['}${name}]`

const rulesPath = '/book/rules.loom'

const billingPath = '/book/billing.loom'

const rules = (definition: string): string =>
  lines(
    '# Overdrafts',
    '',
    definition,
    '',
    '=>',
    'export const overdrawn = (balance: number): boolean => balance < 0',
  )

const billing = lines(
  '# Billing [billing.ts]',
  '',
  `Billing refuses an account in overdraft, as ${anchor('Overdrafts')} defines it.`,
  '',
  '=>',
  anchor('Overdrafts'),
  'export const billable = (balance: number): boolean => !overdrawn(balance)',
)

const corpusOf = (files: Record<string, string>): ReadonlyMap<string, LoomModule> =>
  Effect.runSync(
    Effect.gen(function* () {
      const builder = yield* LoomCorpusAstBuilder
      const source: Source = {
        read: (path) => Effect.succeed(files[path] ?? ''),
        list: Option.none(),
      }
      const built = yield* Effect.forEach(Object.keys(files), (path) =>
        builder.build(source, path, defaultAnchorDelims, 'typescript'),
      )
      return new Map(built.map((module) => [module.path, module] as const))
    }).pipe(Effect.provide(LoomCorpusAstBuilder.layer)),
  )

const bookWith = (definition: string) => {
  const modules = corpusOf({ [rulesPath]: rules(definition), [billingPath]: billing })
  return { catalogue: catalogueOf(modules), billing: modules.get(billingPath)! }
}

const first = bookWith('An overdraft is a balance below zero.')

const every = (): boolean => true

describe('the references of a loom', () => {
  it('are its anchors and links that point into another loom', () => {
    const found = relationsOf(first.catalogue, first.billing, [])
    expect(found.map((relation) => [relation.kind, relation.to, relation.status])).toEqual([
      ['anchor', 'Overdrafts', 'untracked'],
      ['link', 'Overdrafts', 'untracked'],
    ])
    expect(found.map((relation) => relation.target.module)).toEqual([rulesPath, rulesPath])
  })

  it('leave out a reference to a section of the same loom', () => {
    const alone = lines(
      '# Overdrafts',
      '',
      'An overdraft is a balance below zero.',
      '',
      '=>',
      'export const overdrawn = (balance: number): boolean => balance < 0',
      '',
      '# Billing [billing.ts]',
      '',
      `Billing follows ${anchor('Overdrafts')}.`,
      '',
      '=>',
      anchor('Overdrafts'),
    )
    const modules = corpusOf({ [billingPath]: alone })
    expect(relationsOf(catalogueOf(modules), modules.get(billingPath)!, [])).toEqual([])
  })
})

describe('the fingerprint of a section', () => {
  const sectionOf = (text: string) => corpusOf({ [rulesPath]: text }).get(rulesPath)!.doc.sections[0]!

  const plain = fingerprintOf(sectionOf(rules('An overdraft is a balance below zero.')))

  it('changes with the prose', () => {
    expect(fingerprintOf(sectionOf(rules('An overdraft is a balance under zero.')))).not.toBe(plain)
  })

  it('changes with the code', () => {
    const recoded = rules('An overdraft is a balance below zero.').replace('< 0', '<= 0')
    expect(fingerprintOf(sectionOf(recoded))).not.toBe(plain)
  })

  it('holds through blank lines and spaces at the end of a line', () => {
    const tidied = rules('An overdraft is a balance below zero.   ').replace('=>\n', '=>\n\n')
    expect(fingerprintOf(sectionOf(tidied))).toBe(plain)
  })
})

describe('drift', () => {
  const approved = approvedRelations(first.catalogue, first.billing, [], every)

  const changed = bookWith('An overdraft is a balance below the agreed limit.')

  it('says nothing of a reference nobody approved', () => {
    expect(driftFaults(changed.catalogue, changed.billing, [])).toEqual([])
  })

  it('says nothing while the section stands as approved', () => {
    expect(driftFaults(first.catalogue, first.billing, approved)).toEqual([])
    expect(
      relationsOf(first.catalogue, first.billing, approved).map((relation) => relation.status),
    ).toEqual(['inStep', 'inStep'])
  })

  it('warns on each approved reference once the section changes', () => {
    expect(
      relationsOf(changed.catalogue, changed.billing, approved).map((relation) => relation.status),
    ).toEqual(['drifted', 'drifted'])
    const faults = driftFaults(changed.catalogue, changed.billing, approved)
    expect(faults.map((fault) => [fault.severity, fault.message])).toEqual([
      [
        'warning',
        '`Overdrafts` has changed since this reference to it was approved.',
      ],
      [
        'warning',
        '`Overdrafts` has changed since this reference to it was approved.',
      ],
    ])
  })

  it('is cleared by approving again', () => {
    const again = approvedRelations(changed.catalogue, changed.billing, approved, every)
    expect(driftFaults(changed.catalogue, changed.billing, again)).toEqual([])
  })
})

describe('approving a loom', () => {
  const elsewhere = {
    loom: '/book/letters.loom',
    section: 'Reminders',
    kind: 'link',
    to: 'Overdrafts',
    fingerprint: 'kept',
  }

  const gone = { ...elsewhere, loom: billingPath, section: 'Billing', to: 'Fees' }

  const approved = approvedRelations(first.catalogue, first.billing, [elsewhere, gone], every)

  it('records one relation for each reference, sorted by their names', () => {
    expect(approved.map((relation) => [relation.loom, relation.kind, relation.to])).toEqual([
      [billingPath, 'anchor', 'Overdrafts'],
      [billingPath, 'link', 'Overdrafts'],
      ['/book/letters.loom', 'link', 'Overdrafts'],
    ])
  })

  it("leaves another loom's relations as they were", () => {
    expect(approved).toContainEqual(elsewhere)
  })

  it('drops a relation whose reference is gone', () => {
    expect(approved.map((relation) => relation.to)).not.toContain('Fees')
  })
})

describe('approving one reference', () => {
  const isAnchor = (relation: { readonly kind: string }): boolean => relation.kind === 'anchor'

  const changed = bookWith('An overdraft is a balance below the agreed limit.')

  it('starts tracking that reference alone', () => {
    const approved = approvedRelations(first.catalogue, first.billing, [], isAnchor)
    expect(approved.map((relation) => relation.kind)).toEqual(['anchor'])
  })

  it('leaves another drifted reference drifted', () => {
    const before = approvedRelations(first.catalogue, first.billing, [], every)
    const after = approvedRelations(changed.catalogue, changed.billing, before, isAnchor)
    const faults = driftFaults(changed.catalogue, changed.billing, after)
    expect(faults.length).toBe(1)
  })
})

const compilerOver = (files: Record<string, string>) =>
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

describe("drift among a loom's problems", () => {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'loom-relations-')))
  const rulesAt = join(folder, 'rules.loom')
  const billingAt = join(folder, 'billing.loom')

  const bookOf = (definition: string) => ({ [rulesAt]: rules(definition), [billingAt]: billing })

  const driftIn = (definition: string, approving: boolean) =>
    Effect.runPromise(
      LoomCompiler.pipe(
        Effect.tap((compiler) =>
          approving ? Effect.asVoid(compiler.approve(billingAt, every)) : Effect.void,
        ),
        Effect.flatMap((compiler) => compiler.diagnose(billingAt)),
        Effect.map((found) =>
          found.filter((fault) => fault.message.includes('has changed since')).length,
        ),
        Effect.provide(compilerOver(bookOf(definition))),
      ),
    )

  it('shows nothing before a loom is approved, or while its sections stand', async () => {
    expect(await driftIn('An overdraft is a balance below zero.', false)).toBe(0)
    expect(await driftIn('An overdraft is a balance below zero.', true)).toBe(0)
  })

  it('shows each approved reference once its section changes, until approved again', async () => {
    expect(await driftIn('An overdraft is a balance below the agreed limit.', false)).toBe(2)
    expect(await driftIn('An overdraft is a balance below the agreed limit.', true)).toBe(0)
  })
})
