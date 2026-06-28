import { describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import { parseDocument, ParseLayer } from './parse'
import { buildFrame } from '#ast/FrameAstBuilder'
import { FrameRunner } from '#ast/FrameRunner'
import { type LoomModule } from '@athrio/loom-ast/LoomCorpusAst'
import { fromFrame, fromProduct } from '#ast/LoomVirtualCodeBuilder'

// LoomVirtualCodeBuilder's two passes, both yielding a LoomVirtualCode.
// fromFrame (de dicto): Frame AST → the `frame` virtual code, the generated
// composition program tsc checks. fromProduct (de re): a section → its product
// virtual code, the sections it names with `::[…]` inlined in composition order,
// each block re-indented to its anchor column.

const parse = (src: string) =>
  Effect.runSync(parseDocument(src).pipe(Effect.provide(ParseLayer)))

// fromProduct resolves against the corpus, so these fixtures run the frames through
// the FrameRunner — the one composition implementation — and fold each module's
// Product back onto it, the same shape the compiler hands the builder.
const corpusOf = (
  ...mods: ReadonlyArray<{ readonly path: string; readonly text: string }>
): ReadonlyMap<string, LoomModule> =>
  Effect.runSync(
    Effect.gen(function* () {
      const runner = yield* FrameRunner
      const built = mods.map((m) => {
        const doc = parse(m.text)
        return {
          path: m.path,
          text: m.text,
          doc,
          frame: buildFrame(doc, m.path),
          imports: [] as ReadonlyArray<string>,
        }
      })
      const frames = new Map(
        built.map((m) => [m.path, fromFrame(m.frame).code] as const),
      )
      const products = yield* runner.produce(frames)
      return new Map(
        built.map(
          (m) => [m.path, { ...m, product: products.get(m.path) }] as const,
        ),
      )
    }).pipe(Effect.provide(FrameRunner.Default)),
  )

// === de dicto — fromFrame =================================================

const adder = `{{lang: TypeScript}}

# Adder

Adds two integers.

=>

export const add = (x: number, y: number): number => x + y
`

describe('fromFrame — Frame AST → the frame virtual code', () => {
  const vc = fromFrame(buildFrame(parse(adder), '/Adder.loom'))
  const genCode = vc.code

  it('is the loom `frame` document with no children', () => {
    expect(vc.id).toBe('frame')
    expect(vc.languageId).toBe('loom')
    expect(vc.embeddedCodes).toEqual([])
  })

  it('opens with the @athrio/loom-lang/dsl + effect header', () => {
    expect(genCode.startsWith('import * as dsl from "@athrio/loom-lang/dsl"')).toBe(true)
    expect(genCode).toContain('import { Effect, Layer } from "effect"')
  })

  it('emits an exported Service class named after the title', () => {
    expect(genCode).toContain(
      'export class Adder extends Effect.Service<Adder>()("/Adder.loom#Adder", ',
    )
    expect(genCode).toContain(') {}')
  })

  it('carries title → name, woven prose, and composed code', () => {
    expect(genCode).toContain('name: `Adder`')
    expect(genCode).toContain('prose: dsl.weave(')
    expect(genCode).toContain('Adds two integers.')
    expect(genCode).toContain('code: dsl.compose(')
    expect(genCode).toContain('dsl.fragment(`') // a fragment is a positioned core call
    expect(genCode).toContain(
      'export const add = (x: number, y: number): number => x + y',
    )
  })

  it('emits the __services and __run exports the runner reads', () => {
    expect(genCode).toContain('export const __services = ')
    expect(genCode).toContain('Adder: { layer: Adder.Default, self: Adder, deps: [] }')
    expect(genCode).toContain('export const __run = Effect.gen(')
    expect(genCode).toContain('(yield* Adder).code')
  })

  it('escapes ` and ${ in the woven prose field and the product code', () => {
    const escInput =
      '{{lang: TypeScript}}\n\n# Escapes\n\nMentions `pow` in prose.\n\n=>\n\nconst greeting = `Hi ${name}`\n'
    const out = fromFrame(buildFrame(parse(escInput), '/Esc.loom')).code
    expect(out).toContain('\\`pow\\`') // field: escaped backticks
    expect(out).toContain('\\${name}') // product code: escaped ${
  })
})

// === de re — fromProduct ==================================================

// One file with a leaf section and a section that names it with `::[Negate]`. The
// de re of the referencing section inlines the leaf's code; the leaf's own de re
// maps back to its origin.
const sad = `{{lang: TypeScript}}

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
const two = `{{lang: TypeScript}}

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
const wrapped = `{{lang: TypeScript}}

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
const python = `{{lang: Python}}

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
const trailing = `{{lang: Python}}

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
const inline = `{{lang: TypeScript}}

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
const alt = `{{lang: TypeScript}}

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
