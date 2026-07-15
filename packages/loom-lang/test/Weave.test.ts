import { describe, expect, it as it_ } from 'bun:test'
import { effectify } from '@athrio/effect-test'
const it = effectify(it_)
import { Effect, Option } from 'effect'
import { LoomCorpusAstBuilder } from '#ast/LoomCorpusAstBuilder'
import type { LoomCorpusAst } from '@athrio/loom-ast/LoomCorpusAst'
import { WeaveBuilder } from '../src/weave/WeaveBuilder'
import type { CodeBlock, HeadingBlock } from '../src/weave/WovenCorpus'

// A two-file corpus: a book root that carries a `{TOC}`, and a chapter whose
// frontmatter opens Part I — a section that defines a name and a `{Tangle}`
// section that composes it with `::[The name]`. Weave projects this into a
// `WovenCorpus`: a navigation tree from the corpus frontmatter, a page for the
// chapter, and the anchor turned into a link back to the section it names.
const book = `# Loom

Intro prose.

# Contents {TOC}

### Part I — Using Loom

1. A greeting
`

const greeting = `---
Part I: Using Loom
Chapter 1: A greeting
Package: greeting.ts
Language: TypeScript
---

# A greeting

The greeting composes a name.

## The name

=>

const name = 'world'

## The greeting {Tangle}

=>

::[The name]

console.log(\`hello \${name}\`)
`

const files: Record<string, string> = {
  '/corpus/book.loom': book,
  '/corpus/using/greeting.loom': greeting,
}

const buildCorpus = (sources: Record<string, string>): LoomCorpusAst =>
  Effect.runSync(
    Effect.gen(function* () {
      const builder = yield* LoomCorpusAstBuilder
      const modules = yield* Effect.forEach(Object.keys(sources), (path) =>
        builder
          .build(
            {
              read: (p) => Effect.succeed(sources[p] ?? ''),
              list: Option.none(),
            },
            path,
          )
          .pipe(Effect.map((module) => [path, module] as const)),
      )
      return { modules: new Map(modules) }
    }).pipe(Effect.provide(LoomCorpusAstBuilder.layer)),
  )

const weave = (corpus: LoomCorpusAst) =>
  Effect.runSync(
    Effect.gen(function* () {
      const builder = yield* WeaveBuilder
      return yield* builder.build(corpus)
    }).pipe(Effect.provide(WeaveBuilder.layer)),
  )

describe('the weave projection', () => {
  it('folds the contents into a navigation tree', () => {
    const site = weave(buildCorpus(files))
    expect(site.nav).toEqual([
      {
        number: 'I',
        name: 'Using Loom',
        chapters: [
          { number: '1', title: 'A greeting', slug: 'using/greeting' },
        ],
      },
    ])
  })

  it('makes a page for the chapter, not for the book root', () => {
    const site = weave(buildCorpus(files))
    expect(site.pages.map((p) => p.slug)).toEqual(['using/greeting'])
    const page = site.pages[0]!
    expect(page.title).toBe('A greeting')
    expect(page.part).toBe('Using Loom')
  })

  it('renders the sections as blocks in reading order', () => {
    const page = weave(buildCorpus(files)).pages[0]!
    // heading, intro prose, heading, code, heading, code
    expect(page.blocks.map((b) => b.type)).toEqual([
      'heading',
      'prose',
      'heading',
      'code',
      'heading',
      'code',
    ])
    const opening = page.blocks[0] as HeadingBlock
    expect(opening.level).toBe(1)
    expect(opening.title).toBe('A greeting')
    const nameHeading = page.blocks[2] as HeadingBlock
    expect(nameHeading.level).toBe(2)
    expect(nameHeading.id).toBe('the-name')
    const nameCode = page.blocks[3] as CodeBlock
    expect(nameCode.language).toBe('typescript')
    expect(nameCode.code).toBe("const name = 'world'")
  })

  it('anchors every block to the chapter and section it came from', () => {
    const page = weave(buildCorpus(files)).pages[0]!
    const opening = page.blocks[0] as HeadingBlock
    expect(opening.source).toEqual({ chapter: 'using/greeting', section: 'a-greeting' })
    const nameCode = page.blocks[3] as CodeBlock
    expect(nameCode.source).toEqual({ chapter: 'using/greeting', section: 'the-name' })
  })

  it('turns a code anchor into a link at its place in the block', () => {
    const page = weave(buildCorpus(files)).pages[0]!
    const tangle = page.blocks[5] as CodeBlock
    expect(tangle.code.startsWith('::[The name]')).toBe(true)
    expect(tangle.links).toEqual([
      {
        name: 'The name',
        targetSlug: 'using/greeting',
        targetId: 'the-name',
        offset: 0,
        length: '::[The name]'.length,
      },
    ])
    // the link's span is exactly the anchor text in the block code
    const link = tangle.links[0]!
    expect(tangle.code.slice(link.offset, link.offset + link.length)).toBe(
      '::[The name]',
    )
  })
})

// A chapter with a note in its prose. The `:::[Note] … :::` block is split into a
// note block, and a `#` inside it stays inert — no phantom section.
const noted = `---
Part I, Chapter 1: A greeting
Language: Prose
---

# A greeting

The opening paragraph.

:::[Note] { }
> The opening paragraph.

# Not a heading — inert inside the note
Tighten this opening.
:::

The paragraph after the note.
`

describe('notes in prose', () => {
  it('splits a :::[Note] block out and keeps its body inert', () => {
    const page = weave(buildCorpus({ '/corpus/note.loom': noted })).pages[0]!
    const kinds = page.blocks.map((b) => b.type)
    expect(kinds).toContain('note')
    // the `#` inside the note did not open a section — only the chapter's own h1
    expect(kinds.filter((k) => k === 'heading')).toHaveLength(1)
    const note = page.blocks.find((b) => b.type === 'note')
    expect(note?.type).toBe('note')
    if (note?.type === 'note') {
      expect(note.markdown).toContain('Tighten this opening')
      expect(note.markdown).toContain('> The opening paragraph.')
    }
  })
})
