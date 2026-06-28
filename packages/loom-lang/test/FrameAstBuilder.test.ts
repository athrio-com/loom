import { describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import { parseDocument, ParseLayer } from './parse'
import type {
  CodeRef,
  EffectfulBody,
  EmbeddedCode,
  ProseFragment,
  ServiceClass,
  StaticBody,
} from '@athrio/loom-ast/FrameAst'
import { buildFrame } from '#ast/FrameAstBuilder'

// Every section's class name is synth glue: the title normalised to an identifier,
// with no source span. Tests read it as text, not as a mapped position.

// buildFrame over the trivial fixture: one static section, no anchors.
// Assertions are structural (no renderer here) — the right nodes, fields, and
// source mappings. The frame is runnable: code is a compose of positioned
// dsl.fragment / dsl.refer args, and the root is the __services / __run exports.

const input = `{{lang: TypeScript}}

# Adder

Adds two integers.

=>

export const add = (x: number, y: number): number => x + y
`

const parse = (src: string) =>
  Effect.runSync(parseDocument(src).pipe(Effect.provide(ParseLayer)))

const argsOf = (code: { args: ReadonlyArray<{ value: unknown }> }) =>
  code.args.map((a) => a.value)

describe('buildFrame — trivial section → FrameModule', () => {
  const frame = buildFrame(parse(input), '/x.loom')

  it('produces one exported ServiceClass named after the title', () => {
    expect(frame.type).toBe('FrameModule')
    expect(frame.members).toHaveLength(1)
    const member = frame.members[0]!.value
    expect(member.type).toBe('ServiceClass')
    const svc = member as ServiceClass
    expect(svc.modifier.text).toBe('export ')
    // class name and type parameter are the title-derived name; the string tag is
    // the section's module-qualified identity, so two modules' `Adder`s stay distinct
    expect(svc.name.text).toBe('Adder')
    expect(svc.nameType.text).toBe('Adder')
    expect(svc.nameTag.text).toBe('/x.loom#Adder')
  })

  it('maps title → name, preamble → woven prose, code → compose', () => {
    const svc = frame.members[0]!.value as ServiceClass
    expect(svc.body.type).toBe('StaticBody')
    const body = svc.body as StaticBody
    expect(body.name.text).toBe('Adder')
    const proseHead = body.prose.args[0]!.value as ProseFragment
    expect(proseHead.type).toBe('ProseFragment')
    expect(proseHead.text).toContain('Adds two integers.')
    const head = body.code.args[0]!.value as EmbeddedCode
    expect(head.type).toBe('EmbeddedCode')
    expect(head.text).toContain('export const add = (x: number, y: number)')
    expect(body.code.args).toHaveLength(1)
  })

  it('synthesises a Root listing the one service, no sinks', () => {
    expect(frame.root?.type).toBe('Root')
    expect(frame.root?.services.text).toContain('Adder: { layer: Adder.Default, self: Adder, deps: [] }')
    // a content section contributes to sections/prose; no sink reaches files
    expect(frame.root?.run.text).toContain('(yield* Adder).code')
    expect(frame.root?.run.text).toContain('files: [')
    expect(frame.root?.run.text).not.toContain('yield* Adder\n') // not a sink yield
  })

  it('keeps the root pure synth glue, like the class name itself', () => {
    // The class name, __services, and __run are all synth text — the title-derived
    // name repeated, with no source span. None is a navigation target.
    expect((frame.members[0]!.value as ServiceClass).name.type).toBe('FrameSynthToken')
    expect(frame.root?.services.type).toBe('FrameSynthToken')
    expect(frame.root?.run.type).toBe('FrameSynthToken')
  })

  it('carries the title text in the `name:` field as a synth display string', () => {
    const svc = frame.members[0]!.value as ServiceClass
    const body = svc.body as StaticBody
    // the `name:` field carries the title text but is unmapped — a display
    // string, not a navigation target (mapping it self-references the heading)
    expect(body.name.type).toBe('FrameSynthToken')
    expect(body.name.text).toBe('Adder')
  })
})

describe('buildFrame — mapped spans hug the inner payload, not delimiters', () => {
  const src = `{{lang: TypeScript}}

# Help

=>

export const help = 1

# Main

=>

main = ::[Help]
`
  const frame = buildFrame(parse(src), '/x.loom')
  const main = frame.members
    .map((m) => m.value)
    .find(
      (v): v is ServiceClass =>
        v.type === 'ServiceClass' && v.name.text === 'Main',
    )!
  const body = main.body as EffectfulBody
  const binding = body.bindings[0]!.value // the hoisted `const _Help = yield* Help`
  const at = (p: { start: { offset: number }; end: { offset: number } }) =>
    src.slice(p.start.offset, p.end.offset)

  it('hoists a binding whose alias maps to the heading title', () => {
    expect(binding.name.text).toBe('_Help')
    // the alias is the definition: mapped to the `# Help` heading title
    expect(at(binding.name.position)).toBe('Help')
    expect(binding.name.kind).toBe('heading')
    expect(binding.tag.type).toBe('FrameSynthToken') // `yield* Help` is glue
  })

  it('a code anchor binds to the inner name of ::[name], not the braces', () => {
    const ref = argsOf(body.code).find(
      (a): a is CodeRef => (a as CodeRef).type === 'CodeRef',
    )!
    // the reference resolves through the hoisted alias `_Help`
    expect(ref.binding.text).toBe('_Help')
    expect(at(ref.binding.position)).toBe('Help') // not "::[Help]"
    expect(ref.binding.position.start.offset).toBe(src.lastIndexOf('::[Help]') + 3)
  })
})

describe('buildFrame — inline-arrow and multi-chunk code reach the compose', () => {
  // `=> code` inline, and a `=> … ~ … => …` body (Code/Prose alternation) must
  // both compose — the chunks join, the interleaved prose drops.
  const src = `{{lang: TypeScript}}

# Inline

=> export const a = 1

# Multi

=>
const b = 2
~
prose between — not code
=>
const c = 3
`
  const frame = buildFrame(parse(src), '/x.loom')
  const composed = (name: string): string => {
    const svc = frame.members
      .map((m) => m.value)
      .find(
        (v): v is ServiceClass =>
          v.type === 'ServiceClass' && v.name.text === name,
      )!
    const { code } = svc.body as StaticBody
    return argsOf(code)
      .filter((a): a is EmbeddedCode => (a as EmbeddedCode).type === 'EmbeddedCode')
      .map((e) => e.text)
      .join('')
  }

  it('takes an inline `=>` payload into the compose', () => {
    expect(composed('Inline')).toContain('export const a = 1')
  })

  it('composes every `=>` chunk and drops the interleaved prose', () => {
    const code = composed('Multi')
    expect(code).toContain('const b = 2')
    expect(code).toContain('const c = 3')
    expect(code).not.toContain('prose between')
  })
})

describe('buildFrame — an anchor refers to its section heading; a tangle takes its path extension', () => {
  // A tagless section's class name is synthetic glue (no source span). A name
  // anchor reaches the section through the hoisted `const _N = yield* N` binding:
  // the alias maps to the heading (the definition), `yield* N` is synth glue, and
  // each `_N.code` reference maps to the anchor (the referencer). A tangle reads its
  // language from its path extension, not the document default.
  const src = `{{lang: TypeScript}}

# Helper {sh}

=>

echo hi

# Bundle it {dist/bundle.sh}

=>

::[Helper]
`
  const services = buildFrame(parse(src), '/x.loom')
    .members.map((m) => m.value)
    .filter((v): v is ServiceClass => v.type === 'ServiceClass')
  const helper = services.find((v) => v.body.type === 'StaticBody')!
  const tangle = services.find((v) => v.body.type === 'TangleBody')!

  it('names a tagless section with a synth name (glue, unmapped)', () => {
    expect(helper.name.type).toBe('FrameSynthToken')
    expect(helper.name.text).toBe('Helper')
    expect('position' in helper.name).toBe(false)
    // the type parameter and string tag repeat the name; both synth
    expect(helper.nameType.type).toBe('FrameSynthToken')
    expect(helper.nameTag.type).toBe('FrameSynthToken')
  })

  it('binds the anchor: alias maps to the heading (definition), `yield*` tag synth', () => {
    const body = tangle.body
    expect(body.type).toBe('TangleBody')
    if (body.type !== 'TangleBody') return
    const binding = body.bindings[0]!.value
    expect(binding.name.text).toBe('_Helper')
    // the alias is the definition: mapped to the `# Helper` heading title,
    // and kind `heading` — locate-only, so hover stays off the heading
    expect(binding.name.position.start.offset).toBe(src.indexOf('Helper'))
    expect(binding.name.kind).toBe('heading')
    expect(binding.tag.type).toBe('FrameSynthToken')
  })

  it('marks a tangle with the language its path extension names', () => {
    expect(tangle.languageId).toBe('sh') // from `dist/bundle.sh` — not the doc default `typescript`
    expect(tangle.name.type).toBe('FrameSynthToken') // tagless — glue, unmapped
  })
})

describe('buildFrame — a tangle yields its sink in __run as plain text', () => {
  // A {path} section is a sink. The composition root's __run yields it —
  // `yield* BundleIt` — as plain synth text, an unmapped glue reference.
  const src = `{{lang: TypeScript}}

# Bundle it {dist/bundle.sh}

=>

const x = 1
`
  const frame = buildFrame(parse(src), '/x.loom')

  it('yields the sink in __run as plain text', () => {
    expect(frame.root?.run.text).toContain('yield* BundleIt')
    expect(frame.root?.services.text).toContain('BundleIt: { layer: BundleIt.Default')
    expect(frame.root?.run.type).toBe('FrameSynthToken') // glue, unmapped
  })
})

describe('buildFrame — a name anchor to a duplicated title is an ambiguous-anchor diagnostic', () => {
  // Two sections share the title "Helper"; a third anchors it by name. A name
  // anchor resolves exactly one local section, so the clash is reported on the
  // anchor — a CodeRef against the unresolved name, carrying error health —
  // rather than silently resolved to the last section.
  const src = `{{lang: TypeScript}}

# Helper

=>

export const a = 1

# Helper

=>

export const b = 2

# Main

=>

main = ::[Helper]
`
  const frame = buildFrame(parse(src), '/x.loom')
  const main = frame.members
    .map((m) => m.value)
    .find(
      (v): v is ServiceClass =>
        v.type === 'ServiceClass' && v.name.text === 'Main',
    )!
  const code = (main.body as StaticBody).code
  const faulted = argsOf(code).find(
    (a): a is EmbeddedCode =>
      (a as EmbeddedCode).type === 'EmbeddedCode' &&
      (a as EmbeddedCode).health.status === 'error',
  )!

  it('leaves an inert fragment carrying the ambiguous-anchor diagnostic', () => {
    expect(faulted.type).toBe('EmbeddedCode') // not a dangling reference
    expect(faulted.text).toBe('') // transcludes nothing, so the run stays whole
    expect(faulted.health.status).toBe('error')
    expect(faulted.health.diagnostics[0]!.message).toMatch(
      /Ambiguous anchor: 2 sections are named `Helper`/,
    )
  })

  it('hoists no binding for the ambiguous anchor — the body stays static', () => {
    expect(main.body.type).toBe('StaticBody')
  })
})

describe('buildFrame — primary language: doc Warp → package language → plaintext', () => {
  // The lang Warp is optional. A specifier-less section takes the document's lang
  // Warp when present, otherwise the package language buildFrame is handed, and
  // finally plaintext when neither is set.
  const langOf = (src: string, packageLanguage?: string): string => {
    const svc = buildFrame(parse(src), '/x.loom', packageLanguage)
      .members.map((m) => m.value)
      .find((v): v is ServiceClass => v.type === 'ServiceClass')!
    return svc.languageId
  }

  const noWarp = `# Helper

=>

const helper = 1
`
  const withWarp = `{{lang: TypeScript}}

# Helper

=>

const helper = 1
`

  it('falls back to the package language when the document omits the lang Warp', () => {
    expect(langOf(noWarp, 'bash')).toBe('bash')
  })

  it('lets the document lang Warp override the package language', () => {
    expect(langOf(withWarp, 'bash')).toBe('typescript')
  })

  it('falls back to plaintext when neither the Warp nor a package language is set', () => {
    expect(langOf(noWarp)).toBe('plaintext')
  })
})

describe('buildFrame — cross-language composition is a diagnostic', () => {
  // A TypeScript section name-composes a JSON section. The two languages cannot
  // share one composed file, so the anchor carries error health naming the clash.
  const src = `{{lang: TypeScript}}

# Config {json}

=>

{ "port": 8080 }

# Main

=>

const config = ::[Config]
`
  const main = buildFrame(parse(src), '/x.loom')
    .members.map((m) => m.value)
    .find(
      (v): v is ServiceClass =>
        v.type === 'ServiceClass' && v.name.text === 'Main',
    )!
  const ref = argsOf(main.body.code).find(
    (a): a is CodeRef => (a as CodeRef).type === 'CodeRef',
  )!

  it('flags a TypeScript section that name-composes a JSON section', () => {
    expect(ref.binding.health.status).toBe('error')
    expect(ref.binding.health.diagnostics[0]!.message).toMatch(
      /Cross-language transclusion: `Config` is json, but this section composes typescript/,
    )
  })
})
