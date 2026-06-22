import { describe, expect, it } from '@effect/vitest'
import { Option } from 'effect'
import { compose, fragment, referName, referTag, tangle, weave } from '@athrio/loom-core'
import type { Position } from '@athrio/loom-core/LoomNode'
import type { SectionId } from '@athrio/loom-core/ProductAst'

// The runnable composition language the generated Frame imports from @athrio/loom-core.
// Its verbs construct the de re ProductAst rather than joining strings: fragment,
// referName, and referTag build the leaves, compose and weave assemble them, and
// tangle binds a composed result to a path as a pure descriptor — no I/O here.

const pos = (offset: number, len: number): Position => ({
  start: { line: 1, column: offset, offset },
  end: { line: 1, column: offset + len, offset: offset + len },
})

const here: SectionId = { path: '/x.loom', name: 'Main' }

describe('fragment', () => {
  it('wraps a literal span with the source origin it maps back to', () => {
    const f = fragment('const x = 1', pos(0, 11))
    expect(f.type).toBe('Fragment')
    expect(f.text).toBe('const x = 1')
    expect(f.origin).toEqual(pos(0, 11))
    expect(f.health.status).toBe('ok')
  })
})

describe('compose', () => {
  it("assembles a section's parts under its identity and language", () => {
    const c = compose(here, 'typescript', fragment('a', pos(0, 1)), fragment('b', pos(1, 1)))
    expect(c.type).toBe('ComposedCode')
    expect(c.origin).toEqual(here)
    expect(c.languageId).toBe('typescript')
    expect(c.parts.map((p) => p.type)).toEqual(['Fragment', 'Fragment'])
  })

  it('composes an empty section, still stamped with identity and language', () => {
    const c = compose(here, 'json')
    expect(c.parts).toEqual([])
    expect(c.origin).toEqual(here)
    expect(c.languageId).toBe('json')
  })
})

describe('referName', () => {
  it('edges to a same-document section by its origin, for shared scope', () => {
    const target: SectionId = { path: '/x.loom', name: 'Helper' }
    const dep = compose(target, 'typescript', fragment('helper', pos(0, 6)))
    const r = referName(dep, pos(10, 5))
    expect(r.type).toBe('NameRef')
    expect(r.anchor).toEqual(pos(10, 5))
    expect(Option.getOrNull(r.target)).toEqual(target)
  })
})

describe('referTag', () => {
  it('edges to a tagged section by its origin, taken by value downstream', () => {
    const target: SectionId = { path: '/dep.loom', name: 'Mul' }
    const dep = compose(target, 'typescript', fragment('mul', pos(0, 3)))
    const r = referTag(dep, pos(10, 5))
    expect(r.type).toBe('TagRef')
    expect(r.anchor).toEqual(pos(10, 5))
    expect(Option.getOrNull(r.target)).toEqual(target)
  })
})

describe('weave', () => {
  it('assembles prose under the section identity, with no language', () => {
    const w = weave(here, fragment('A paragraph.', pos(0, 12)))
    expect(w.type).toBe('WovenProse')
    expect(w.origin).toEqual(here)
    expect(w).not.toHaveProperty('languageId')
    expect(w.parts.map((p) => p.type)).toEqual(['Fragment'])
  })
})

describe('tangle', () => {
  it('binds a composed result to a path as a pure descriptor — no I/O', () => {
    const code = compose(here, 'scala', fragment('object A', pos(0, 8)))
    const file = tangle('out/A.scala', code)
    expect(file.type).toBe('TangledFile')
    expect(file.path).toBe('out/A.scala')
    expect(file.code).toBe(code)
  })
})
