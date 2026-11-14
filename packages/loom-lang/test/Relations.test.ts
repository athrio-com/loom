import { describe, expect, it } from 'bun:test'
import { Effect, Option } from 'effect'
import { catalogueOf, type LoomModule } from '@athrio/loom-ast/LoomCorpusAst'
import { defaultAnchorDelims } from '@athrio/loom-ast/LoomTokens'
import { LoomCorpusAstBuilder, type Source } from '#ast/LoomCorpusAstBuilder'
import { approvedRelations, driftFaults, fingerprintOf, referencesOf } from '#ast/Relations'

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

describe('the references of a loom', () => {
  it('are its anchors and links that point into another loom', () => {
    const found = referencesOf(first.catalogue, first.billing)
    expect(found.map((reference) => [reference.kind, reference.to])).toEqual([
      ['anchor', 'Overdrafts'],
      ['link', 'Overdrafts'],
    ])
    expect(found.map((reference) => reference.target.module)).toEqual([rulesPath, rulesPath])
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
    expect(referencesOf(catalogueOf(modules), modules.get(billingPath)!)).toEqual([])
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
  const approved = approvedRelations(first.catalogue, first.billing, [])

  const changed = bookWith('An overdraft is a balance below the agreed limit.')

  it('says nothing of a reference nobody approved', () => {
    expect(driftFaults(changed.catalogue, changed.billing, [])).toEqual([])
  })

  it('says nothing while the section stands as approved', () => {
    expect(driftFaults(first.catalogue, first.billing, approved)).toEqual([])
  })

  it('warns on each approved reference once the section changes', () => {
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
    const again = approvedRelations(changed.catalogue, changed.billing, approved)
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

  const approved = approvedRelations(first.catalogue, first.billing, [elsewhere, gone])

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
