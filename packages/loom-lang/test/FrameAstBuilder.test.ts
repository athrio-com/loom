import { describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import { parseDocument, ParseLayer } from './parse'
import type {
  CodeRef,
  EffectfulBody,
  EmbeddedCode,
  FrameAuthoredToken,
  ProseFragment,
  ServiceClass,
  StaticBody,
} from '@athrio/loom-ast/FrameAst'
import { buildFrame } from '#ast/FrameAstBuilder'

// A ServiceName is authored (tagged → mapped to the `[Tag]`) or synth (tagless →
// the title-derived name, unmapped). Tests asserting a mapped position narrow to
// the authored case first.
const asAuthored = (t: ServiceClass['name']): FrameAuthoredToken => {
  if (t.type !== 'FrameAuthoredToken') {
    throw new Error(`expected an authored token, got ${t.type}`)
  }
  return t
}

// buildFrame over the trivial fixture: one tagged, static section, no Warps.
// Assertions are structural (no renderer here) — the right nodes, fields, and
// source mappings. The frame is runnable: code is a compose of positioned
// dsl.fragment / dsl.refer args, and the root is the __services / __run exports.

const input = `{{lang: TypeScript}}

# Adder [Add]

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

  it('produces one exported ServiceClass named after the tag', () => {
    expect(frame.type).toBe('FrameModule')
    expect(frame.members).toHaveLength(1)
    const member = frame.members[0]!.value
    expect(member.type).toBe('ServiceClass')
    const svc = member as ServiceClass
    expect(svc.modifier.text).toBe('export ')
    // class name and type parameter are the bare name; the string tag is the
    // section's module-qualified identity, so two modules' `Add`s stay distinct
    expect(svc.name.text).toBe('Add')
    expect(svc.nameType.text).toBe('Add')
    expect(svc.nameTag.text).toBe('/x.loom#Add')
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
    expect(frame.root?.services.text).toContain('Add: { layer: Add.Default, self: Add, deps: [] }')
    // a content section contributes to sections/prose; no sink reaches files
    expect(frame.root?.run.text).toContain('(yield* Add).code')
    expect(frame.root?.run.text).toContain('files: [')
    expect(frame.root?.run.text).not.toContain('yield* Add\n') // not a sink yield
  })

  it('keeps the root pure synth glue, so the name maps only at its class declaration', () => {
    // __services and __run repeat each name as plain text. Mapping those repeats
    // would give the [Add] tag extra navigation targets; the class declaration is
    // the one mapped occurrence.
    expect(frame.root?.services.type).toBe('FrameSynthToken')
    expect(frame.root?.run.type).toBe('FrameSynthToken')
  })

  it('maps the class name to the [Add] tag; the field name is a synth display string', () => {
    const svc = frame.members[0]!.value as ServiceClass
    const body = svc.body as StaticBody
    // class name ⇒ the tag label inside `[Add]`, not the title "Adder"
    expect(asAuthored(svc.name).position.start.offset).toBe(
      input.indexOf('[Add]') + 1,
    )
    // a `tag` span — locate-only, so hovering [Add] shows no generated class
    expect(asAuthored(svc.name).kind).toBe('tag')
    // the `name:` field carries the title text but is unmapped — a display
    // string, not a navigation target (mapping it self-references the heading)
    expect(body.name.type).toBe('FrameSynthToken')
    expect(body.name.text).toBe('Adder')
  })
})

describe('buildFrame — mapped spans hug the inner payload, not delimiters', () => {
  const src = `{{lang: TypeScript}}

# Helper [Help]

=>

export const help = 1

# Main [Main]

{{h = Help}}

=>

main = ::[h]
`
  const frame = buildFrame(parse(src), '/x.loom')
  const main = frame.members
    .map((m) => m.value)
    .find(
      (v): v is ServiceClass =>
        v.type === 'ServiceClass' && v.name.text === 'Main',
    )!
  const body = main.body as EffectfulBody
  const binding = body.bindings[0]!.value // the one Warp, `{{h = Help}}`
  const at = (p: { start: { offset: number }; end: { offset: number } }) =>
    src.slice(p.start.offset, p.end.offset)

  it('a Warp binds name and value to the inner spans of {{name = Tag}}', () => {
    expect(binding.name.text).toBe('h')
    expect(at(binding.name.position)).toBe('h') // not "{{h = Help}}"
    // a service Warp's tag is authored — it maps to the `Help` value span
    const tag = binding.tag
    expect(tag.type).toBe('FrameAuthoredToken')
    if (tag.type !== 'FrameAuthoredToken') return
    expect(tag.text).toBe('Help')
    expect(at(tag.position)).not.toMatch(/[{}]/) // no delimiters
    expect(at(tag.position)).toContain('Help')
  })

  it('a code anchor binds to the inner name of ::[name], not the braces', () => {
    const ref = argsOf(body.code).find(
      (a): a is CodeRef => (a as CodeRef).type === 'CodeRef',
    )!
    expect(ref.binding.text).toBe('h')
    expect(at(ref.binding.position)).toBe('h') // not "::[h]"
    expect(ref.binding.position.start.offset).toBe(src.lastIndexOf('::[h]') + 3)
  })
})

describe('buildFrame — inline-arrow and multi-chunk code reach the compose', () => {
  // `=> code` inline, and a `=> … ~ … => …` body (Code/Prose alternation) must
  // both compose — the chunks join, the interleaved prose drops.
  const src = `{{lang: TypeScript}}

# Inline [Inline]

=> export const a = 1

# Multi [Multi]

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

describe('buildFrame — a tagged tangle maps its class once; the sink yield repeats the name as synth', () => {
  // A heading may carry both a tag and a path: `# Title [Tag] {path}`. The tag
  // makes the class name authored and mapped to `[Tag]`, so it is the one mapped
  // occurrence. The composition root's __run yields the sink — `yield* Bun` — as
  // plain text. Were the sink mapped too, the [Bun] tag would gain a second
  // navigation target. The tagless tangle above cannot catch this: its name is
  // synth regardless, so only a tagged tangle tells the fix from the bug apart.
  const src = `{{lang: TypeScript}}

# Bundle it [Bun] {dist/bundle.sh}

=>

const x = 1
`
  const frame = buildFrame(parse(src), '/x.loom')
  const svc = frame.members[0]!.value as ServiceClass

  it('maps the class name to the [Bun] tag — the one mapping', () => {
    expect(svc.name.type).toBe('FrameAuthoredToken')
    expect(asAuthored(svc.name).position.start.offset).toBe(
      src.indexOf('[Bun]') + 1,
    )
  })

  it('yields the sink in __run as plain text, so the tag has one navigation target', () => {
    expect(frame.root?.run.text).toContain('yield* Bun')
    expect(frame.root?.services.text).toContain('Bun: { layer: Bun.Default')
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

# Main [Main]

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

# Main [Main]

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
