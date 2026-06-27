import { describe, expect, it } from 'vitest'
import { compose, fragment, referName, referTag } from '@athrio/loom-lang/dsl'
import type { Position } from '@athrio/loom-ast/LoomNode'
import type { Code, Part, SectionId } from '@athrio/loom-ast/ProductAst'
import type { LoomModule } from '@athrio/loom-ast/LoomCorpusAst'
import { rootNamesAt } from '../src/ast/LoomVirtualCodeBuilder'

// rootNamesAt decides which sections are composition roots. The rule: a section is
// a root until another section in the *same* module folds it in — and both kinds of
// reference fold. A NameRef (a `::[…]` name anchor) and a same-module TagRef (a Warp
// to a same-file tag) each demote their target to a fragment. Only a *cross-module*
// TagRef leaves its target standing: that section is a library its own module still
// roots. These tests pin that rule, the TagRef half especially, since a same-module
// Warp once kept its target a root of its own.

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
  it('demotes a same-module target whether a name anchor or a Warp names it', () => {
    const modules = corpus([
      'a.loom',
      [
        section(
          'a.loom',
          'Main',
          referName({ origin: id('a.loom', 'Helper') }, pos(0, 5)),
          referTag({ origin: id('a.loom', 'Widget') }, pos(10, 5)),
        ),
        section('a.loom', 'Helper', fragment('const h = 1', pos(0, 11))),
        section('a.loom', 'Widget', fragment('const w = 2', pos(0, 11))),
      ],
    ])
    // Helper (name anchor) and Widget (same-module Warp) both fold into Main, so Main
    // is the only root.
    expect(rootNamesAt(modules, 'a.loom')).toEqual(new Set(['main']))
  })

  it('leaves a cross-module Warp target a root of its own module', () => {
    const modules = corpus(
      [
        'a.loom',
        [
          section(
            'a.loom',
            'Main',
            referTag({ origin: id('lib.loom', 'Lib') }, pos(0, 5)),
          ),
        ],
      ],
      [
        'lib.loom',
        [section('lib.loom', 'Lib', fragment('export const l = 3', pos(0, 18)))],
      ],
    )
    // Main warps Lib across files, so Main stays a root of a.loom…
    expect(rootNamesAt(modules, 'a.loom')).toEqual(new Set(['main']))
    // …and Lib stays a root of its own module — a library, not absorbed.
    expect(rootNamesAt(modules, 'lib.loom')).toEqual(new Set(['lib']))
  })
})
