import { describe, expect, it } from 'bun:test'
import { Option } from 'effect'
import { documentationPage, docsCorpus, firstSlugOf } from '../src/docs-page'
import { docsBar } from '../src/chrome'
import { type Model } from '../src/model'
import { renderHtml } from './render'

// The documentation shell draws whatever `loom weave` produced from the docs corpus, so
// these cases assert against the committed weave rather than against a fixture. That is
// deliberate: if a chapter is renamed, retitled or loses a heading, the weave changes and
// this notices. The two cases that matter are a chapter with subheadings and one without,
// because only the first grows a third column.
const at = (chapter: string, activeSection: string): Model =>
  ({
    route: 'docs', chapter, searchOpen: false, caret: 0, searching: false,
    activeSection,
    player: { struck: 0, beat: 0, playing: false, output: Option.none(), full: false }, version: '0.0.9',
    query: '', focus: 0, copied: '',
  }) as Model

const render = (model: Model): string => renderHtml((h) => documentationPage(model, h))
const renderBar = (model: Model): string => renderHtml((h) => docsBar(model, h))

describe('the documentation shell', () => {
  it('rails every chapter of the woven corpus, grouped under its part', () => {
    const html = render(at('', ''))
    docsCorpus.nav.forEach((part) => {
      expect(html).toContain(`class="rail-label">${part.name}<`)
      part.chapters.forEach((chapter) => expect(html).toContain(`>${chapter.title}<`))
    })
  })

  it('opens on the first chapter when none is named, and marks it in the rail', () => {
    const html = render(at('', ''))
    expect(firstSlugOf(docsCorpus)).toBe(docsCorpus.pages[0]!.slug)
    expect(html).toContain('class="rail-item here" type="button">Installation<')
  })

  it('renders a chapter\'s prose as HTML, fences included', () => {
    const html = render(at('01-getting-started/01-installation', ''))
    expect(html).toContain('<h1 id="installation">Installation</h1>')
    expect(html).toContain('<pre><code class="language-bash">bun add -g @athrio/loom')
  })

  it('outlines the headings of a chapter that has them, marking the active one', () => {
    const html = render(at('02-the-format/01-syntax', 'anchors'))
    expect(html).toContain('On this page')
    expect(html).toContain('class="outline-link here" type="button">Anchors<')
    expect(html).toContain('class="outline-link" type="button">Tangling<')
  })

  it('drops the third column when a chapter has no headings to outline', () => {
    const bare = render(at('01-getting-started/01-installation', ''))
    expect(bare).toContain('class="docs-shell alone"')
    expect(bare).not.toContain('On this page')
    const outlined = render(at('02-the-format/01-syntax', ''))
    expect(outlined).toContain('class="docs-shell"')
    expect(outlined).not.toContain('docs-shell alone')
  })

  it('reads the breadcrumb out of the corpus, not out of the view', () => {
    const html = render(at('03-cli/03-loom-weave', ''))
    expect(html).toContain('>docs<')
    expect(html).toContain('>the command line<')
    expect(html).toContain('class="here">loom weave<')
  })

  it('quotes Loom marks as text rather than resolving them', () => {
    const html = render(at('02-the-format/01-syntax', ''))
    expect(html).toContain('::[a section]')
  })

  it('carries the rail into the drawer, marked identically', () => {
    const html = render(at('02-the-format/01-syntax', ''))
    // the rail row and the drawer row are the same markup, so the marker appears twice
    const marked = html.split('class="rail-item here" type="button">Syntax<').length - 1
    expect(marked).toBe(2)
    expect(html).toContain('class="docs-drawer"')
    expect(html).toContain('class="docs-scrim"')
  })

  it('opens the drawer and its scrim by class, so both can animate', () => {
    const shut = render(at('', ''))
    expect(shut).toContain('class="docs-drawer"')
    expect(shut).not.toContain('docs-drawer open')
    const open = render({ ...at('', ''), drawerOpen: true } as Model)
    expect(open).toContain('class="docs-drawer open"')
    expect(open).toContain('class="docs-scrim open"')
  })

  it('lifts the rail when the bar has slid away', () => {
    expect(render(at('', ''))).not.toContain('bar-hidden')
    expect(render({ ...at('', ''), navHidden: true } as Model)).toContain('bar-hidden')
  })
})

describe('the documentation bar', () => {
  it('sets the wordmark left and names the real version', () => {
    const html = renderBar(at('', ''))
    expect(html).toContain('class="bar-word-text">Loom<')
    expect(html).toContain('v0.0.9')
    expect(html).toContain('View the repo on GitHub')
  })

  it('marks the page it is on and leaves the others plain', () => {
    const html = renderBar(at('', ''))
    expect(html).toContain('class="nav-link here"')
  })

  it('hides by class rather than by leaving the document', () => {
    expect(renderBar(at('', ''))).toContain('class="docs-bar"')
    expect(renderBar({ ...at('', ''), navHidden: true } as Model)).toContain('class="docs-bar hidden"')
  })

  it('carries the burger that opens the drawer', () => {
    expect(renderBar(at('', ''))).toContain('class="bar-burger"')
  })

  it('ends the documentation on its own plainer pager, inside the article column', () => {
    const html = render(at('', ''))
    expect(html).toContain('class="docs-pager"')
    // the docs route is first in the reading order, so only a Next card
    expect(html).not.toContain('>Previous<')
    expect(html).toContain('class="pager-title">Community<')
    // and it takes no woven mark, unlike the marketing pager
    expect(html).not.toContain('class="docs-pager-card"><span aria-hidden')
  })
})
