import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Option } from 'effect'
import { view } from '../src/view'
import { pager } from '../src/chrome'
import { type Corpus, type Model, pathOf, type Route, routeOf } from '../src/model'
import { anchor, modelAt, renderDocument, renderHtml } from './render'

const at = (route: Route, over: Partial<Model> = {}): Model => modelAt({ route, ...over })

const render = (model: Model): string => renderHtml((h) => view(model, h).body)

const ROUTES: ReadonlyArray<Route> = ['home', 'docs', 'why-loom', 'community', 'source', 'license']

describe('the page', () => {
  it('renders every route without throwing, and ends each on the footer', () => {
    ROUTES.forEach((route) => {
      const html = render(at(route))
      expect(html.length).toBeGreaterThan(500)
      expect(html).toContain('class="footer"')
    })
  })

  it('titles each route for itself rather than repeating the site name', () => {
    const titles = ROUTES.map((route) => renderDocument((h) => view(at(route), h)).title)
    expect(new Set(titles).size).toBe(ROUTES.length)
    expect(renderDocument((h) => view(at('home'), h)).title).toContain('literate programming')
  })

  it('gives every page, the docs included, the same centred nav', () => {
    ROUTES.forEach((route) => expect(render(at(route))).toMatch(/class="nav( docs-nav)?"/))
    expect(render(at('docs'))).not.toContain('docs-bar')
  })

  it('puts the hero and its install line on the landing', () => {
    const html = render(at('home'))
    expect(html).toContain('Literate programming framework that keeps meaning in your codebase from evaporating</h1>')
    expect(html).toContain('in prose and code — as one source')
    expect(html).toContain('bun add -g @athrio/loom')
    expect(html).toContain('class="hero-word">Loom<')
  })

  it('rewrites the install line for the runtime a reader picks', () => {
    expect(render(at('home'))).toContain('bun add -g @athrio/loom')
    const npm = render(at('home', { runtime: 'npm' }))
    expect(npm).toContain('npm install -g @athrio/loom')
    expect(npm).not.toContain('bun add -g @athrio/loom')
    expect(npm).toContain('class="rt-tab here"')
  })

  it('flashes the copy label only on the button that was pressed', () => {
    expect(render(at('home'))).toContain('class="took">copy<')
    expect(render(at('home', { copied: 'install' }))).toContain('class="took done">copied<')
  })

  it('raises the palette over whatever page is showing, and only when open', () => {
    expect(render(at('home'))).not.toContain('palette-shell')
    expect(render(at('home', { searchOpen: true }))).toContain('palette-shell')
    expect(render(at('docs', { searchOpen: true }))).toContain('palette-shell')
  })

  it('draws the woven documentation on the docs route', () => {
    const html = render(at('docs'))
    expect(html).toContain('class="menu-card thin-scroll"')
    expect(html).toContain('<h1 id="quick-start">Quick start</h1>')
  })

  it('draws the source page through the docs shell, its anchors as links', () => {
    const book: Corpus = {
      nav: [
        {
          number: 'I',
          name: 'Using Loom',
          chapters: [
            { number: '1', title: 'A first loom', slug: '01-using-loom/01-a-first-loom' },
            { number: '2', title: 'A workspace', slug: '01-using-loom/02-a-workspace' },
          ],
        },
      ],
      pages: [
        {
          slug: '01-using-loom/01-a-first-loom',
          title: 'A first loom',
          blocks: [
            { type: 'heading', level: 1, title: 'A first loom', id: 'a-first-loom' },
            { type: 'prose', markdown: 'Opening words.' },
            { type: 'heading', level: 2, title: 'The program', id: 'the-program' },
            {
              type: 'code',
              language: 'typescript',
              code: `${anchor('Greeting')}\nconsole.log(greet())`,
              links: [
                {
                  name: 'Greeting',
                  offset: 0,
                  length: 12,
                  targetSlug: '01-using-loom/01-a-first-loom',
                  targetId: 'greeting',
                },
              ],
              marks: [{ offset: 25, length: 5, kind: 'function' }],
            },
            { type: 'heading', level: 2, title: 'Greeting', id: 'greeting' },
            {
              type: 'code',
              language: 'typescript',
              code: 'const greet = () => 1',
              links: [],
              marks: [
                { offset: 0, length: 5, kind: 'keyword' },
                { offset: 20, length: 1, kind: 'constant' },
              ],
            },
          ],
        },
      ],
    }
    const html = render(at('source', { book: Option.some(book) }))
    expect(html).toContain('class="menu-card thin-scroll"')
    expect(html).toContain('<p class="page-place">Part I, Chapter 1</p>')
    expect(html).toContain('<h1 class="chapter-title" id="a-first-loom">A first loom</h1>')
    expect(html).toContain(
      `<a class="code-anchor" href="#greeting">${anchor('Greeting')}</a>\nconsole.log(<span class="tok-function">greet</span>()`,
    )
    expect(html).toContain(
      '<span class="tok-keyword">const</span> greet = () =&gt; <span class="tok-constant">1</span>',
    )
    expect(html).toContain('href="/source/using-loom/a-workspace"')
    ROUTES.forEach((route) => expect(render(at(route))).not.toContain('Being written'))
  })

  it('makes the case on the argument page: head, motivation, eight pairs in three groups', () => {
    const html = render(at('why-loom'))
    expect(html).toContain('Why Loom?</h1>')
    expect(html).toContain('href="https://github.com/athrio-com/loom"')
    expect(html).toContain('href="https://t.me/athrio"')
    expect(html).toContain('The missing why')
    expect(html.split('class="why-pair"').length - 1).toBe(8)
    expect(html.split('class="why-group"').length - 1).toBe(3)
    expect(html).toContain('What Loom solves')
    expect(html).not.toContain('why-legend')
    expect(html).toContain('--pair-ink')
    expect(html).toContain('class="pager"')
  })

  it('lists where the work happens on the community page, each card a link', () => {
    const html = render(at('community'))
    expect(html).toContain('Community</h1>')
    expect(html).toContain('Contribute in your way')
    expect(html.split('class="channel-card"').length - 1).toBe(4)
    ;[
      'https://t.me/athrio',
      'https://github.com/athrio-com/loom/issues',
      'https://github.com/athrio-com/loom/pulls',
      'https://github.com/athrio-com/loom/discussions',
    ].forEach((href) => expect(html).toContain(`href="${href}"`))
  })

  it('sets the licence out in full on its own page, read from the repository file', () => {
    const html = render(at('license'))
    expect(html).toContain('License</h1>')
    expect(html).toContain('MIT License</h2>')
    expect(html).toContain('Copyright (c) 2026 Quadrivium Academy Sihtasutus and Loom contributors')
    expect(html).toContain(
      'Permission is hereby granted, free of charge, to any person obtaining a copy of this software',
    )
    expect(html).toContain('THE SOFTWARE IS PROVIDED')
    expect(render(at('home'))).toContain('href="/license"')
  })

  it('opens the footer chips that leave the site in a new tab, and only those', () => {
    const html = render(at('home'))
    const chips = html.match(/<a class="footer-chip"[^>]*>/g) ?? []
    chips.forEach((chip) => expect(chip.includes('target="_blank"')).toBe(/href="https?:/.test(chip)))
    const nonprofit = html.match(
      /<a class="footer-chip" href="https:\/\/qda\.ee"[^>]*>About Nonprofit<svg/,
    )
    expect(nonprofit?.[0]).toContain('target="_blank"')
    expect(nonprofit?.[0]).toContain('rel="noopener noreferrer"')
    expect(html).toMatch(/href="\/license"[^>]*>License<\/a>/)
  })

  it('points every community link at Telegram, never the dead Discord invite', () => {
    ;(['home', 'docs', 'why-loom', 'community', 'source'] as ReadonlyArray<Route>).forEach((route) => {
      const html = render(at(route, { searchOpen: true }))
      expect(html).not.toContain('discord')
      expect(html).toContain('https://t.me/athrio')
    })
  })

  it('shows the whole vocabulary on the landing, all eight marks', () => {
    const html = render(at('home'))
    expect(html).toContain('The whole vocabulary')
    expect(html).toContain('Loom syntax')
    const glyphs = html.split('class="mark-glyph"').length - 1
    expect(glyphs).toBe(8)
    ;['Frontmatter', 'Section', 'Warp', 'Sink', 'Specifier', 'Arrow', 'Tilde', 'Anchor'].forEach(
      (name) => expect(html).toContain(`class="mark-name">${name}<`),
    )
  })

  it("derives each glyph chip wash from the mark's own colour", () => {
    const html = render(at('home'))
    expect(html).toContain('color: #8B5CF6; background: #8B5CF61F')
    expect(html).toContain('color: #00996B; background: #00996B1F')
  })

  it('gives a 42px section mark the broad seam and its 1px inset, and the 17px glyphs neither', () => {
    const home = render(at('home'))
    expect(home).toContain('calc(100% / 7 + 0.8px)')
    expect(home).toContain('background-origin: content-box')
    const palette = render(at('home', { searchOpen: true }))
    expect(palette).toContain('calc(100% / 7 + 0.5px)')
  })

  it('draws all four commands, each pill in its own colour', () => {
    const html = render(at('home'))
    expect(html).toContain('From init to eject')
    ;[
      ['loom init', '#00996B'],
      ['loom tangle', '#2E6FF2'],
      ['loom weave', '#8B5CF6'],
      ['loom eject', '#CE3F5C'],
    ].forEach(([command, colour]) => {
      expect(html).toContain(`>${command}<`)
      expect(html).toContain(`color: ${colour}`)
    })
  })

  it('gives weave a JSON picture and the other three their vendored drawings', () => {
    const html = render(at('home'))
    expect(html).toContain('class="px-json"')
    expect(html).toContain('class="tok-key"')
    expect(html.split('class="ops-svg"').length - 1).toBe(3)
    expect(html).not.toContain('class="tree"')
  })

  it('flashes copied only on the command that was pressed', () => {
    expect(render(at('home'))).not.toContain('ops-took shown')
    const html = render(at('home', { copied: 'loom weave' }))
    expect(html).toContain('class="ops-took shown"')
    expect(html.split('ops-took shown').length - 1).toBe(1)
  })

  it("corrects the mock's caption: init writes .loom, not loom", () => {
    expect(render(at('home'))).toContain('.loom directory')
  })

  it('names both neighbours in the site reading order', () => {
    const home = render(at('home'))
    expect(home).toContain('>Previous<')
    expect(home).toContain('class="pager-title">Community<')
    expect(home).toContain('>Next<')
    expect(home).toContain('class="pager-title">Why Loom<')
    const why = render(at('why-loom'))
    expect(why).toContain('class="pager-title">Loom<')
    expect(why).toContain('class="pager-title">Source<')
  })

  it('carries one card at each end of the order, not two', () => {
    const first = renderHtml((h) => pager('docs', h))
    expect(first).not.toContain('>Previous<')
    expect(first).toContain('class="pager-title">Community<')
    const last = renderHtml((h) => pager('source', h))
    expect(last).toContain('class="pager-title">Why Loom<')
    expect(last).not.toContain('>Next<')
  })

  it('hands each card the ink its destination is written in', () => {
    const home = render(at('home'))
    expect(home).toContain('--pg-ink: #6D3BD4')
    expect(home).toContain('--pg-ink: #C08A00')
  })

  it('mirrors the next card so the pair reads outward', () => {
    expect(render(at('home'))).toContain('class="pager-card next"')
  })
})

const css = readFileSync(resolve(__dirname, '../src/landing.css'), 'utf8')

const ruleFor = (selector: string): string => {
  const start = css.indexOf(`\n${selector} {`)
  expect(start).toBeGreaterThan(-1)
  return css.slice(start + 1, css.indexOf('}', start))
}

describe("the palette's pills", () => {
  it('lifts the focused pill further than the hovered one, and only it recolours', () => {
    const focused = ruleFor('.pill-link.here')
    expect(focused).toContain('rgba(242, 239, 230, 0.14)')
    expect(focused).toContain('#B9C4E8')
    expect(focused).toContain('color:')

    const hovered = ruleFor('.pill-link:hover')
    expect(hovered).toContain('rgba(242, 239, 230, 0.10)')
    expect(hovered).toContain('#8FA0D6')
    expect(/(?:^|;|\s)color:/.test(hovered)).toBe(false)
  })

  it('gives the menu links the chip the live nav wears, not a pill', () => {
    const link = ruleFor('.nav-link')
    expect(link).toContain('padding: 5px 8px')
    expect(link).toContain('transition: background-color .14s ease, color .14s ease')
    expect(ruleFor('.nav-link:hover,\n.nav-link.here')).toContain('var(--rule-faint)')
  })
})

describe('the box model, where it differs from the reset', () => {
  it('measures the pill and the key box the way live does', () => {
    ;['.pill-link', '.nav-key'].forEach((selector) =>
      expect(ruleFor(selector)).toContain('box-sizing: content-box'),
    )
  })

  it('leaves the vocabulary card and the example card on the reset', () => {
    ;['.mark-card', '.pl-card'].forEach((selector) =>
      expect(ruleFor(selector)).not.toContain('content-box'),
    )
  })
})

describe('the address of every page', () => {
  it('gives every route a path of its own', () => {
    const paths = ROUTES.map(pathOf)
    expect(paths).toEqual(['/', '/docs', '/why-loom', '/community', '/source', '/license'])
    expect(new Set(paths).size).toBe(ROUTES.length)
  })

  it('reads each path back to the route it came from, and no route from an unknown one', () => {
    ROUTES.forEach((route) => expect(routeOf(pathOf(route))).toEqual(Option.some(route)))
    expect(Option.isNone(routeOf('/nowhere'))).toBe(true)
  })
})
