import { describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import { parseDocument, ParseLayer } from './parse'
import { buildFrame } from '#ast/FrameAstBuilder'
import { buildCode, type ModuleInput } from '#ast/ProductAstBuilder'
import { fromFrame, fromProduct } from '#ast/LoomVirtualCodeBuilder'

// LoomVirtualCodeBuilder's two passes, both yielding a LoomVirtualCode.
// fromFrame (de dicto): Frame AST → the `frame` virtual code, the generated
// composition program tsc checks. fromProduct (de re): a section → its product
// virtual code, transclusions inlined across the corpus — every cross-file span
// re-pinned onto the consuming `{{…}}` anchor (per how-lsp), never dangling into
// the dependency.

const parse = (src: string) =>
  Effect.runSync(parseDocument(src).pipe(Effect.provide(ParseLayer)))

// === de dicto — fromFrame =================================================

const adder = `{{lang: TypeScript}}

# Adder [Add]

Adds two integers.

=>

export const add = (x: number, y: number): number => x + y
`

describe('fromFrame — Frame AST → the frame virtual code', () => {
  const vc = fromFrame(buildFrame(parse(adder)))
  const genCode = vc.code
  const mappings = vc.mappings

  it('is the loom `frame` document with no children', () => {
    expect(vc.id).toBe('frame')
    expect(vc.languageId).toBe('loom')
    expect(vc.embeddedCodes).toEqual([])
  })

  it('opens with the #loom/core + effect header', () => {
    expect(genCode.startsWith('import * as core from "#loom/core"')).toBe(true)
    expect(genCode).toContain('import { Effect, Layer } from "effect"')
  })

  it('emits an exported Service class named after the tag', () => {
    expect(genCode).toContain(
      'export class Add extends Effect.Service<Add>()("Add", ',
    )
    expect(genCode).toContain(') {}')
  })

  it('carries title → name, woven prose, and composed code', () => {
    expect(genCode).toContain('name: `Adder`')
    expect(genCode).toContain('prose: core.weave(`')
    expect(genCode).toContain('Adds two integers.')
    expect(genCode).toContain('code: core.compose(`')
    expect(genCode).toContain(
      'export const add = (x: number, y: number): number => x + y',
    )
  })

  it('emits the self-provided composition root', () => {
    expect(genCode).toContain('const layers = Layer.mergeAll(')
    expect(genCode).toContain('Add.Default')
    expect(genCode).toContain('export const LoomMain = Effect.provide(')
    expect(genCode).toContain('Layer.provide(layers, layers)')
  })

  it('maps a generated `Add` name back to the [Add] tag label span', () => {
    const at = genCode.indexOf('export class Add') + 'export class '.length
    const mapping = mappings.find(
      (m) => m.genStart <= at && at < m.genStart + m.genLength,
    )
    expect(mapping?.kind).toBe('name')
    expect(mapping?.source.start.offset).toBe(adder.indexOf('[Add]') + 1)
    expect(
      adder.slice(mapping!.source.start.offset, mapping!.source.end.offset),
    ).toBe('Add')
  })

  it('escapes ` and ${ in the field and product code; TSDoc stays raw', () => {
    const escInput =
      '{{lang: TypeScript}}\n\n# Escapes [Esc]\n\nMentions `pow` in prose.\n\n=>\n\nconst greeting = `Hi ${name}`\n'
    const out = fromFrame(buildFrame(parse(escInput))).code
    expect(out).toContain('\\`pow\\`') // field: escaped backticks
    expect(out).toContain('`pow`') // TSDoc: raw (a comment may contain backticks)
    expect(out).toContain('\\${name}') // product code: escaped ${
  })
})

// === de re (cross-file) — fromProduct =====================================

const sad = `{{lang: TypeScript}}

# Negate [Neg]

=>

const negate = (x: number) => -x
`

const fun = `{{lang: TypeScript}}

# Imports {Loom}

=>

import { Neg } from "./Sad.loom"

# Negated double [Negd]

{{n: Neg}}

=>

{{n}}
const negDouble = (x: number) => negate(x) * 2
`

const sadMod: ModuleInput = {
  path: '/Sad.loom',
  text: sad,
  frame: buildFrame(parse(sad)),
  imports: new Map(),
}
const funMod: ModuleInput = {
  path: '/Fun.loom',
  text: fun,
  frame: buildFrame(parse(fun)),
  imports: new Map([['Neg', '/Sad.loom']]),
}
const codeByPath = new Map([
  ['/Sad.loom', buildCode(sadMod)],
  ['/Fun.loom', buildCode(funMod)],
])

describe('fromProduct — section → product virtual code (cross-file)', () => {
  it('is keyed by the section name lowercased, in its own language', () => {
    const vc = fromProduct(codeByPath, { path: '/Fun.loom', name: 'Negd' })
    expect(vc.id).toBe('negd')
    expect(vc.languageId).toBe('typescript')
    expect(vc.embeddedCodes).toEqual([])
  })

  it('inlines an imported section across files, in composition order', () => {
    const vc = fromProduct(codeByPath, { path: '/Fun.loom', name: 'Negd' })
    expect(vc.code).toContain('const negate = (x: number) => -x') // pulled from Sad
    expect(vc.code).toContain('const negDouble') // Fun's own
    expect(vc.code.indexOf('const negate')).toBeLessThan(
      vc.code.indexOf('const negDouble'),
    )
  })

  it('re-pins every cross-file span onto the consuming file (never into the dep)', () => {
    const vc = fromProduct(codeByPath, { path: '/Fun.loom', name: 'Negd' })
    // negate's *text* is from Sad, but no mapping may point outside Fun's source.
    expect(vc.mappings.every((m) => m.source.end.offset <= fun.length)).toBe(true)
    // the first emitted span (the inlined `negate`) maps to the {{n}} anchor in
    // Fun, not to the library's own code.
    const first = vc.mappings.find((m) => m.genStart === 0)!
    expect(first).toBeDefined()
    const span = fun.slice(first.source.start.offset, first.source.end.offset)
    expect(span).not.toContain('negate')
  })

  it('a same-file leaf maps back to its own origin', () => {
    const vc = fromProduct(codeByPath, { path: '/Sad.loom', name: 'Neg' })
    expect(vc.code).toContain('const negate')
    const m0 = vc.mappings.find((m) => m.genStart === 0)!
    expect(sad.slice(m0.source.start.offset, m0.source.end.offset)).toContain(
      'const negate',
    )
  })
})

// === de re — transclusion's newline rule ==================================

// A sink that stacks two blocks with one blank line between the anchors. The rule:
// each inlined block sheds its own trailing newline, so the sink's `{{x}}⏎⏎{{y}}`
// layout produces exactly one blank line between the blocks — never two — and the
// file ends with a single newline, not a doubled trailing blank.
const two = `{{lang: TypeScript}}

# Alpha [A]

=>

const a = 1

# Beta [B]

=>

const b = 2

# Bundle [Bun]

{{x: A}}
{{y: B}}

=>

{{x}}

{{y}}
`

const twoMod: ModuleInput = {
  path: '/Two.loom',
  text: two,
  frame: buildFrame(parse(two)),
  imports: new Map(),
}
const twoCode = new Map([['/Two.loom', buildCode(twoMod)]])

describe('fromProduct — transclusion sheds the block trailing newline', () => {
  it('one blank line between anchors yields one blank line between blocks', () => {
    const vc = fromProduct(twoCode, { path: '/Two.loom', name: 'Bun' })
    expect(vc.code).toBe('const a = 1\n\nconst b = 2\n')
  })
})

// === de re — prose ⇄ code alternation =====================================

// A section may interleave prose and code: `=> code ~ prose => code`. The prose
// is documentation — dropped from the output — and the `=>` chunks compose with
// exactly one blank line at the seam: the prose break reads as one separator, so
// the chunks are neither butted together nor the prose itself emitted. This also
// guards `codeRuns`' grouping — keying `groupWith` on the wrong weft folds the
// second chunk into the first run, dragging the prose's source span into the code.
const alt = `{{lang: TypeScript}}

# Alternating [Alt]

opening prose

=>

const a = 1

~

narrative between the chunks

=>

const b = 2
`

const altMod: ModuleInput = {
  path: '/Alt.loom',
  text: alt,
  frame: buildFrame(parse(alt)),
  imports: new Map(),
}
const altCode = new Map([['/Alt.loom', buildCode(altMod)]])

describe('fromProduct — prose seam between code chunks', () => {
  it('drops the prose and leaves one blank line between the chunks', () => {
    const vc = fromProduct(altCode, { path: '/Alt.loom', name: 'Alt' })
    expect(vc.code).toBe('const a = 1\n\nconst b = 2\n')
    expect(vc.code).not.toContain('narrative')
  })
})
