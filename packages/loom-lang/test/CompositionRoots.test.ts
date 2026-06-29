import { describe, expect, it } from 'vitest'
import { compose, fragment, referName } from '@athrio/loom-lang/dsl'
import type { Position } from '@athrio/loom-ast/LoomNode'
import type { Code, Part, SectionId } from '@athrio/loom-ast/ProductAst'
import type { LoomModule } from '@athrio/loom-ast/LoomCorpusAst'
import { rootNamesAt } from '../src/ast/LoomVirtualCodeBuilder'

// rootNamesAt decides which sections are composition roots. The rule: a section is
// a root until another section names it. Every reference is a same-file NameRef — a
// `::[…]` name anchor — and it folds its target into the referrer, demoting it to a
// fragment. A section nothing names stays a root. These tests pin that rule.

const pos = (offset: number, len: number): Position => ({
  start: { line: 1, column: offset, offset },
  end: { line: 1, column: offset + len, offset: offset + len },
})

const id = (path: string, name: string): SectionId => ({ path, name })

const section = (
  path: string,
  name: string,
  ...fragments: ReadonlyArray<Part>
): Code => compose(id(path, name), 'typescript', ...fragments)

// rootNamesAt reads a module's de re from `module.product.code`. These fixtures carry
// only that field — the rest of a LoomModule is irrelevant to the root rule — so each
// module is a product over the hand-built sections.
const corpus = (
  ...mods: ReadonlyArray<readonly [string, ReadonlyArray<Code>]>
): ReadonlyMap<string, LoomModule> =>
  new Map(
    mods.map(([path, code]) => [
      path,
      { path, product: { code, files: [] } } as unknown as LoomModule,
    ]),
  )

describe('rootNamesAt — which sections are composition roots', () => {
  it('demotes a same-file target a name anchor names', () => {
    const modules = corpus([
      'a.loom',
      [
        section(
          'a.loom',
          'Main',
          referName({ origin: id('a.loom', 'Helper') }, pos(0, 5)),
        ),
        section('a.loom', 'Helper', fragment('const h = 1', pos(0, 11))),
      ],
    ])
    // Helper folds into Main, so Main is the only root.
    expect(rootNamesAt(modules, 'a.loom')).toEqual(new Set(['main']))
  })

  it('keeps a section nothing names a root of its own', () => {
    const modules = corpus([
      'a.loom',
      [
        section('a.loom', 'Main', fragment('const m = 1', pos(0, 11))),
        section('a.loom', 'Aside', fragment('const a = 2', pos(0, 11))),
      ],
    ])
    // No reference names either, so both stay roots.
    expect(rootNamesAt(modules, 'a.loom')).toEqual(new Set(['main', 'aside']))
  })
})
