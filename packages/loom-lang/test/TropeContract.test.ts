import { describe, expect, it } from 'bun:test'
import { Effect, Layer, Option, Result } from 'effect'
import { defaultAnchorDelims } from '@athrio/loom-ast/LoomTokens'
import type { LoomDocument } from '@athrio/loom-ast/LoomAst'
import { DocumentSource, LoomCompiler } from '../src/LoomCompiler'
import { WorkspaceSettings } from '../src/WorkspaceSettings'
import { LoomDiskCache } from '../src/LoomDiskCache'
import { FileSystemSource } from '../src/WorkspaceSource'
import { readManifest } from '../src/ast/TropeManifest'
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
  it('names the trope beside the identity line', () => {
    const fm = parse(
      lines('---', 'Part I, Chapter 1: Drawing', 'Trope: Mermaid diagrams', '---', '', '# Drawing'),
    ).frontmatter
    expect([fm?.trope?.value, fm?.title?.value, fm?.part?.value, fm?.chapter?.value]).toEqual([
      'Mermaid diagrams',
      'Drawing',
      'I',
      '1',
    ])
  })

  it("reads a member's line apart from a root's", () => {
    const fm = parse(
      lines(
        '---',
        'Part I, Chapter 2: Shapes',
        'Rooted in: Mermaid diagrams',
        '---',
        '',
        '# Shapes',
      ),
    ).frontmatter
    expect([fm?.trope?.value, fm?.rootedIn?.value, fm?.title?.value]).toEqual([
      undefined,
      'Mermaid diagrams',
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
  const outside =
    "Manifest outside a trope: a manifest belongs to a trope's root, a chapter that names its trope with a `Trope:` line, so Loom reads nothing from this section. Name the trope in the frontmatter, or take `{Manifest}` off the heading."

  it("raises nothing in a trope's root", async () => {
    const path = '/corpus/diagrams.loom'
    const root = manifestIn('Part I, Chapter 1: Diagrams', 'Trope: Diagrams')
    expect(await diagnosed({ [path]: root }, path)).not.toContain(outside)
  })

  it('is a fault in a chapter of no trope', async () => {
    const path = '/corpus/diagrams.loom'
    expect(await diagnosed({ [path]: manifestIn('Part I, Chapter 1: Diagrams') }, path)).toContain(
      outside,
    )
  })
})

describe('reading a manifest', () => {
  const reason = (text: string) =>
    Result.match(readManifest(text), { onSuccess: () => '', onFailure: (why) => why })

  it('reads the kinds a fitting manifest declares', () => {
    const read = Result.getOrUndefined(readManifest(manifestOf('Mermaid', 'Run')))
    expect(read?.contributes.kinds.box.map((declared) => declared.kind)).toEqual(['Mermaid', 'Run'])
  })

  it('refuses text that is no JSON', () => {
    expect(reason('{ "contract": "1",')).toBe('its manifest is not JSON')
  })

  it('refuses a manifest written for another contract', () => {
    expect(reason(JSON.stringify({ contract: '2', contributes: {} }))).toBe(
      'it was written for contract 2, and this Loom reads contract 1',
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
