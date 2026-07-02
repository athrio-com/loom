import { describe, expect, it } from '@effect/vitest'
import { Array, Effect, Option } from 'effect'
import { parseDocument, ParseLayer } from './parse'
import { buildProduct } from '#ast/ProductBuilder'
import {
  type Code,
  type Fragment,
  type NameRef,
  type Part,
} from '@athrio/loom-ast/ProductAst'

// ProductBuilder folds a parsed `.loom` document straight into its de re `Product`:
// every section composes to one `Code`, each `::[…]` anchor becomes an edge
// (`NameRef`) or a literal (`Fragment`), and a section whose sink names a file adds
// a `File`. The pass is total — an anchor that resolves to nothing becomes an empty
// `Fragment` carrying error health, never a thrown exception. These probes pin the
// de re each construct produces. Where a probe asserts a diagnostic, it banners the
// health it expects so the logged faults read as asserted, not as run defects.

const productOf = (text: string, path = '/m.loom', lang?: string) =>
  buildProduct(
    Effect.runSync(parseDocument(text).pipe(Effect.provide(ParseLayer))),
    path,
    lang,
  )

const codeNamed = (product: { readonly code: ReadonlyArray<Code> }, name: string) =>
  Array.findFirst(product.code, (c) => c.origin.name === name)

// A fragment is a literal slot; a NameRef is an edge to another section. These two
// narrow a Part to one shape so a probe reads off the field it means to assert.
const fragments = (parts: ReadonlyArray<Part>): ReadonlyArray<Fragment> =>
  Array.filterMap(parts, (p) => (p.type === 'Fragment' ? Option.some(p) : Option.none()))

const refs = (parts: ReadonlyArray<Part>): ReadonlyArray<NameRef> =>
  Array.filterMap(parts, (p) => (p.type === 'NameRef' ? Option.some(p) : Option.none()))

describe('ProductBuilder — a section composes into a Code', () => {
  it('carries the section identity, language, and body text', () => {
    const product = productOf(`---
Language: TypeScript
---

# Adder

Adds two integers.

=>

export const add = (x: number, y: number): number => x + y
`)
    expect(product.files).toEqual([]) // no sink, no file
    const code = Option.getOrThrow(codeNamed(product, 'Adder'))
    expect(code.type).toBe('Code')
    expect(code.origin).toEqual({ path: '/m.loom', name: 'Adder' })
    expect(code.languageId).toBe('typescript')
    // the body composes as plain fragments, the prose dropped
    const text = fragments(code.fragments)
      .map((f) => f.text)
      .join('')
    expect(text).toContain('export const add = (x: number, y: number): number => x + y')
    expect(text).not.toContain('Adds two integers')
  })

  it('inherits the package language when the document declares none', () => {
    const product = productOf(
      `# Bare\n\n=>\n\nconst x = 1\n`,
      '/bare.loom',
      'typescript',
    )
    const code = Option.getOrThrow(codeNamed(product, 'Bare'))
    expect(code.languageId).toBe('typescript')
  })
})

describe('ProductBuilder — a within-file anchor becomes a NameRef', () => {
  it('targets the named section in the same file', () => {
    const product = productOf(`---
Language: TypeScript
---

# Caller

=>

::[Helper]

# Helper

=>

const h = 1
`)
    const caller = Option.getOrThrow(codeNamed(product, 'Caller'))
    const ref = refs(caller.fragments)
    expect(ref).toHaveLength(1)
    expect(ref[0]!.type).toBe('NameRef')
    expect(ref[0]!.health.status).toBe('ok')
    expect(Option.getOrNull(ref[0]!.target)).toEqual({
      path: '/m.loom',
      name: 'Helper',
    })
  })
})

describe('ProductBuilder — an unresolved anchor becomes an empty faulted Fragment', () => {
  it('leaves an empty Fragment carrying UnresolvedAnchor health', () => {
    const product = productOf(`---
Language: TypeScript
---

# Caller

=>

::[Missing]
const c = 1
`)
    const caller = Option.getOrThrow(codeNamed(product, 'Caller'))
    expect(refs(caller.fragments)).toEqual([]) // no edge — nothing to resolve to
    const empty = fragments(caller.fragments).find((f) => f.health.status === 'error')!
    console.log(
      '[expected — not a test failure] unresolved anchor diagnostic:',
      JSON.stringify(empty.health.diagnostics),
    )
    expect(empty.text).toBe('') // an empty fragment stands where the anchor was
    expect(empty.health.diagnostics).toHaveLength(1)
    expect(empty.health.diagnostics[0]!.message).toContain('Unresolved anchor')
    expect(empty.health.diagnostics[0]!.message).toContain('Missing')
  })
})

describe('ProductBuilder — a file sink yields a File', () => {
  it('emits a File at the sink path, its Code also in product.code', () => {
    const product = productOf(`---
Language: TypeScript
---

# Thing [src/ast, Thing.ts]

=>

export const thing = 1
`)
    expect(product.files).toHaveLength(1)
    const file = product.files[0]!
    expect(file.type).toBe('File')
    expect(file.path).toBe('src/ast/Thing.ts')
    expect(file.code.origin.name).toBe('Thing')
    // the same Code is also among the product's code, not only in the File
    const code = Option.getOrThrow(codeNamed(product, 'Thing'))
    expect(code).toStrictEqual(file.code)
  })
})

describe('ProductBuilder — a value warp substitutes its literal', () => {
  it('drops the decoded string in place, quotes stripped, no edge', () => {
    const product = productOf(`---
Language: TypeScript
---

# Keyword

{{ c = "const" }}

=>

::[c] x = 1
`)
    const code = Option.getOrThrow(codeNamed(product, 'Keyword'))
    expect(refs(code.fragments)).toEqual([]) // a literal reaches no section
    const text = fragments(code.fragments)
      .map((f) => f.text)
      .join('')
    expect(text).toBe('const x = 1\n') // `::[c]` became `const`, quotes stripped
  })
})

describe('ProductBuilder — a cross-language anchor marks the NameRef', () => {
  it('keeps the edge but flags CrossLanguageAnchor on its health', () => {
    const product = productOf(`---
Language: TypeScript
---

# Host

=>

::[Data]

# Data {json}

=>

{ "ok": true }
`)
    const host = Option.getOrThrow(codeNamed(product, 'Host'))
    const ref = refs(host.fragments)
    expect(ref).toHaveLength(1)
    // the edge stands — the section is real — but the language crossing is flagged
    expect(Option.getOrNull(ref[0]!.target)).toEqual({ path: '/m.loom', name: 'Data' })
    console.log(
      '[expected — not a test failure] cross-language anchor diagnostic:',
      JSON.stringify(ref[0]!.health.diagnostics),
    )
    expect(ref[0]!.health.status).toBe('error')
    expect(ref[0]!.health.diagnostics[0]!.message).toContain('Cross-language transclusion')
  })
})
