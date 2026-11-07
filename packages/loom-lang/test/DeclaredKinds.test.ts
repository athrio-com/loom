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

  it('may come from a manifest that draws in another section', async () => {
    const drawn = lines(
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
    const files = { [cells]: chapterWith('{Mermaid}'), [mermaid]: drawn }
    expect(faultsOf(await diagnosed(files, cells))).toEqual([])
    expect(faultsOf(await diagnosed(files, mermaid))).toEqual([])
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
