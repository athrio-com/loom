import { describe, expect, it } from 'bun:test'
import { Effect, Layer, Option, Result } from 'effect'
import { defaultAnchorDelims } from '@athrio/loom-ast/LoomTokens'
import type { LoomDocument } from '@athrio/loom-ast/LoomAst'
import { DocumentSource, LoomCompiler } from '../src/LoomCompiler'
import { WorkspaceSettings } from '../src/WorkspaceSettings'
import { LoomDiskCache } from '../src/LoomDiskCache'
import { FileSystemSource } from '../src/WorkspaceSource'
import {
  anchorKindsOf,
  boxKindsOf,
  headingKeysOf,
  heldBy,
  loomKindsOf,
  parametersOf,
  readManifest,
  sectionKindsOf,
} from '../src/ast/TropeManifest'
import { parseDocument, ParseLayer } from './parse'

const lines = (...rows: ReadonlyArray<string>): string => `${rows.join('\n')}\n`

const parse = (src: string): LoomDocument =>
  Effect.runSync(parseDocument(src).pipe(Effect.provide(ParseLayer)))

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

const manifestOf = (...kinds: ReadonlyArray<string>): string =>
  JSON.stringify({
    contract: '1',
    contributes: { kinds: { box: kinds.map((kind) => ({ kind, body: 'text' })) } },
  })

describe("a chapter's trope", () => {
  it('roots the trope a trope chapter titles', () => {
    const fm = parse(
      lines('---', 'Part I, Trope Chapter 1: Mermaid', '---', '', '# Mermaid'),
    ).frontmatter
    expect([fm?.trope?.value, fm?.title?.value, fm?.part?.value, fm?.chapter?.value]).toEqual([
      'Mermaid',
      'Mermaid',
      'I',
      '1',
    ])
  })

  it('reads a trope chapter with no number and no part', () => {
    const fm = parse(lines('---', 'Trope Chapter: Mermaid', '---', '', '# Mermaid')).frontmatter
    expect([fm?.trope?.value, fm?.title?.value, fm?.chapter?.value]).toEqual([
      'Mermaid',
      'Mermaid',
      undefined,
    ])
  })

  it("reads a member's line apart from a root's", () => {
    const fm = parse(
      lines('---', 'Part I, Chapter 2: Shapes', 'Rooted in: Mermaid', '---', '', '# Shapes'),
    ).frontmatter
    expect([fm?.trope?.value, fm?.rootedIn?.value, fm?.title?.value]).toEqual([
      undefined,
      'Mermaid',
      'Shapes',
    ])
  })
})

describe('a manifest section', () => {
  const manifestIn = (...identity: ReadonlyArray<string>) =>
    lines(
      '---',
      ...identity,
      '---',
      '',
      '# Diagrams',
      '',
      '## What it declares {Manifest}',
      '',
      '=>',
      manifestOf('Mermaid'),
    )
  const outside = 'Only a trope chapter can hold a manifest.'

  it('raises nothing in a trope chapter', async () => {
    const path = '/corpus/diagrams.loom'
    const root = manifestIn('Part I, Trope Chapter 1: Diagrams')
    expect(await diagnosed({ [path]: root }, path)).not.toContain(outside)
  })

  it('is a fault in a chapter of no trope', async () => {
    const path = '/corpus/diagrams.loom'
    expect(await diagnosed({ [path]: manifestIn('Part I, Chapter 1: Diagrams') }, path)).toContain(
      outside,
    )
  })

  it('is a fault in a member of a trope', async () => {
    const path = '/corpus/diagrams.loom'
    const member = manifestIn('Part I, Chapter 2: Diagrams', 'Rooted in: Charts')
    expect(await diagnosed({ [path]: member }, path)).toContain(outside)
  })
})

describe("a loom's kind in its identity line", () => {
  const identity = (...rows: ReadonlyArray<string>) =>
    parse(lines('---', ...rows, '---', '', '# The next release')).frontmatter

  it('reads the kind, its number, and the part it belongs to', () => {
    const fm = identity('Part XI, Tasks 1: The next release')
    expect([fm?.part?.value, fm?.kind?.value, fm?.kind?.number, fm?.title?.value]).toEqual([
      'XI',
      'Tasks',
      '1',
      'The next release',
    ])
    expect([fm?.chapter, fm?.discussion, fm?.partName]).toEqual([undefined, undefined, undefined])
  })

  it('reads a kind of several words, and a kind with no number', () => {
    const listed = identity('Task list 12: The next release')
    expect([listed?.kind?.value, listed?.kind?.number]).toEqual(['Task list', '12'])
    const bare = identity('Part: Work in progress', 'Tasks: The next release')
    expect([bare?.partName?.value, bare?.kind?.value, bare?.kind?.number]).toEqual([
      'Work in progress',
      'Tasks',
      '',
    ])
  })

  it('reads no kind in a field of the frontmatter', () => {
    const fm = identity('Chapter 1: The next release', 'Package: src/release.ts', 'Book: The game')
    expect([fm?.kind, fm?.chapter?.value, fm?.package?.value]).toEqual([
      undefined,
      '1',
      'src/release.ts',
    ])
  })

  it('keeps a chapter a chapter, whatever line stands before it', () => {
    const fm = identity('Reviewed by: Ada', 'Chapter 2: The next release')
    expect([fm?.kind, fm?.chapter?.value, fm?.title?.value]).toEqual([
      undefined,
      '2',
      'The next release',
    ])
  })

  it('reads a discussion or a chapter that names its part and no number', () => {
    const talk = identity('Part II, Discussion: The next release')
    expect([talk?.part?.value, talk?.discussion?.value, talk?.partName]).toEqual([
      'II',
      '',
      undefined,
    ])
    const chapter = identity('Part II, Chapter: The next release')
    expect([chapter?.part?.value, chapter?.title?.value, chapter?.partName]).toEqual([
      'II',
      'The next release',
      undefined,
    ])
  })
})

describe('reading a manifest', () => {
  const reason = (text: string) =>
    Result.match(readManifest(text), { onSuccess: () => '', onFailure: (why) => why })

  it('reads the kinds a fitting manifest declares', () => {
    const read = Result.getOrUndefined(readManifest(manifestOf('Mermaid', 'Run')))
    expect(read && boxKindsOf(read).map((declared) => declared.kind)).toEqual(['Mermaid', 'Run'])
  })

  it('reads the kinds of section a manifest declares, with their parameters', () => {
    const options = JSON.stringify({
      contract: '1',
      contributes: {
        kinds: {
          section: [
            { kind: 'Option', parameters: { status: { choice: ['chosen', 'rejected'] } } },
            { kind: 'Context' },
          ],
        },
      },
    })
    const read = Result.getOrUndefined(readManifest(options))
    expect(read && sectionKindsOf(read)).toEqual([
      { kind: 'Option', parameters: { status: { choice: ['chosen', 'rejected'] } } },
      { kind: 'Context' },
    ])
    expect(read && boxKindsOf(read)).toEqual([])
  })

  it('reads the kinds of anchor, the parameters of a box, and the keys for headings', () => {
    const notebooks = JSON.stringify({
      contract: '1',
      contributes: {
        kinds: {
          box: [{ kind: 'Dataset', body: 'yaml', parameters: { source: 'text' } }],
          anchor: [{ kind: 'Decision', parameters: { weight: 'number' } }, { kind: 'Cited' }],
        },
        headings: { parameters: { translates: 'reference', locale: 'locale' } },
      },
    })
    const read = Result.getOrUndefined(readManifest(notebooks))
    expect(read && boxKindsOf(read).map(parametersOf)).toEqual([{ source: 'text' }])
    expect(read && anchorKindsOf(read).map((declared) => declared.kind)).toEqual([
      'Decision',
      'Cited',
    ])
    expect(read && anchorKindsOf(read).map(parametersOf)).toEqual([{ weight: 'number' }, {}])
    expect(read && headingKeysOf(read)).toEqual({ translates: 'reference', locale: 'locale' })
  })

  it('reads the rule a kind of section or of anchor follows', () => {
    const decisions = JSON.stringify({
      contract: '1',
      contributes: {
        kinds: {
          section: [{ kind: 'Option', code: 'none' }, { kind: 'Context' }],
          anchor: [{ kind: 'Decision', standsIn: 'prose' }, { kind: 'Seen' }],
        },
      },
    })
    const read = Result.getOrUndefined(readManifest(decisions))
    expect(read && sectionKindsOf(read).map((declared) => declared.code)).toEqual([
      'none',
      undefined,
    ])
    expect(read && anchorKindsOf(read).map((declared) => declared.standsIn)).toEqual([
      'prose',
      undefined,
    ])
  })

  it('reads the kinds of loom a manifest declares, with what each says', () => {
    const tasks = JSON.stringify({
      contract: '1',
      contributes: {
        kinds: {
          loom: [
            { kind: 'Tasks', numbered: true, zone: 'back', code: 'none', holds: ['Task'] },
            { kind: 'Task list' },
          ],
          section: [{ kind: 'Task' }],
        },
      },
    })
    const read = Result.getOrUndefined(readManifest(tasks))
    expect(read && loomKindsOf(read)).toEqual([
      { kind: 'Tasks', numbered: true, zone: 'back', code: 'none', holds: ['Task'] },
      { kind: 'Task list' },
    ])
    expect(read && loomKindsOf(read).map(heldBy)).toEqual([['Task'], []])
  })

  it('refuses a kind of loom whose word holds a number, and a zone the book lacks', () => {
    const kindsOf = (loom: unknown) =>
      JSON.stringify({ contract: '1', contributes: { kinds: { loom: [loom] } } })
    expect(reason(kindsOf({ kind: 'Sprint 3' }))).toContain(
      'a kind of loom must be words of letters, got `Sprint 3`',
    )
    expect(reason(kindsOf({ kind: 'Tasks', zone: 'front' }))).toContain(
      'its manifest does not fit contract 1:',
    )
  })

  it('refuses a rule the contract does not know', () => {
    const elsewhere = JSON.stringify({
      contract: '1',
      contributes: { kinds: { anchor: [{ kind: 'Decision', standsIn: 'frontmatter' }] } },
    })
    expect(reason(elsewhere)).toContain('its manifest does not fit contract 1:')
  })

  it('reads a manifest that declares keys for headings and no kinds', () => {
    const translations = JSON.stringify({
      contract: '1',
      contributes: { headings: { parameters: { locale: 'locale' } } },
    })
    const read = Result.getOrUndefined(readManifest(translations))
    expect(read && headingKeysOf(read)).toEqual({ locale: 'locale' })
    expect(read && boxKindsOf(read)).toEqual([])
    expect(read && anchorKindsOf(read)).toEqual([])
  })

  it('refuses a parameter of a type the contract lacks', () => {
    const dated = JSON.stringify({
      contract: '1',
      contributes: { kinds: { section: [{ kind: 'Option', parameters: { decided: 'date' } }] } },
    })
    expect(reason(dated)).toContain('its manifest does not fit contract 1:')
  })

  it('refuses text that is no JSON', () => {
    expect(reason('{ "contract": "1",')).toBe('its manifest is not JSON')
  })

  it('refuses a manifest written for another contract', () => {
    expect(reason(JSON.stringify({ contract: '2', contributes: {} }))).toBe(
      'it needs contract 2, and this Loom reads contract 1',
    )
  })

  it('refuses a key contract 1 does not know', () => {
    const views = JSON.stringify({
      contract: '1',
      contributes: { kinds: { box: [] }, views: [] },
    })
    expect(reason(views)).toBe(
      'its manifest does not fit contract 1: Expected no excess property at ["contributes"]["views"]',
    )
  })

  it('refuses a kind with no name', () => {
    expect(reason(manifestOf(''))).toContain('its manifest does not fit contract 1:')
  })
})
