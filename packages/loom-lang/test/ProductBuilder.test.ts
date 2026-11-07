import { describe, expect, it as it_ } from 'bun:test'
import { effectify } from '@athrio/effect-test'
const it = effectify(it_)
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

const productOf = (
  text: string,
  path = '/m.loom',
  lang?: string,
  variables: Record<string, string> = {},
) =>
  buildProduct(
    Effect.runSync(parseDocument(text).pipe(Effect.provide(ParseLayer))),
    path,
    lang,
    variables,
  )

// A literal `${name}` for a fixture, built so the test file's own template
// literals never interpolate it as JavaScript.
const varRef = (name: string) => '${' + name + '}'

const codeNamed = (product: { readonly code: ReadonlyArray<Code> }, name: string) =>
  Array.findFirst(product.code, (c) => c.origin.name === name)

// A fragment is a literal slot; a NameRef is an edge to another section. These two
// narrow a Part to one shape so a probe reads off the field it means to assert.
const fragments = (parts: ReadonlyArray<Part>): ReadonlyArray<Fragment> =>
  Array.filter(parts, (p): p is Fragment => p.type === 'Fragment')

const refs = (parts: ReadonlyArray<Part>): ReadonlyArray<NameRef> =>
  Array.filter(parts, (p): p is NameRef => p.type === 'NameRef')

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

describe('ProductBuilder — fenced code', () => {
  const script = (label: string) =>
    [
      '# Install [install.sh]',
      '',
      '=>',
      '```' + label,
      '#!/bin/sh',
      '# Installs the thing.',
      'echo done',
      '```',
      '',
      'The script ends here.',
      '',
    ].join('\n')

  it('composes the lines between the fences, its `#` lines included, and no fence', () => {
    const code = Option.getOrThrow(codeNamed(productOf(script('sh')), 'Install'))
    const text = fragments(code.fragments)
      .map((f) => f.text)
      .join('')
    expect(text).toBe('#!/bin/sh\n# Installs the thing.\necho done\n')
    expect(code.health.status).toBe('ok')
  })

  it('accepts a label that names the language by an extension or by its name', () => {
    const ts = (label: string) =>
      Option.getOrThrow(
        codeNamed(productOf(`# M [m.ts]\n\n=>\n\`\`\`${label}\nconst m = 1\n\`\`\`\n`), 'M'),
      )
    expect(ts('ts').health.status).toBe('ok')
    expect(ts('typescript').health.status).toBe('ok')
  })

  it('needs no label at all', () => {
    const code = Option.getOrThrow(codeNamed(productOf(script('')), 'Install'))
    expect(code.health.status).toBe('ok')
    const text = fragments(code.fragments)
      .map((f) => f.text)
      .join('')
    expect(text).toBe('#!/bin/sh\n# Installs the thing.\necho done\n')
  })

  it('holds a label to the heading specifier, over the chapter language', () => {
    const run = (label: string) =>
      Option.getOrThrow(
        codeNamed(
          productOf(
            `---\nLanguage: TypeScript\n---\n\n# Run {Bash}\n\n=>\n\`\`\`${label}\necho hi\n\`\`\`\n`,
          ),
          'Run',
        ),
      )
    expect(run('bash').health.status).toBe('ok')
    console.log('[expected — not a test failure] a ts label on a {Bash} section in a TypeScript chapter')
    expect(run('ts').health.status).toBe('error')
  })

  it('faults a label that names another language, on the label', () => {
    console.log('[expected — not a test failure] a fence labelled python on a shell section')
    const code = Option.getOrThrow(codeNamed(productOf(script('python')), 'Install'))
    expect(code.health.status).toBe('error')
    const [fault] = code.health.diagnostics
    expect(fault?.message).toStartWith('This fence is labelled')
    expect(fault?.position.start.line).toBe(4)
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

// An anchor finds its section by name, through the book, so the pass reads no loom's
// path in an anchor. One that still writes a target composes nothing: its empty
// fragment carries the RetiredTarget fault on the target, with a fix that removes it.
describe('ProductBuilder — an anchor with a target is retired', () => {
  it('composes nothing and faults the target, offering to remove it', () => {
    const text = `# The program [hello.ts]

=>
::[Saying hello](../lib/greeting.loom)
console.log(greet('world'))
`
    const product = productOf(text, '/corpus/app/hello.loom', 'typescript')
    const program = Option.getOrThrow(codeNamed(product, 'TheProgram'))
    expect(refs(program.fragments)).toHaveLength(0)
    const [diagnostic] = program.fragments.flatMap((part) => part.health.diagnostics)
    const at = diagnostic!.position
    expect(text.slice(at.start.offset, at.end.offset)).toBe('(../lib/greeting.loom)')
    expect(diagnostic!.severity).toBe('error')
    expect(diagnostic!.fixes).toEqual([{ title: 'Remove `(../lib/greeting.loom)`', text: '', at }])
  })
})

describe('ProductBuilder — a name its document lacks becomes an open edge', () => {
  it('records the name, leaves the target open, and raises no fault here', () => {
    const product = productOf(`---
Language: TypeScript
---

# Caller

=>

::[Missing]
const c = 1
`)
    const caller = Option.getOrThrow(codeNamed(product, 'Caller'))
    const [open] = refs(caller.fragments)
    expect(open!.name).toBe('Missing')
    expect(Option.isNone(open!.target)).toBe(true)
    expect(open!.health.status).toBe('ok') // the compiler judges it against the corpus
    expect(fragments(caller.fragments).every((f) => f.health.status === 'ok')).toBe(true)
  })
})

describe('ProductBuilder — a file sink yields a File', () => {
  it('emits a File at the sink path, its Code also in product.code', () => {
    const product = productOf(`---
Language: TypeScript
Package: src/ast/
---

# Thing [Thing.ts]

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

describe('ProductBuilder — a bare sink tangles without a {Tangle} specifier', () => {
  it('emits a File from a heading sink alone, under the package', () => {
    const product = productOf(`---
Package: src/
---

# Greeting [greet.ts]

We greet the world.

=>

export const greeting = 'Hello!'
`)
    expect(product.files).toHaveLength(1)
    const file = product.files[0]!
    expect(file.path).toBe('src/greet.ts')
    expect(file.code.origin.name).toBe('Greeting')
    expect(file.code.languageId).toBe('typescript') // read from the .ts extension
  })

  it('names the file by the sink alone when no frontmatter package', () => {
    const product = productOf(`# Hi there! [mini.ts]

The simplest Loom program.

=>

console.log('Hi there!')
`)
    expect(product.files).toHaveLength(1)
    expect(product.files[0]!.path).toBe('mini.ts')
    expect(product.files[0]!.code.languageId).toBe('typescript')
  })

  it('leaves a language-specified section untangled', () => {
    const product = productOf(`---
Package: src/
---

# Data {json} [data.json]

=>

{ "x": 1 }
`)
    expect(product.files).toEqual([]) // a language label composes in place, no File
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

describe('ProductBuilder — a value warp interpolates a workspace variable', () => {
  it('substitutes a workspace variable, bare and inside a string', () => {
    const product = productOf(
      `---
Language: TypeScript
---

# Version

{{ v = ${varRef('version')} }}
{{ tag = "loom-${varRef('version')}" }}

=>

::[v]
::[tag]
`,
      '/m.loom',
      undefined,
      { version: '1.2.3' },
    )
    const code = Option.getOrThrow(codeNamed(product, 'Version'))
    expect(refs(code.fragments)).toEqual([]) // a value reaches no section
    const text = fragments(code.fragments)
      .map((f) => f.text)
      .join('')
    expect(text).toContain('1.2.3') // the bare workspace variable
    expect(text).toContain('loom-1.2.3') // interpolated inside a string
  })

  it('leaves an undeclared variable in place and raises UnknownVariable', () => {
    const product = productOf(
      `---
Language: TypeScript
---

# Missing

{{ v = ${varRef('nope')} }}

=>

::[v]
`,
      '/m.loom',
      undefined,
      {},
    )
    const code = Option.getOrThrow(codeNamed(product, 'Missing'))
    const faulted = Option.getOrThrow(
      Array.findFirst(fragments(code.fragments), (f) => f.health.status === 'error'),
    )
    console.log(
      '[expected — not a test failure] unknown-variable diagnostic:',
      JSON.stringify(faulted.health.diagnostics),
    )
    expect(faulted.text).toContain(varRef('nope')) // the undeclared name kept verbatim
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
    expect(ref[0]!.health.diagnostics[0]!.message).toContain('but this section holds')
  })
})
