import { describe, expect, it } from 'vitest'
import { compose, fragment, referName, referTag } from '@athrio/loom-core'
import type { Position } from '@athrio/loom-core/LoomNode'
import type { ComposedCode, Part, SectionId } from '@athrio/loom-core/ProductAst'
import { rootNamesAt, type CodeByPath } from '../src/ast/LoomVirtualCodeBuilder'

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
  ...parts: ReadonlyArray<Part>
): ComposedCode => compose(id(path, name), 'typescript', ...parts)

describe('rootNamesAt — which sections are composition roots', () => {
  it('demotes a same-module target whether a name anchor or a Warp names it', () => {
    const codeByPath: CodeByPath = new Map([
      [
        'a.loom',
        new Map([
          [
            'Main',
            section(
              'a.loom',
              'Main',
              referName({ origin: id('a.loom', 'Helper') }, pos(0, 5)),
              referTag({ origin: id('a.loom', 'Widget') }, pos(10, 5)),
            ),
          ],
          ['Helper', section('a.loom', 'Helper', fragment('const h = 1', pos(0, 11)))],
          ['Widget', section('a.loom', 'Widget', fragment('const w = 2', pos(0, 11)))],
        ]),
      ],
    ])
    // Helper (name anchor) and Widget (same-module Warp) both fold into Main, so Main
    // is the only root.
    expect(rootNamesAt(codeByPath, 'a.loom')).toEqual(new Set(['main']))
  })

  it('leaves a cross-module Warp target a root of its own module', () => {
    const codeByPath: CodeByPath = new Map([
      [
        'a.loom',
        new Map([
          [
            'Main',
            section(
              'a.loom',
              'Main',
              referTag({ origin: id('lib.loom', 'Lib') }, pos(0, 5)),
            ),
          ],
        ]),
      ],
      ['lib.loom', new Map([['Lib', section('lib.loom', 'Lib', fragment('export const l = 3', pos(0, 18)))]])],
    ])
    // Main warps Lib across files, so Main stays a root of a.loom…
    expect(rootNamesAt(codeByPath, 'a.loom')).toEqual(new Set(['main']))
    // …and Lib stays a root of its own module — a library, not absorbed.
    expect(rootNamesAt(codeByPath, 'lib.loom')).toEqual(new Set(['lib']))
  })
})
