import { describe, expect, it } from '@effect/vitest'
import { Array, Effect, pipe } from 'effect'
import { parseDocument, ParseLayer } from './parse'
import { buildProduct } from '#ast/ProductBuilder'
import { type LoomModule, type Path } from '@athrio/loom-ast/LoomCorpusAst'
import {
  fromProduct,
  fromProse,
  rootNamesAt,
  rootVirtualCode,
  symbolMappings,
} from '#ast/LoomVirtualCodeBuilder'

// LoomVirtualCodeBuilder's de re projection, all yielding a LoomVirtualCode.
// fromProduct: a section → its product virtual code, the sections it names with
// `::[…]` inlined in composition order, each block re-indented to its anchor
// column. fromProse: the file as a Markdown document, code blanked to spaces.
// symbolMappings: one span per symbol the document declares, the spans the root
// mirror routes navigation and colour through. rootVirtualCode: the file's tree,
// the source as the loom root.

const parse = (src: string) =>
  Effect.runSync(parseDocument(src).pipe(Effect.provide(ParseLayer)))

// fromProduct resolves a NameRef's target against the corpus, so each fixture is a
// corpus of modules built straight from `.loom` source: parse, then fold the
// document into its de re `Product` with `buildProduct`. This is the same module
// shape the compiler hands the builder — `{ path, text, doc, product }`.
const moduleOf = (path: Path, text: string): LoomModule => {
  const doc = parse(text)
  return { path, text, doc, product: buildProduct(doc, path) }
}

const corpusOf = (
  ...mods: ReadonlyArray<{ readonly path: Path; readonly text: string }>
): ReadonlyMap<Path, LoomModule> =>
  new Map(mods.map((m) => [m.path, moduleOf(m.path, m.text)] as const))

// === de re — fromProduct ==================================================

// One file with a leaf section and a section that names it with `::[Negate]`. The
// de re of the referencing section inlines the leaf's code; the leaf's own de re
// maps back to its origin.
const sad = `---
Language: TypeScript
---

# Negate

=>

const negate = (x: number) => -x

# Negated double

=>

::[Negate]
const negDouble = (x: number) => negate(x) * 2
`

const codeByPath = corpusOf({ path: '/Sad.loom', text: sad })

describe('fromProduct — section → product virtual code', () => {
  it('is keyed by the section name lowercased, in its own language', () => {
    const vc = fromProduct(codeByPath, { path: '/Sad.loom', name: 'NegatedDouble' })
    expect(vc.id).toBe('negateddouble')
    expect(vc.languageId).toBe('typescript')
    expect(vc.embeddedCodes).toEqual([])
  })

  it('inlines the referenced section in composition order', () => {
    const vc = fromProduct(codeByPath, { path: '/Sad.loom', name: 'NegatedDouble' })
    expect(vc.code).toContain('const negate = (x: number) => -x') // pulled from Negate
    expect(vc.code).toContain('const negDouble') // the section's own
    expect(vc.code.indexOf('const negate')).toBeLessThan(
      vc.code.indexOf('const negDouble'),
    )
  })

  it('a leaf maps back to its own origin', () => {
    const vc = fromProduct(codeByPath, { path: '/Sad.loom', name: 'Negate' })
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
const two = `---
Language: TypeScript
---

# Alpha

=>

const a = 1

# Beta

=>

const b = 2

# Bundle

=>

::[Alpha]

::[Beta]
`

const twoCode = corpusOf({ path: '/Two.loom', text: two })

describe('fromProduct — transclusion sheds the block trailing newline', () => {
  it('one blank line between anchors yields one blank line between blocks', () => {
    const vc = fromProduct(twoCode, { path: '/Two.loom', name: 'Bundle' })
    expect(vc.code).toBe('const a = 1\n\nconst b = 2\n')
  })
})

// === de re — anchor indentation ===========================================

// An anchor carries its own indentation into what it pulls in: an indented
// `::[…]` indents every line of the transcluded block, not just the first
// (noweb/org-babel behaviour). The inserted indent is synthetic — it has no
// `.loom` origin — so no mapping may claim it, and an offset-aligned span still
// re-derives its source per line.
const wrapped = `---
Language: TypeScript
---

# Body

=>

const x = 1
const y = 2

# Wrap

=>

function wrap() {
  ::[Body]
}
`

const wrappedCode = corpusOf({ path: '/Wrapped.loom', text: wrapped })

describe('fromProduct — an indented anchor indents the whole block', () => {
  const vc = fromProduct(wrappedCode, { path: '/Wrapped.loom', name: 'Wrap' })

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
const python = `---
Language: Python
---

# Leaf

=>

total += n

log(total)

# Inner

=>

if n > 0:
    ::[Leaf]

# Outer

=>

def run(n):
    ::[Inner]
    return total
`

const pythonCode = corpusOf({ path: '/Python.loom', text: python })

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
const trailing = `---
Language: Python
---

# Body

=>

a = 1
b = 2

# Wrap

=>

def f():
    ::[Body]${'   '}
    return a
`

const trailingCode = corpusOf({ path: '/Trailing.loom', text: trailing })

describe('fromProduct — trailing spaces after an anchor still indent, then vanish', () => {
  it('indents the block and leaves no stray trailing whitespace', () => {
    const vc = fromProduct(trailingCode, { path: '/Trailing.loom', name: 'Wrap' })
    expect(vc.code).toBe('def f():\n    a = 1\n    b = 2\n    return a\n')
  })
})

// Indentation activates only when the anchor owns its line. An anchor with code
// before it (`result = ::[block]`) or after it (`::[block] more`) is inline: its
// block is pulled in as written, continuation lines left at column zero — never
// silently re-indented, which for a free-form language would corrupt the output.
const inline = `---
Language: TypeScript
---

# Pair

=>

a = 1
b = 2

# Before

=>

  const x = ::[Pair]

# After

=>

  ::[Pair] + tail
`

const inlineCode = corpusOf({ path: '/Inline.loom', text: inline })

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

// === de re — prose ⇄ code alternation =====================================

// A section may interleave prose and code: `=> code ~ prose => code`. The prose
// is documentation — dropped from the output — and the `=>` chunks compose with
// exactly one blank line at the seam: the prose break reads as one separator, so
// the chunks are neither butted together nor the prose itself emitted. This also
// guards `codeRuns`' grouping — keying `groupWith` on the wrong weft folds the
// second chunk into the first run, dragging the prose's source span into the code.
const alt = `---
Language: TypeScript
---

# Alternating

opening prose

=>

const a = 1

~

narrative between the chunks

=>

const b = 2
`

const altCode = corpusOf({ path: '/Alt.loom', text: alt })

describe('fromProduct — prose seam between code chunks', () => {
  it('drops the prose and leaves one blank line between the chunks', () => {
    const vc = fromProduct(altCode, { path: '/Alt.loom', name: 'Alternating' })
    expect(vc.code).toBe('const a = 1\n\nconst b = 2\n')
    expect(vc.code).not.toContain('narrative')
  })
})

// === fromProse — the file as Markdown =====================================

// fromProse keeps the prose and blanks every code chunk to spaces, so only the
// narrative reads while every offset stays where the source put it. The result is
// one `prose` document in the `prose` language, mapped per token to its own span.
describe('fromProse — code blanked, prose kept, offsets preserved', () => {
  it('keeps prose, blanks the code, and holds the source length', () => {
    const vc = fromProse(codeByPath, '/Sad.loom')
    expect(vc.id).toBe('prose')
    expect(vc.languageId).toBe('prose')
    expect(vc.code.length).toBe(sad.length) // offsets preserved one-to-one
    expect(vc.code).not.toContain('const negate') // code blanked to spaces
    expect(vc.code).not.toContain('negDouble')
    expect(vc.mappings.length).toBeGreaterThan(0)
  })

  it('an absent file yields an empty prose document', () => {
    const vc = fromProse(codeByPath, '/Absent.loom')
    expect(vc.id).toBe('prose')
    expect(vc.languageId).toBe('prose')
    expect(vc.code).toBe('')
  })
})

// === symbolMappings — a span per declared symbol ==========================

// symbolMappings routes Loom's navigation and colour through the root mirror: one
// span per symbol the document declares, each carrying its kind. A section title is
// a `headingTitle`; a `::[Negate]` reference naming a section is a `sectionAnchor`.
// Each span covers the token's name — `Negate`, not `::[Negate]` — the same range
// rename edits, and maps to the source verbatim, so its genStart and source offsets
// agree.
describe('symbolMappings — the spans navigation routes through', () => {
  const doc = parse(sad)
  const symbols = symbolMappings(doc)

  it('spans each section title as a headingTitle', () => {
    const headings = Array.filter(symbols, (m) => m.kind === 'headingTitle')
    const titles = Array.map(headings, (m) =>
      sad.slice(m.source.start.offset, m.source.end.offset),
    )
    expect(titles).toEqual(['Negate', 'Negated double'])
  })

  it('spans the `::[Negate]` reference name as a sectionAnchor', () => {
    const anchors = Array.filter(symbols, (m) => m.kind === 'sectionAnchor')
    const named = Array.map(anchors, (m) =>
      sad.slice(m.source.start.offset, m.source.end.offset),
    )
    expect(named).toEqual(['Negate'])
  })

  it('maps every span to its own source verbatim', () => {
    const offByGen = Array.filter(symbols, (m) => m.genStart !== m.source.start.offset)
    expect(offByGen).toEqual([])
  })
})

// === rootVirtualCode — the file's tree ====================================

// rootVirtualCode assembles the file's tree: the source itself as the `loom` root,
// the prose and product documents its children. The root carries a whole-file
// `source` span, so Loom's own diagnostics reach the editor on the opened file, and
// the section-symbol spans beside it, so navigation reaches each heading and anchor.
describe('rootVirtualCode — the source as the loom root', () => {
  it('roots the source, holds the symbol spans, and nests its children', () => {
    const roots = rootNamesAt(codeByPath, '/Sad.loom')
    const children = pipe(
      Array.fromIterable(roots),
      Array.map((name) =>
        fromProduct(codeByPath, { path: '/Sad.loom', name }),
      ),
    )
    const doc = parse(sad)
    const root = rootVirtualCode(sad, children, symbolMappings(doc))

    expect(root.id).toBe('root')
    expect(root.languageId).toBe('loom')
    expect(root.code).toBe(sad) // the source verbatim
    expect(root.embeddedCodes).toBe(children)

    // a whole-file `source` span the editor verifies diagnostics against
    const whole = root.mappings.find((m) => m.kind === 'source')!
    expect(whole.genStart).toBe(0)
    expect(whole.genLength).toBe(sad.length)

    // the heading and anchor spans ride alongside it
    expect(root.mappings.some((m) => m.kind === 'headingTitle')).toBe(true)
    expect(root.mappings.some((m) => m.kind === 'sectionAnchor')).toBe(true)
  })
})
