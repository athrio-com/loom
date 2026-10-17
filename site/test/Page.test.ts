import '../src/browser-globals'
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Effect, Layer, ManagedRuntime, Option } from 'effect'
import { renderStatic } from 'foldkit/html'
import { FoldkitRender } from '@athrio/foldkit-ssr'
import { view } from '../src/view'
import { pager } from '../src/chrome'
import { type Model, pathOf, type Route, routeOf } from '../src/model'

// The router is the one place a broken link becomes a compile error rather than a 404, so
// these cases render every route through the real SSR path — the same path the server uses.
const at = (route: Route, over: Partial<Model> = {}): Model =>
  ({
    route, chapter: '', navHidden: false, drawerOpen: false, runtime: 'bun',
    searchOpen: false, caret: 0, searching: false,
    activeSection: '',
    player: { struck: 0, beat: 0, playing: false, output: Option.none(), full: false }, version: '0.0.9',
    query: '', focus: 0, copied: '',
    ...over,
  }) as Model

const runtime = ManagedRuntime.make(FoldkitRender.layer as Layer.Layer<FoldkitRender>)

const renderHtml = (node: () => ReturnType<typeof pager>): string =>
  runtime.runSync(
    FoldkitRender.pipe(Effect.flatMap((r) => r.renderToString(renderStatic(node)))),
  )

const render = (model: Model): string => renderHtml(() => view(model).body)

const ROUTES: ReadonlyArray<Route> = ['home', 'docs', 'why-loom', 'community', 'source']

describe('the page', () => {
  it('renders every route without throwing, and ends each on the footer', () => {
    ROUTES.forEach((route) => {
      const html = render(at(route))
      expect(html.length).toBeGreaterThan(500)
      expect(html).toContain('class="footer"')
    })
  })

  it('titles each route for itself rather than repeating the site name', () => {
    const titles = ROUTES.map((route) => view(at(route)).title)
    expect(new Set(titles).size).toBe(ROUTES.length)
    expect(view(at('home')).title).toContain('literate programming')
  })

  it('gives the marketing pages the centred nav and the docs its own bar', () => {
    expect(render(at('home'))).toContain('class="nav"')
    expect(render(at('home'))).not.toContain('class="docs-bar"')
    expect(render(at('docs'))).toContain('class="docs-bar"')
    expect(render(at('docs'))).not.toContain('class="nav"')
  })

  it('puts the hero and its install line on the landing', () => {
    const html = render(at('home'))
    expect(html).toContain('Literate programming framework for AI-assisted engineering')
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
    expect(html).toContain('class="docs-rail"')
    expect(html).toContain('<h1 id="installation">Installation</h1>')
  })

  it('says plainly which pages are still being written', () => {
    ;(['why-loom', 'community', 'source'] as ReadonlyArray<Route>).forEach((route) => {
      expect(render(at(route))).toContain('Being written')
    })
  })

  it('shows the whole vocabulary on the landing, all eight marks', () => {
    const html = render(at('home'))
    expect(html).toContain('The whole vocabulary')
    expect(html).toContain('Loom syntax')
    // one card per mark, one layout — the table and the deck are gone
    const glyphs = html.split('class="mark-glyph"').length - 1
    expect(glyphs).toBe(8)
    ;['Frontmatter', 'Section', 'Warp', 'Sink', 'Specifier', 'Arrow', 'Tilde', 'Anchor'].forEach(
      (name) => expect(html).toContain(`class="mark-name">${name}<`),
    )
  })

  it('derives each glyph chip wash from the mark\'s own colour', () => {
    const html = render(at('home'))
    expect(html).toContain('color: #8B5CF6; background: #8B5CF61F')
    expect(html).toContain('color: #00996B; background: #00996B1F')
  })

  it('gives a 42px section mark the broad seam and its 1px inset, and the 17px glyphs neither', () => {
    const home = render(at('home'))
    expect(home).toContain('calc(100% / 7 + 0.8px)')
    expect(home).toContain('background-origin: content-box')
    // the palette's 17px glyphs take the fine seam, with no inset to spill into
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
    // init, tangle and eject are self-contained SVGs; only weave is built from elements
    expect(html.split('class="ops-svg"').length - 1).toBe(3)
    expect(html).not.toContain('class="tree"')
  })

  it('flashes copied only on the command that was pressed', () => {
    expect(render(at('home'))).not.toContain('ops-took shown')
    const html = render(at('home', { copied: 'loom weave' }))
    expect(html).toContain('class="ops-took shown"')
    expect(html.split('ops-took shown').length - 1).toBe(1)
  })

  it('corrects the mock\'s caption: init writes .loom, not loom', () => {
    expect(render(at('home'))).toContain('.loom directory')
  })

  it('names both neighbours in the site reading order', () => {
    // docs → community → home → why-loom → source
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
    // tested on the pager itself: the docs route wears variant B, which is not built yet
    const first = renderHtml(() => pager('docs'))
    expect(first).not.toContain('>Previous<')
    expect(first).toContain('class="pager-title">Community<')
    const last = renderHtml(() => pager('source'))
    expect(last).toContain('class="pager-title">Why Loom<')
    expect(last).not.toContain('>Next<')
  })

  it('hands each card the ink its destination is written in', () => {
    // one colour per card now, deep enough to hold on paper — the card draws no box at all
    const home = render(at('home'))
    expect(home).toContain('--pg-ink: #6D3BD4')
    expect(home).toContain('--pg-ink: #C08A00')
  })

  it('mirrors the next card so the pair reads outward', () => {
    expect(render(at('home'))).toContain('class="pager-card next"')
  })
})

// The palette's pills carry two states the live design keeps apart: the one the arrow keys
// are on, and the one the mouse is over. Collapsing them into a single rule is the mistake
// this guards — a hovered pill must not look like the focused one, or the row stops saying
// which pill Enter would open. The values come from Site Nav.dc.html.
describe("the palette's pills", () => {
  const css = readFileSync(resolve(__dirname, '../src/landing.css'), 'utf8')
  const ruleFor = (selector: string): string => {
    const at = css.indexOf(`${selector} {`)
    expect(at).toBeGreaterThan(-1)
    return css.slice(at, css.indexOf('}', at))
  }

  it('lifts the focused pill further than the hovered one, and only it recolours', () => {
    const focused = ruleFor('.pill-link.here')
    expect(focused).toContain('rgba(242, 239, 230, 0.14)')
    expect(focused).toContain('#B9C4E8')
    expect(focused).toContain('color:')

    const hovered = ruleFor('.pill-link:hover')
    expect(hovered).toContain('rgba(242, 239, 230, 0.10)')
    expect(hovered).toContain('#8FA0D6')
    // hover leaves the label alone, so the focused pill stays the brightest one
    expect(/(?:^|;|\s)color:/.test(hovered)).toBe(false)
  })

  it('gives the menu links the chip the live nav wears, not a pill', () => {
    const link = ruleFor('.nav-link')
    expect(link).toContain('padding: 5px 8px')
    expect(link).toContain('transition: background-color .14s ease, color .14s ease')
    expect(ruleFor('.nav-link:hover,\n.nav-link.here')).toContain('var(--rule-faint)')
  })
})

// The stylesheet resets everything to border-box; the live design does not, and declares
// border-box per element instead. Anything sized in live without that declaration has to
// opt back out here, or its border eats into the size and it comes out short. These two
// are the whole set — the sweep that found them is in the chapter's prose.
describe('the box model, where it differs from the reset', () => {
  const css = readFileSync(resolve(__dirname, '../src/landing.css'), 'utf8')
  const ruleFor = (selector: string): string => {
    const at = css.indexOf(`${selector} {`)
    expect(at).toBeGreaterThan(-1)
    return css.slice(at, css.indexOf('}', at))
  }

  it('measures the pill and the key box the way live does', () => {
    ;['.pill-link', '.nav-key'].forEach((selector) =>
      expect(ruleFor(selector)).toContain('box-sizing: content-box'),
    )
  })

  it('leaves the vocabulary card and the example card on the reset', () => {
    // the example card carries no border of its own any more, so the reset costs it nothing
    ;['.mark-card', '.pl-card'].forEach((selector) =>
      expect(ruleFor(selector)).not.toContain('content-box'),
    )
  })
})

describe('the address of every page', () => {
  const routes: ReadonlyArray<Route> = ['home', 'docs', 'why-loom', 'community', 'source']

  it('gives every route a path of its own', () => {
    const paths = routes.map(pathOf)
    expect(paths).toEqual(['/', '/docs', '/why-loom', '/community', '/source'])
    expect(new Set(paths).size).toBe(routes.length)
  })

  it('reads each path back to the route it came from, and no route from an unknown one', () => {
    routes.forEach((route) => expect(routeOf(pathOf(route))).toEqual(Option.some(route)))
    expect(Option.isNone(routeOf('/nowhere'))).toBe(true)
  })
})
