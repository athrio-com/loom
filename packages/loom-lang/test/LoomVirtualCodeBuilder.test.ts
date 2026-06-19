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
// re-pinned onto the consuming `::[…]` anchor (per how-lsp), never dangling into
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

  it('maps a generated `Add` name back to the [Add] tag label span, as a `tag` span', () => {
    const at = genCode.indexOf('export class Add') + 'export class '.length
    const mapping = mappings.find(
      (m) => m.genStart <= at && at < m.genStart + m.genLength,
    )
    // `tag`, not `name`: the span navigates and renames but withholds hover, so
    // the generated service class never shows when hovering the [Add] tag
    expect(mapping?.kind).toBe('tag')
    expect(mapping?.source.start.offset).toBe(adder.indexOf('[Add]') + 1)
    expect(
      adder.slice(mapping!.source.start.offset, mapping!.source.end.offset),
    ).toBe('Add')
  })

  it('escapes ` and ${ in the woven prose field and the product code', () => {
    const escInput =
      '{{lang: TypeScript}}\n\n# Escapes [Esc]\n\nMentions `pow` in prose.\n\n=>\n\nconst greeting = `Hi ${name}`\n'
    const out = fromFrame(buildFrame(parse(escInput))).code
    expect(out).toContain('\\`pow\\`') // field: escaped backticks
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

::[n]
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
    // the first emitted span (the inlined `negate`) maps to the ::[n] anchor in
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
// each inlined block sheds its own trailing newline, so the sink's `::[x]⏎⏎::[y]`
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

::[x]

::[y]
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

// === de re — anchor indentation ===========================================

// An anchor carries its own indentation into what it pulls in: an indented
// `::[…]` indents every line of the transcluded block, not just the first
// (noweb/org-babel behaviour). The inserted indent is synthetic — it has no
// `.loom` origin — so no mapping may claim it, and an offset-aligned span still
// re-derives its source per line.
const wrapped = `{{lang: TypeScript}}

# Body [Bod]

=>

const x = 1
const y = 2

# Wrap [Wr]

{{b: Bod}}

=>

function wrap() {
  ::[b]
}
`

const wrappedMod: ModuleInput = {
  path: '/Wrapped.loom',
  text: wrapped,
  frame: buildFrame(parse(wrapped)),
  imports: new Map(),
}
const wrappedCode = new Map([['/Wrapped.loom', buildCode(wrappedMod)]])

describe('fromProduct — an indented anchor indents the whole block', () => {
  const vc = fromProduct(wrappedCode, { path: '/Wrapped.loom', name: 'Wr' })

  it('indents every continuation line to the anchor column', () => {
    expect(vc.code).toBe(
      'function wrap() {\n  const x = 1\n  const y = 2\n}\n',
    )
  })

  it('leaves the injected indent unmapped', () => {
    const indentAt = vc.code.indexOf('\n  const y') + 1
    const covers = vc.mappings.some(
      (m) => m.genStart <= indentAt && indentAt < m.genStart + m.genLength,
    )
    expect(covers).toBe(false)
  })

  it('keeps every offset-aligned mapping a 1:1 match to its source text', () => {
    const misaligned = vc.mappings.filter((m) => {
      const sourceLen = m.source.end.offset - m.source.start.offset
      return (
        sourceLen === m.genLength &&
        vc.code.slice(m.genStart, m.genStart + m.genLength) !==
          wrapped.slice(m.source.start.offset, m.source.end.offset)
      )
    })
    expect(misaligned).toEqual([])
  })
})

// Indentation must stack through nested anchors — the case that matters for
// indentation-sensitive languages like Python and Scala 3, where a block at the
// wrong depth is broken code, not just ugly. Leaf is transcluded into Inner under
// an `if`, and Inner into Outer under a `def`, so Leaf's lines must land two
// levels deep. A blank line inside a block stays empty, carrying no indent.
const python = `{{lang: Python}}

# Leaf [Leaf]

=>

total += n

log(total)

# Inner [Inner]

{{leaf: Leaf}}

=>

if n > 0:
    ::[leaf]

# Outer [Outer]

{{inner: Inner}}

=>

def run(n):
    ::[inner]
    return total
`

const pythonCode = new Map([
  [
    '/Python.loom',
    buildCode({
      path: '/Python.loom',
      text: python,
      frame: buildFrame(parse(python)),
      imports: new Map(),
    }),
  ],
])

describe('fromProduct — indentation stacks through nested anchors', () => {
  it('lands each block at its full nested depth, blank lines empty', () => {
    const vc = fromProduct(pythonCode, { path: '/Python.loom', name: 'Outer' })
    expect(vc.code).toBe(
      'def run(n):\n' +
        '    if n > 0:\n' +
        '        total += n\n' +
        '\n' +
        '        log(total)\n' +
        '    return total\n',
    )
  })
})

// Trailing whitespace after the anchor is the spacebar an author taps by habit.
// It must not disqualify the anchor, and it must not survive into the output: the
// block still indents, and no line is left with stray trailing spaces.
const trailing = `{{lang: Python}}

# Body [Bod]

=>

a = 1
b = 2

# Wrap [Wr]

{{b: Bod}}

=>

def f():
    ::[b]${'   '}
    return a
`

const trailingCode = new Map([
  [
    '/Trailing.loom',
    buildCode({
      path: '/Trailing.loom',
      text: trailing,
      frame: buildFrame(parse(trailing)),
      imports: new Map(),
    }),
  ],
])

describe('fromProduct — trailing spaces after an anchor still indent, then vanish', () => {
  it('indents the block and leaves no stray trailing whitespace', () => {
    const vc = fromProduct(trailingCode, { path: '/Trailing.loom', name: 'Wr' })
    expect(vc.code).toBe('def f():\n    a = 1\n    b = 2\n    return a\n')
  })
})

// Indentation activates only when the anchor owns its line. An anchor with code
// before it (`result = ::[block]`) or after it (`::[block] more`) is inline: its
// block is pulled in as written, continuation lines left at column zero — never
// silently re-indented, which for a free-form language would corrupt the output.
const inline = `{{lang: TypeScript}}

# Pair [Pair]

=>

a = 1
b = 2

# Before [Before]

{{p: Pair}}

=>

  const x = ::[p]

# After [After]

{{p: Pair}}

=>

  ::[p] + tail
`

const inlineCode = new Map([
  [
    '/Inline.loom',
    buildCode({
      path: '/Inline.loom',
      text: inline,
      frame: buildFrame(parse(inline)),
      imports: new Map(),
    }),
  ],
])

describe('fromProduct — an anchor with code beside it stays inline', () => {
  it('does not re-indent when code precedes the anchor', () => {
    const vc = fromProduct(inlineCode, { path: '/Inline.loom', name: 'Before' })
    expect(vc.code).toBe('  const x = a = 1\nb = 2\n')
  })

  it('does not re-indent when code follows the anchor', () => {
    const vc = fromProduct(inlineCode, { path: '/Inline.loom', name: 'After' })
    expect(vc.code).toBe('  a = 1\nb = 2 + tail\n')
  })
})

// A cross-file block indented at its anchor: every line indents, and every span
// still re-pins onto the consuming file rather than dangling into the dependency.
const libDep = `{{lang: TypeScript}}

# Lib [Lib]

=>

const p = 1
const q = 2
`
const libHost = `{{lang: TypeScript}}

# Imports {Loom}

=>

import { Lib } from "./Dep.loom"

# Host [Host]

{{l: Lib}}

=>

class C {
    ::[l]
}
`

const libCode = new Map([
  [
    '/Dep.loom',
    buildCode({
      path: '/Dep.loom',
      text: libDep,
      frame: buildFrame(parse(libDep)),
      imports: new Map(),
    }),
  ],
  [
    '/Host.loom',
    buildCode({
      path: '/Host.loom',
      text: libHost,
      frame: buildFrame(parse(libHost)),
      imports: new Map([['Lib', '/Dep.loom']]),
    }),
  ],
])

describe('fromProduct — an indented cross-file anchor indents the block', () => {
  const vc = fromProduct(libCode, { path: '/Host.loom', name: 'Host' })

  it('indents every continuation line of the inlined dependency', () => {
    expect(vc.code).toBe('class C {\n    const p = 1\n    const q = 2\n}\n')
  })

  it('still re-pins every cross-file span onto the consuming file', () => {
    expect(vc.mappings.every((m) => m.source.end.offset <= libHost.length)).toBe(
      true,
    )
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
