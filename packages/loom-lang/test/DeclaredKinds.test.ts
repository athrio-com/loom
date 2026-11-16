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
  ).then((found) => found.map((d) => d.message))

const cells = '/corpus/cells.loom'

const chapterWith = (braces: string) =>
  lines(
    '---',
    'Part I, Chapter 1: Cells',
    '---',
    '',
    '# Cells',
    '',
    `::: Cells ${braces}`,
    'flowchart LR',
    ':::',
  )

const withManifest = (
  identity: ReadonlyArray<string>,
  title: string,
  manifest: ReadonlyArray<string>,
) =>
  lines(
    '---',
    ...identity,
    '---',
    '',
    `# ${title}`,
    '',
    '## What it declares {Manifest}',
    '',
    '=>',
    ...manifest,
  )

const rootLoom = (title: string, manifest: ReadonlyArray<string>, part = '') =>
  withManifest([`${part}Trope Chapter: ${title}`], title, manifest)

const memberLoom = (title: string, trope: string, manifest: ReadonlyArray<string>) =>
  withManifest([`Chapter: ${title}`, `Rooted in: ${trope}`], title, manifest)

const declaring = (...kinds: ReadonlyArray<string>): string =>
  JSON.stringify({
    contract: '1',
    contributes: { kinds: { box: kinds.map((kind) => ({ kind, body: 'text' })) } },
  })

const faultsOf = (found: ReadonlyArray<string>) =>
  found.filter((message) =>
    ['A box takes no', 'Loom ignores this trope', 'Only a trope chapter can hold a manifest'].some(
      (start) => message.startsWith(start),
    ),
  )

const refusedFor = (reason: string) => `Loom ignores this trope: ${reason}.`

describe('a box of a kind nobody declares', () => {
  const unknown =
    'A box takes no `Mermaid` kind. It takes `Note`, `Chapter`, `Discussion`, `Trope`, and `Conclusion`.'

  it('is a fault, named by a label', async () => {
    expect(faultsOf(await diagnosed({ [cells]: chapterWith('{Mermaid}') }, cells))).toEqual([
      unknown,
    ])
  })

  it('is a fault, named by a parameter', async () => {
    expect(faultsOf(await diagnosed({ [cells]: chapterWith('{kind=Mermaid}') }, cells))).toEqual([
      unknown,
    ])
  })
})

describe('a box of a kind a trope declares', () => {
  const mermaid = '/corpus/mermaid/declaring.loom'
  const withTrope = (braces: string) => ({
    [cells]: chapterWith(braces),
    [mermaid]: rootLoom('Mermaid', [declaring('Mermaid')]),
  })

  it('raises nothing', async () => {
    expect(faultsOf(await diagnosed(withTrope('{Mermaid}'), cells))).toEqual([])
    expect(faultsOf(await diagnosed(withTrope('{kind=mermaid}'), cells))).toEqual([])
  })

  it('joins the kinds a fault lists', async () => {
    expect(faultsOf(await diagnosed(withTrope('{Chart}'), cells))).toEqual([
      'A box takes no `Chart` kind. It takes `Note`, `Chapter`, `Discussion`, `Trope`, `Conclusion`, and `Mermaid`.',
    ])
  })

  it('may come from a manifest whose anchor composes another section', async () => {
    const withinRoot = lines(
      '---',
      'Trope Chapter: Mermaid',
      '---',
      '',
      '# Mermaid',
      '',
      '## The Mermaid kind {json}',
      '',
      '=>',
      '{ "kind": "Mermaid", "body": "mermaid" }',
      '',
      '## What it declares {Manifest}',
      '',
      '=>',
      '{ "contract": "1", "contributes": { "kinds": { "box": [',
      anchor('The Mermaid kind'),
      '] } } }',
    )
    const files = { [cells]: chapterWith('{Mermaid}'), [mermaid]: withinRoot }
    expect(faultsOf(await diagnosed(files, cells))).toEqual([])
    expect(faultsOf(await diagnosed(files, mermaid))).toEqual([])
  })

  const kindLoom = (identity: ReadonlyArray<string>) =>
    lines(
      '---',
      'Chapter: The Mermaid kind',
      ...identity,
      'Language: JSON',
      '---',
      '',
      '# The Mermaid kind',
      '',
      '=>',
      '{ "kind": "Mermaid", "body": "mermaid" }',
    )

  const anchoring = rootLoom('Mermaid', [
    '{ "contract": "1", "contributes": { "kinds": { "box": [',
    anchor('The Mermaid kind'),
    '] } } }',
  ])

  const kindAt = '/corpus/mermaid/the-kind.loom'

  it('may come from a manifest whose anchor composes a section of a member', async () => {
    const files = {
      [cells]: chapterWith('{Mermaid}'),
      [mermaid]: anchoring,
      [kindAt]: kindLoom(['Rooted in: Mermaid']),
    }
    expect(faultsOf(await diagnosed(files, cells))).toEqual([])
    expect(faultsOf(await diagnosed(files, mermaid))).toEqual([])
  })

  const outside = refusedFor(
    'an anchor in its manifest names `The Mermaid kind`, and no chapter of the trope holds a section called that',
  )

  it('comes from no chapter outside a trope', async () => {
    const files = { [cells]: chapterWith('{Mermaid}'), [mermaid]: anchoring, [kindAt]: kindLoom([]) }
    expect(faultsOf(await diagnosed(files, mermaid))).toEqual([outside])
  })

  it('comes from no chapter of another trope', async () => {
    const files = {
      [cells]: chapterWith('{Mermaid}'),
      [mermaid]: anchoring,
      [kindAt]: kindLoom(['Rooted in: Charts']),
    }
    expect(faultsOf(await diagnosed(files, mermaid))).toEqual([outside])
  })
})

describe('a root Loom refuses', () => {
  const root = '/corpus/mermaid/declaring.loom'
  const refused = async (text: string) => {
    const files = { [cells]: chapterWith('{Mermaid}'), [root]: text }
    return {
      own: faultsOf(await diagnosed(files, root)),
      box: faultsOf(await diagnosed(files, cells)),
    }
  }

  it('declares nothing when it holds no manifest', async () => {
    const found = await refused(lines('---', 'Trope Chapter: Drawing', '---', '', '# Drawing'))
    expect(found.own).toEqual([])
    expect(found.box).toHaveLength(1)
  })

  it('holds two manifests', async () => {
    const twice = rootLoom('Mermaid', [
      declaring('Mermaid'),
      '',
      '## Again {Manifest}',
      '',
      '=>',
      declaring('Run'),
    ])
    expect((await refused(twice)).own).toEqual([refusedFor('it holds more than one manifest')])
  })

  it('holds a manifest that does not read', async () => {
    const found = await refused(rootLoom('Mermaid', ['{ "contract": "2" }']))
    expect(found.own).toEqual([refusedFor('it needs contract 2, and this Loom reads contract 1')])
    expect(found.box).toHaveLength(1)
  })
})

describe('roots and kinds that clash', () => {
  const first = '/corpus/tropes/a-charts.loom'
  const second = '/corpus/tropes/b-diagrams.loom'

  it('refuses a second root of one trope', async () => {
    const files = {
      [first]: rootLoom('Pictures', [declaring('Chart')], 'Part I, '),
      [second]: rootLoom('Pictures', [declaring('Diagram')], 'Part II, '),
    }
    expect(faultsOf(await diagnosed(files, first))).toEqual([])
    expect(faultsOf(await diagnosed(files, second))).toEqual([
      refusedFor('another trope chapter is called `Pictures`'),
    ])
  })

  it('reads nothing from a manifest off the root', async () => {
    const files = {
      [cells]: chapterWith('{Diagram}'),
      [first]: rootLoom('Pictures', [declaring('Chart')]),
      [second]: memberLoom('Diagrams', 'Pictures', [declaring('Diagram')]),
    }
    expect(faultsOf(await diagnosed(files, second))).toEqual([
      'Only a trope chapter can hold a manifest.',
    ])
    expect(faultsOf(await diagnosed(files, cells))).toHaveLength(1)
  })

  it('refuses a root that declares a core kind', async () => {
    const files = { [first]: rootLoom('Notes', [declaring('note')]) }
    expect(faultsOf(await diagnosed(files, first))).toEqual([
      refusedFor("`note` is one of Loom's own kinds"),
    ])
  })

  it('refuses the later of two roots that declare one kind', async () => {
    const files = {
      [cells]: chapterWith('{Mermaid}'),
      [first]: rootLoom('Charts', [declaring('Mermaid')]),
      [second]: rootLoom('Diagrams', [declaring('Mermaid', 'Run')]),
    }
    expect(faultsOf(await diagnosed(files, first))).toEqual([])
    expect(faultsOf(await diagnosed(files, second))).toEqual([
      refusedFor('the `Charts` trope declares `Mermaid` already'),
    ])
    expect(faultsOf(await diagnosed(files, cells))).toEqual([])
  })

  it('refuses a root that declares one kind twice', async () => {
    const files = { [first]: rootLoom('Charts', [declaring('Chart', 'chart')]) }
    expect(faultsOf(await diagnosed(files, first))).toEqual([
      refusedFor('it declares `chart` twice'),
    ])
  })
})

describe('kinds of section that clash', () => {
  const first = '/corpus/tropes/a-decisions.loom'
  const second = '/corpus/tropes/b-choices.loom'
  const sections = (
    ...kinds: ReadonlyArray<{ kind: string; parameters?: Record<string, unknown> }>
  ): string => JSON.stringify({ contract: '1', contributes: { kinds: { section: kinds } } })

  it('refuses a root that declares a core kind of section', async () => {
    const files = { [first]: rootLoom('Decisions', [sections({ kind: 'tangle' })]) }
    expect(faultsOf(await diagnosed(files, first))).toEqual([
      refusedFor("`tangle` is one of Loom's own kinds"),
    ])
  })

  it('refuses the later of two roots that declare one kind of section', async () => {
    const files = {
      [first]: rootLoom('Decisions', [sections({ kind: 'Option' })]),
      [second]: rootLoom('Choices', [sections({ kind: 'option' })]),
    }
    expect(faultsOf(await diagnosed(files, first))).toEqual([])
    expect(faultsOf(await diagnosed(files, second))).toEqual([
      refusedFor('the `Decisions` trope declares `option` already'),
    ])
  })

  it("refuses a parameter under one of the core's own keys", async () => {
    const files = {
      [first]: rootLoom('Decisions', [sections({ kind: 'Option', parameters: { lang: 'text' } })]),
    }
    expect(faultsOf(await diagnosed(files, first))).toEqual([
      refusedFor("`lang` is one of Loom's own keys"),
    ])
  })

  it('lets a kind of box and a kind of section share a name', async () => {
    const both = JSON.stringify({
      contract: '1',
      contributes: { kinds: { box: [{ kind: 'Option', body: 'text' }], section: [{ kind: 'Option' }] } },
    })
    expect(faultsOf(await diagnosed({ [first]: rootLoom('Decisions', [both]) }, first))).toEqual([])
  })
})

describe('a heading of a kind a trope declares', () => {
  const decisions = '/corpus/decisions/declaring.loom'
  const chapter = '/corpus/record.loom'

  const declaringSection = (kind: string): string =>
    JSON.stringify({
      contract: '1',
      contributes: {
        kinds: {
          section: [{ kind, parameters: { status: { choice: ['chosen', 'rejected'] } } }],
        },
      },
    })

  const record = (braces: string) =>
    lines(
      '---',
      'Part I, Chapter 1: A record',
      '---',
      '',
      '# A record',
      '',
      `## Postgres ${braces}`,
      '',
      'Prose.',
    )

  const book = (braces: string): Record<string, string> => ({
    [chapter]: record(braces),
    [decisions]: rootLoom('Decisions', [declaringSection('Option')]),
  })

  const said = (found: ReadonlyArray<string>) =>
    found.filter((message) => message.includes(' takes no '))

  it('raises nothing, named by a label or with a parameter the kind takes', async () => {
    expect(said(await diagnosed(book('{Option}'), chapter))).toEqual([])
    expect(said(await diagnosed(book('{kind=option status=chosen}'), chapter))).toEqual([])
  })

  it("reads the kind's parameter through its type", async () => {
    expect(said(await diagnosed(book('{kind=Option status=maybe}'), chapter))).toEqual([
      '`status` takes no `maybe`. It takes `chosen` and `rejected`.',
    ])
  })

  it("keeps the kind's parameter from a heading of no kind", async () => {
    expect(said(await diagnosed(book('{status=chosen}'), chapter))).toEqual([
      'A heading takes no `status` key. It takes `lang` and `kind`.',
    ])
  })

  it('joins the kinds a fault lists', async () => {
    expect(said(await diagnosed(book('{kind=Bogus}'), chapter))).toEqual([
      'A heading takes no `Bogus` kind. It takes `Tangle`, `Concept`, `Manifest`, and `Option`.',
    ])
  })

  it('is a fault while no trope declares it', async () => {
    expect(said(await diagnosed({ [chapter]: record('{kind=Option}') }, chapter))).toEqual([
      'A heading takes no `Option` kind. It takes `Tangle`, `Concept`, and `Manifest`.',
    ])
  })

  it('may stand in the root that declares it', async () => {
    const root = lines(
      rootLoom('Decisions', [declaringSection('Option')]),
      '## Postgres {kind=Option status=chosen}',
      '',
      'Prose.',
    )
    const found = await diagnosed({ [decisions]: root }, decisions)
    expect(said(found)).toEqual([])
    expect(faultsOf(found)).toEqual([])
  })

  it('reads every loom again when a manifest comes to declare another kind', async () => {
    const files = book('{kind=Choice}')
    const found = await Effect.runPromise(
      Effect.gen(function* () {
        const compiler = yield* LoomCompiler
        const before = yield* compiler.diagnose(chapter)
        files[decisions] = rootLoom('Decisions', [declaringSection('Choice')])
        yield* compiler.invalidate(decisions)
        const after = yield* compiler.diagnose(chapter)
        return {
          before: before.map((d) => d.message),
          after: after.map((d) => d.message),
        }
      }).pipe(Effect.provide(layerOf(files))),
    )
    expect(said(found.before)).toEqual([
      'A heading takes no `Choice` kind. It takes `Tangle`, `Concept`, `Manifest`, and `Option`.',
    ])
    expect(said(found.after)).toEqual([])
  })
})

describe('what a trope declares for anchors, boxes, and headings', () => {
  const notebooks = '/corpus/notebooks/declaring.loom'
  const second = '/corpus/notebooks/z-other.loom'
  const chapter = '/corpus/survey.loom'

  const contributing = (contributes: Record<string, unknown>): string =>
    JSON.stringify({ contract: '1', contributes })

  const all = contributing({
    kinds: {
      box: [{ kind: 'Dataset', body: 'yaml', parameters: { source: 'text' } }],
      anchor: [{ kind: 'Decision', parameters: { weight: 'number' } }],
    },
    headings: { parameters: { locale: 'locale' } },
  })

  const usingAll = (heading: string, box: string, braces: string) =>
    lines(
      '---',
      'Part I, Chapter 1: A survey',
      '---',
      '',
      '# A survey',
      '',
      `## The sample ${heading}`,
      '',
      `::: Sample ${box}`,
      'columns: [age]',
      ':::',
      '',
      '=>',
      'const sample = 1',
      '',
      '## The count [count.ts]',
      '',
      '=>',
      `${anchor('The sample')}${braces}`,
    )

  const said = (found: ReadonlyArray<string>) =>
    found.filter((message) => message.includes(' takes '))

  const book = (heading: string, box: string, braces: string) => ({
    [chapter]: usingAll(heading, box, braces),
    [notebooks]: rootLoom('Notebooks', [all]),
  })

  it('lets every loom use them', async () => {
    const files = book('{locale=et}', '{kind=Dataset source="survey.csv"}', '{kind=Decision weight=3}')
    expect(said(await diagnosed(files, chapter))).toEqual([])
  })

  it('reads each of their values through its type', async () => {
    const files = book('{locale=pt_BR}', '{Dataset}', '{kind=Decision weight=heavy}')
    expect(said(await diagnosed(files, chapter))).toEqual([
      '`locale` takes a language tag, and `pt_BR` is not one. Write a tag such as `et` or `pt-BR`.',
      '`weight` takes a number, and `heavy` is not one. Write a number, such as `480`.',
    ])
  })

  it('lists a declared kind of anchor among the kinds an anchor takes', async () => {
    const files = book('', '{Dataset}', '{Verdict}')
    expect(said(await diagnosed(files, chapter))).toEqual([
      'An anchor takes no `Verdict` kind. It takes `To be settled`, `Module`, and `Decision`.',
    ])
  })

  it("refuses a root that declares one of the core's kinds of anchor", async () => {
    const files = {
      [notebooks]: rootLoom('Notebooks', [contributing({ kinds: { anchor: [{ kind: 'module' }] } })]),
    }
    expect(faultsOf(await diagnosed(files, notebooks))).toEqual([
      refusedFor("`module` is one of Loom's own kinds"),
    ])
  })

  it("refuses a parameter of a box or an anchor under one of the core's own keys", async () => {
    const box = contributing({
      kinds: { box: [{ kind: 'Dataset', body: 'yaml', parameters: { anchors: 'reference' } }] },
    })
    const braces = contributing({
      kinds: { anchor: [{ kind: 'Decision', parameters: { provides: 'text' } }] },
    })
    expect(
      faultsOf(await diagnosed({ [notebooks]: rootLoom('Notebooks', [box]) }, notebooks)),
    ).toEqual([refusedFor("`anchors` is one of Loom's own keys")])
    expect(
      faultsOf(await diagnosed({ [notebooks]: rootLoom('Notebooks', [braces]) }, notebooks)),
    ).toEqual([refusedFor("`provides` is one of Loom's own keys")])
  })

  it("refuses a key for headings that is one of the core's own", async () => {
    const files = {
      [notebooks]: rootLoom('Notebooks', [contributing({ headings: { parameters: { lang: 'text' } } })]),
    }
    expect(faultsOf(await diagnosed(files, notebooks))).toEqual([
      refusedFor("`lang` is one of Loom's own keys"),
    ])
  })

  it('refuses the later of two roots that give headings one key', async () => {
    const files = {
      [notebooks]: rootLoom('Notebooks', [all]),
      [second]: rootLoom('Other', [contributing({ headings: { parameters: { locale: 'text' } } })]),
    }
    expect(faultsOf(await diagnosed(files, notebooks))).toEqual([])
    expect(faultsOf(await diagnosed(files, second))).toEqual([
      refusedFor('the `Notebooks` trope lets any heading carry `locale` already'),
    ])
  })

  it('refuses a key for headings that a kind of section lists', async () => {
    const both = contributing({
      kinds: { section: [{ kind: 'Option', parameters: { status: 'text' } }] },
      headings: { parameters: { status: 'text' } },
    })
    const later = contributing({
      kinds: { section: [{ kind: 'Verdict', parameters: { locale: 'text' } }] },
    })
    expect(
      faultsOf(await diagnosed({ [notebooks]: rootLoom('Notebooks', [both]) }, notebooks)),
    ).toEqual([refusedFor('`status` is a parameter of the `Option` kind of section already')])
    const files = { [notebooks]: rootLoom('Notebooks', [all]), [second]: rootLoom('Other', [later]) }
    expect(faultsOf(await diagnosed(files, second))).toEqual([
      refusedFor('the `Notebooks` trope lets any heading carry `locale` already'),
    ])
  })
})

describe('a parameter that names a section', () => {
  const decisions = '/corpus/decisions/declaring.loom'
  const rulesAt = '/corpus/rules.loom'
  const recordAt = '/corpus/record.loom'

  const declaring = JSON.stringify({
    contract: '1',
    contributes: {
      kinds: { section: [{ kind: 'Option', parameters: { replaces: 'reference' } }] },
      headings: { parameters: { follows: 'reference', related: { list: 'reference' } } },
    },
  })

  const rules = lines(
    '---',
    'Part I, Chapter 2: Rules',
    '---',
    '',
    '# Rules',
    '',
    '## Overdrafts',
    '',
    'An overdraft is a balance below zero.',
  )

  const record = (braces: string) =>
    lines(
      '---',
      'Part I, Chapter 1: A record',
      '---',
      '',
      '# A record',
      '',
      `## Refusing a charge ${braces}`,
      '',
      'Prose.',
    )

  const book = (braces: string): Record<string, string> => ({
    [recordAt]: record(braces),
    [rulesAt]: rules,
    [decisions]: rootLoom('Decisions', [declaring]),
  })

  const asked = <A>(
    files: Record<string, string>,
    use: (compiler: LoomCompiler['Service']) => Effect.Effect<A>,
  ) => Effect.runPromise(LoomCompiler.pipe(Effect.flatMap(use), Effect.provide(layerOf(files))))

  const naming = (found: ReadonlyArray<string>) =>
    found.filter((message) => message.includes(' names '))

  const unfound = (key: string, name: string) =>
    `\`${key}\` names \`${name}\`, and no section or chapter is called that. Name one that exists.`

  it('raises nothing for a name that finds a section or a chapter', async () => {
    expect(naming(await diagnosed(book('{follows="Rules, Overdrafts"}'), recordAt))).toEqual([])
    expect(naming(await diagnosed(book('{follows=Rules}'), recordAt))).toEqual([])
  })

  it('warns of a name that finds nothing, under the key that holds it', async () => {
    expect(naming(await diagnosed(book('{follows="Rules, Overdraughts"}'), recordAt))).toEqual([
      unfound('follows', 'Rules, Overdraughts'),
    ])
    expect(naming(await diagnosed(book('{kind=Option replaces=Nowhere}'), recordAt))).toEqual([
      unfound('replaces', 'Nowhere'),
    ])
  })

  it('judges each name of a list', async () => {
    const files = book('{related=["Rules, Overdrafts", Nowhere]}')
    expect(naming(await diagnosed(files, recordAt))).toEqual([unfound('related', 'Nowhere')])
  })

  const spansOf = (
    found: ReadonlyArray<{
      readonly path: string
      readonly range: {
        readonly start: { readonly line: number; readonly character: number }
        readonly end: { readonly character: number }
      }
    }>,
  ) =>
    found
      .map((place) => [
        place.path,
        place.range.start.line,
        place.range.start.character,
        place.range.end.character,
      ])
      .sort()

  it('is rewritten when its section is renamed, at the step that names the section', async () => {
    const braces = '{follows="Rules, Overdrafts"}'
    const heading = `## Refusing a charge ${braces}`
    const start = heading.indexOf('Overdrafts')
    const at = rules.indexOf('## Overdrafts') + 4
    const found = await asked(book(braces), (compiler) => compiler.rename(rulesAt, at))
    expect(spansOf(found)).toEqual(
      [
        [recordAt, 6, start, start + 'Overdrafts'.length],
        [rulesAt, 6, 3, 3 + 'Overdrafts'.length],
      ].sort(),
    )
  })

  it('is listed among the references to its section', async () => {
    const at = rules.indexOf('## Overdrafts') + 4
    const found = await asked(book('{follows="Rules, Overdrafts"}'), (compiler) =>
      compiler.references(rulesAt, at),
    )
    expect(spansOf(found).map(([path]) => path)).toEqual([recordAt, rulesAt])
  })
})
