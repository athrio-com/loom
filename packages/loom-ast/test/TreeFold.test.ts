import { describe, expect, it } from 'bun:test'
import { rewritten } from '#ast/TreeFold'

type Leaf = { readonly type: 'Leaf'; readonly name: string }

type GrownLeaf = { readonly type: 'Leaf'; readonly name: string; readonly grown: true }

type Branch<Held> = {
  readonly type: 'Branch'
  readonly leaves: ReadonlyArray<Held>
  readonly first?: Held
  readonly at: { readonly line: number }
}

type Root<Held, Limb> = {
  readonly type: 'Root'
  readonly label: string
  readonly loose: Held
  readonly branches: ReadonlyArray<Limb>
}

const leaf = (name: string): Leaf => ({ type: 'Leaf', name })

const grown = (found: Leaf): GrownLeaf => ({ ...found, grown: true })

const bare: Branch<Leaf> = { type: 'Branch', leaves: [], at: { line: 2 } }

const leafy: Branch<Leaf> = {
  type: 'Branch',
  leaves: [leaf('oak'), leaf('ash')],
  first: leaf('elm'),
  at: { line: 1 },
}

const root: Root<Leaf, Branch<Leaf>> = {
  type: 'Root',
  label: 'a small tree',
  loose: leaf('fig'),
  branches: [leafy, bare],
}

describe('a case', () => {
  it('rewrites its nodes wherever they stand', () => {
    const written: Root<GrownLeaf, Branch<GrownLeaf>> = rewritten(root, { Leaf: grown })
    expect(written.loose).toEqual({ type: 'Leaf', name: 'fig', grown: true })
    expect(written.branches[0]?.leaves).toEqual([
      { type: 'Leaf', name: 'oak', grown: true },
      { type: 'Leaf', name: 'ash', grown: true },
    ])
    expect(written.branches[0]?.first).toEqual({ type: 'Leaf', name: 'elm', grown: true })
  })

  it('leaves every other field as it was', () => {
    const written = rewritten(root, { Leaf: grown })
    expect(written.label).toBe('a small tree')
    expect(written.branches[0]?.at).toEqual({ line: 1 })
  })
})

describe('what a pass leaves alone', () => {
  it('is the same tree, when no node has a case', () => {
    const felled = (twig: never): { readonly type: 'Twig' } => twig
    expect(rewritten(root, { Twig: felled })).toBe(root)
  })

  it('is the same object, beside a node that changed', () => {
    const written = rewritten(root, { Leaf: grown })
    expect<unknown>(written.branches[1]).toBe(bare)
    expect<unknown>(written.branches[0]).not.toBe(leafy)
    expect(written.branches[0]?.at).toBe(leafy.at)
  })
})

describe('what a case returns', () => {
  it('is not walked again', () => {
    const kept = (branch: Branch<Leaf>): Branch<Leaf> => branch
    const written = rewritten(root, { Branch: kept, Leaf: grown })
    expect(written.loose).toEqual({ type: 'Leaf', name: 'fig', grown: true })
    expect(written.branches[0]?.leaves).toEqual([leaf('oak'), leaf('ash')])
  })
})

describe('a plain value', () => {
  it('hides the nodes it holds', () => {
    const wrapped = { type: 'Root' as const, held: { leaf: leaf('yew') } }
    const written = rewritten(wrapped, { Leaf: grown })
    expect(written).toBe(wrapped)
  })

  it('never meets an inherited name', () => {
    const odd = { type: 'Root' as const, items: [{ type: 'constructor' as const }] }
    expect(rewritten(odd, { Leaf: grown })).toBe(odd)
  })
})
