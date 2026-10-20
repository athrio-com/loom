import { describe, expect, it } from 'bun:test'
import { Option } from 'effect'
import {
  chapterPath,
  docsChapterAt,
  documentationPage,
  docsCorpus,
  firstSlugOf,
  docsOpening,
  wovenPage,
} from '../src/docs-page'
import { type Corpus, type Model } from '../src/model'
import { view } from '../src/view'
import { anchor, modelAt, renderDocument, renderHtml } from './render'

const at = (chapter: string, activeSection = '', over: Partial<Model> = {}): Model =>
  modelAt({ route: 'docs', chapter, activeSection, ...over })

const render = (model: Model): string => renderHtml((h) => documentationPage(model, h))

const QUICK = '01-getting-started/01-quick-start'
const INSTALL = '01-getting-started/02-installing-loom'
const INIT = '01-getting-started/03-loom-projects'

describe('the documentation shell', () => {
  it('gives every chapter an address without its ordering numbers, and reads it back', () => {
    expect(chapterPath('/docs', QUICK)).toBe('/docs/getting-started/quick-start')
    docsCorpus.pages.forEach((page) => {
      expect(docsChapterAt(chapterPath('/docs', page.slug))).toEqual(Option.some(page.slug))
    })
    expect(Option.isNone(docsChapterAt('/docs/getting-started/nowhere'))).toBe(true)
    expect(Option.isNone(docsChapterAt('/docs'))).toBe(true)
  })

  it('links every chapter in the menu to its address', () => {
    const html = render(at(QUICK))
    expect(html).toContain(
      'class="menu-item" href="/docs/getting-started/loom-projects">Loom projects<',
    )
  })

  it('lists every chapter of the woven corpus in the menu, grouped under its part', () => {
    const html = render(at(''))
    expect(html).toContain('class="menu-card thin-scroll"')
    docsCorpus.nav.forEach((part) => {
      expect(html).toContain(`class="eyebrow">${part.name}<`)
      part.chapters.forEach((chapter) => expect(html).toContain(`>${chapter.title}<`))
    })
  })

  it('opens on the first chapter when none is named, and marks it in the menu', () => {
    const html = render(at(''))
    expect(firstSlugOf(docsCorpus)).toBe(docsCorpus.pages[0]!.slug)
    expect(html).toContain(
      'class="menu-item here" href="/docs/getting-started/quick-start">Quick start<',
    )
  })

  it("hangs the open chapter's sections under it, the first one reached until the reader scrolls", () => {
    const fresh = render(at(QUICK))
    expect(fresh).toContain('class="menu-sub here" type="button">Write your first loom<')
    expect(fresh).toContain('class="menu-sub" type="button">Run it<')
    const scrolled = render(at(QUICK, 'run-it'))
    expect(scrolled).toContain('class="menu-sub here" type="button">Run it<')
    expect(scrolled).toContain('class="menu-sub" type="button">Write your first loom<')
  })

  it("heads the chapter like the site's other pages: mark, name and lead", () => {
    const html = render(at(QUICK))
    expect(html).toContain('class="section section-hero page-hero doc-hero"')
    expect(html).toMatch(
      /class="page-title"><img[^>]*class="loom-mark"[^>]*><h1 id="quick-start">Quick start<\/h1>/,
    )
    expect(html).toContain('class="docs-prose page-lead"><p>In about five minutes')
  })

  it('sets the commands a chapter opens with beside its lead, not under it', () => {
    const html = render(at(QUICK))
    const cli = html.slice(html.indexOf('class="hero-cli"'), html.indexOf('class="docs-body"'))
    expect(cli).toContain('class="hero-install"')
    expect(cli).toContain('bun add -g @athrio/loom')
    expect(cli).toContain('<span class="line">loom --version</span>')
  })

  it('reads the breadcrumb out of the corpus, not out of the view', () => {
    const html = render(at('05-cli/03-loom-weave'))
    expect(html).toContain('class="crumb" href="/docs">Docs<')
    expect(html).toContain('class="crumb" href="/docs/cli/loom-init">The command line<')
    expect(html).toContain('class="here">loom weave<')
  })

  it("opens the first section on the chapter's flower, and the rest on their heading alone", () => {
    const html = render(at(QUICK))
    expect(html.split('class="section doc-section"').length - 1).toBe(3)
    const marks = html.match(/class="section-head"><span aria-hidden="true"/g) ?? []
    expect(marks.length).toBe(1)
    expect(html).toMatch(
      /class="section-head"><span aria-hidden="true" style="[^"]*linear-gradient[^"]*"><\/span><div class="lines"><h2 id="write-your-first-loom">Write your first loom<\/h2>/,
    )
    expect(html).toContain('class="section-head"><div class="lines"><h2 id="turn-it-into-code">')
  })

  it('gives the quick start the orange sunflower, and its neighbour a different flower', () => {
    const flowerOf = (html: string): string =>
      html.match(/class="section-head"><span aria-hidden="true" style="([^"]*)"/)?.[1] ?? ''
    const head = flowerOf(render(at(QUICK)))
    expect(head).toContain('#FF6A3D')
    expect(head).toContain('#E8318A')
    expect(flowerOf(render(at(INIT)))).not.toBe(head)
  })

  it("renders a chapter's prose as HTML, a one-line bash fence as a copy button", () => {
    const html = render(at(QUICK))
    expect(html).toContain('<h1 id="quick-start">Quick start</h1>')
    expect(html).toContain('class="docs-command"')
    expect(html).not.toContain('language-bash')
  })

  it('draws a quoted loom as a highlighted card, its marks in their colours', () => {
    const html = render(at(QUICK))
    expect(html).toContain('class="docs-canvas"')
    expect(html).not.toContain('language-loom')
    expect(html).toMatch(/class="pl-tok chip"[^>]*>=&gt;</)
    expect(html).toMatch(/class="pl-tok chip"[^>]*>\[hello\.ts\]</)
    expect(html).not.toContain('{Tangle}')
    expect(html).toMatch(/class="pl-tok chip"[^>]*>::\[Greeting function\]</)
  })

  it('draws any other fence as a code sheet with its own copy button', () => {
    const html = render(at(QUICK))
    expect(html).toContain('class="sheet-code"')
    expect(html).toContain('aria-label="Copy the code"')
    expect(html).not.toContain('language-typescript')
  })

  it("draws a picture fence as the docs' own picture, beside the lead", () => {
    const html = render(at(INIT))
    const cli = html.slice(html.indexOf('class="hero-cli"'), html.indexOf('class="docs-body"'))
    expect(cli).toContain('class="ops-frame doc-picture"')
    expect(cli).toContain('<svg')
    expect(cli).toContain('>hello.loom</text>')
    expect(cli).toContain('>hello.ts</text>')
    expect(cli).not.toContain('loom init</span>')
    expect(html).toContain('data-copy="loom init"')
  })

  it('draws a command inside a sentence as an inline copy button', () => {
    const html = render(at(INIT))
    expect(html).toContain(
      '<button type="button" class="inline-copy" style="--cmd-ink: var(--init)" data-copy="loom init" title="Copy the command"><code>loom init</code><svg',
    )
    expect(html).not.toContain('<code>$ loom init</code>')
    expect(html).toContain('<code>.loom/config.yaml</code>')
    expect(html).toContain('style="--cmd-ink: var(--tangle)" data-copy="loom tangle corpus"')
    expect(html).toContain(
      'style="--cmd-ink: var(--prompt-paper)" data-copy="mv hello.loom corpus/"',
    )
  })

  it('marks the inline button it copied, and only that one', () => {
    const html = render(at(INIT, '', { copied: 'inline:loom init' }))
    expect(html).toContain(
      'class="inline-copy done" style="--cmd-ink: var(--init)" data-copy="loom init"',
    )
    const other = render(at(INIT, '', { copied: 'inline:something else' }))
    expect(other).not.toContain('inline-copy done')
  })

  it('runs a file with the runtime the install line chose', () => {
    const bun = render(at(QUICK))
    expect(bun).toContain('<span class="line">bun hello.ts</span>')
    expect(bun).toMatch(
      /class="rt-tab here" type="button">.*?bun<\/button><button class="rt-tab" type="button">.*?node</,
    )
    const npm = render(at(QUICK, '', { runtime: 'npm' }))
    expect(npm).toContain('<span class="line">node hello.ts</span>')
    const pnpm = render(at(QUICK, '', { runtime: 'pnpm' }))
    expect(pnpm).toContain('<span class="line">node hello.ts</span>')
  })

  it('quotes Loom marks as text rather than resolving them', () => {
    const html = render(at('04-the-format/01-syntax'))
    expect(html).toContain(anchor('a section'))
  })

  it("ends a chapter on the site's pager, naming the chapters either side of it", () => {
    const first = render(at(QUICK))
    expect(first).toContain(
      'class="pager-row doc-pager"><a class="pager-card next" href="/docs/getting-started/installing-loom"',
    )
    expect(first).toContain('class="pager-title">Installing Loom<')
    expect(first).not.toContain('>Previous<')
    const second = render(at(INSTALL))
    expect(second).toContain('class="pager-title">Quick start<')
    expect(second).toContain('class="pager-title">Loom projects<')
  })

  it('carries the menu into the drawer, marked identically', () => {
    const html = render(at(QUICK))
    const marked =
      html.split('class="menu-item here" href="/docs/getting-started/quick-start">Quick start<')
        .length - 1
    expect(marked).toBe(2)
    expect(html).toContain('class="docs-drawer"')
    expect(html).toContain('class="docs-scrim"')
  })

  it('opens the drawer and its scrim by class, so both can animate', () => {
    const shut = render(at(''))
    expect(shut).toContain('class="docs-drawer"')
    expect(shut).not.toContain('docs-drawer open')
    const open = render(at('', '', { drawerOpen: true }))
    expect(open).toContain('class="docs-drawer open"')
    expect(open).toContain('class="docs-scrim open"')
  })

  it('draws a chapter with no sections as a head and an empty column', () => {
    const single: Corpus = {
      nav: [{ name: 'Getting started', chapters: [{ number: '1', title: 'Only', slug: 'only' }] }],
      pages: [
        {
          slug: 'only',
          title: 'Only',
          blocks: [
            { type: 'heading', level: 1, title: 'Only', id: 'only' },
            { type: 'prose', markdown: 'A page with nothing under it.' },
          ],
        },
      ],
    } as unknown as Corpus
    const bare = renderHtml((h) => wovenPage(single, 'Docs', '/docs', docsOpening, at('only'), h))
    expect(bare).toContain('<h1 id="only">Only</h1>')
    expect(bare).not.toContain('doc-section')
    expect(bare).toContain('class="menu-subs"></div>')
  })
})

describe('the documentation chrome', () => {
  it('wears the site nav, pinned on a narrow window by a class of its own', () => {
    const html = renderDocument((h) => view(at(''), h)).html
    expect(html).toContain('class="nav docs-nav"')
    expect(html).toContain('class="nav-link here" href="/docs"')
    expect(html).not.toContain('docs-bar')
  })

  it("opens the drawer from a burger at the nav's left end, on the docs only", () => {
    const docs = renderDocument((h) => view(at(''), h)).html
    expect(docs).toMatch(
      /<nav[^>]*class="nav docs-nav"[^>]*><button aria-label="Chapters" class="nav-burger"/,
    )
    const home = renderDocument((h) => view(modelAt(), h)).html
    expect(home).not.toContain('nav-burger')
  })

  it('puts the Loom mark beside the wordmark in every nav', () => {
    const html = renderDocument((h) => view(modelAt({ route: 'why-loom' }), h)).html
    expect(html).toMatch(/class="nav-word"[^>]*><span class="nav-mark"><img[^>]*class="loom-mark"/)
  })
})
