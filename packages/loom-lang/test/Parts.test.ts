import { describe, expect, it as it_ } from 'bun:test'
import { effectify } from '@athrio/effect-test'
import { Effect, Layer, Option } from 'effect'
import { DocumentSource, LoomCompiler } from '../src/LoomCompiler'
import { LoomMemo } from '../src/LoomMemo'
import { WorkspaceSettings } from '../src/WorkspaceSettings'
import { LoomDiskCache } from '../src/LoomDiskCache'
import { FileSystemSource } from '../src/WorkspaceSource'
import { defaultAnchorDelims } from '@athrio/loom-ast/LoomTokens'

const it = effectify(it_)

const lines = (...rows: ReadonlyArray<string>): string => `${rows.join('\n')}\n`

const makeCompilerLayer = (files: Record<string, string>) =>
  Layer.provide(
    Layer.merge(LoomCompiler.layer, LoomMemo.layer),
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
            primaryLanguage: undefined,
            variables: {},
            width: 100,
          }),
      }),
    ),
  )

const opener = lines(
  '---',
  'Part I: Using Loom',
  'Chapter 1: A first loom',
  'Language: Prose',
  '---',
  '',
  '# A first loom',
  '',
  'The opening chapter.',
)

const workspace = lines(
  '---',
  'Part I, Chapter 2: A workspace',
  'Language: Prose',
  '---',
  '',
  '# A workspace',
  '',
  'The second chapter.',
)

const partCorpus: Record<string, string> = {
  '/opener.loom': opener,
  '/workspace.loom': workspace,
}

const partLayer = makeCompilerLayer(partCorpus)

describe('parts navigate to where they are announced', () => {
  it.effect("a chapter's `Part I` goes to the opening frontmatter", () =>
    Effect.gen(function* () {
      const c = yield* LoomCompiler
      const offset = workspace.indexOf('Part I,') + 2
      const target = yield* c.definition('/workspace.loom', offset)
      expect(target?.path).toBe('/opener.loom')
      expect(target?.range.start.line).toBe(1)
    }).pipe(Effect.provide(partLayer)),
  )

  it.effect('references gather the announcement and the parts', () =>
    Effect.gen(function* () {
      const c = yield* LoomCompiler
      const offset = opener.indexOf('Using Loom') + 2
      const refs = yield* c.references('/opener.loom', offset)
      const has = (path: string, line: number) =>
        refs.some((r) => r.path === path && r.range.start.line === line)
      expect(has('/opener.loom', 1)).toBe(true)
      expect(has('/workspace.loom', 1)).toBe(true)
    }).pipe(Effect.provide(partLayer)),
  )

  it.effect('a part underlines its whole name but offers no rename', () =>
    Effect.gen(function* () {
      const c = yield* LoomCompiler
      const offset = opener.indexOf('Using Loom') + 2
      const nav = yield* c.navigationRange('/opener.loom', offset)
      const ren = yield* c.renameRange('/opener.loom', offset)
      const width = (nav?.range.end.character ?? 0) - (nav?.range.start.character ?? 0)
      expect(nav).not.toBeUndefined()
      expect(width).toBe('Using Loom'.length)
      expect(ren).toBeUndefined()
    }).pipe(Effect.provide(partLayer)),
  )
})
