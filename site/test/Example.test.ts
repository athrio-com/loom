import { describe, expect, it } from 'bun:test'
import { Option } from 'effect'
import { CHARACTERS, RUN, example, frameAt, struckBy, wholeDocument } from '../src/example'
import { fromInitToEject } from '../src/operations'
import { type Model, type Player } from '../src/model'
import { renderHtml } from './render'

// The example is a replay, so the cases that matter are about the clock rather than the
// markup: the run has to be monotonic, the document has to stand whole on the card before
// the first press, and the transport has to be there from the first frame. The typing
// itself is deterministic, so a frame count is a fair assertion.
const player = (over: Partial<Player> = {}): Player => ({
  struck: 0,
  beat: 0,
  playing: false,
  output: Option.none(),
  full: false,
  ...over,
})

const at = (over: Partial<Player> = {}): Model =>
  ({
    route: 'home', chapter: '', drawerOpen: false, runtime: 'bun',
    searchOpen: false, caret: 0, searching: false,
    activeSection: '',
    player: player(over), version: '0.0.9',
    query: '', focus: 0, copied: '',
  }) as Model

const render = (model: Model): string => renderHtml((h) => example(model, h))

const textOf = (html: string): string =>
  html
    .replace(/<[^>]+>/g, '')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')

describe('the document being typed', () => {
  it('leads with its own head, on a stage the client can scroll', () => {
    const html = render(at())
    expect(html).toContain('id="loom-example"')
    expect(html).toContain('Literate programming')
    expect(html).toContain('A Loom document, written out')
    // the client scrolls this element by id as the caret runs down it
    expect(html).toContain('id="loom-stage"')
  })

  it('has a run long enough to be a document and a clock that only goes forward', () => {
    expect(CHARACTERS).toBeGreaterThan(600)
    expect(RUN).toBeGreaterThan(0)
    expect(struckBy(0)).toBe(0)
    expect(struckBy(RUN)).toBe(CHARACTERS)
    const walked = [0, 0.1, 0.25, 0.5, 0.75, 1].map((part) => struckBy(part * RUN))
    walked.forEach((count, index) => {
      if (index > 0) {
        expect(count).toBeGreaterThanOrEqual(walked[index - 1]!)
      }
    })
  })

  it('stands the whole document on the card before anyone presses play', () => {
    const text = textOf(render(at()))
    expect(text).toContain('# Loom, explained in Loom')
    expect(text).toContain('Prose first.')
    // the last line of the document is there too — nothing is being withheld
    expect(text).toContain("That's it.")
    expect(wholeDocument().length).toBe(frameAt(CHARACTERS, false).length)
  })

  it('carries the transport from the first frame, with no poster over it', () => {
    const resting = render(at())
    expect(resting).toContain('class="pl-bar"')
    expect(resting).not.toContain('pl-poster')

    // and the caret only rides the document once it is playing
    expect(resting).not.toContain('class="pl-caret')
    expect(render(at({ playing: true, struck: 200, beat: 200 }))).toContain('class="pl-bar"')
  })

  it('grows the card to full height and offers the button that gives the page back', () => {
    const resting = render(at())
    expect(resting).toContain('class="pl-hold"')
    expect(resting).toContain('title="Full height"')

    const grown = render(at({ full: true }))
    expect(grown).toContain('class="pl-hold full"')
    expect(grown).toContain('title="Leave full height"')
    // grown and stopped, the stage takes its own scroll back from the run
    expect(grown).toContain('class="pl-card open"')
  })

  it('offers the two commands to a reader who grew the card and stopped partway', () => {
    expect(render(at({ struck: 200, beat: 200, full: true }))).toContain('class="pl-outs"')
    // but not while it is still typing — the document is not there to study yet
    expect(render(at({ struck: 200, beat: 200, full: true, playing: true }))).not.toContain(
      'class="pl-outs"',
    )
  })

  it('carries the caret while it plays and drops it when it stops', () => {
    expect(render(at({ playing: true, struck: 200, beat: 200 }))).toContain('class="pl-caret')
    expect(render(at({ struck: 200, beat: 200 }))).not.toContain('class="pl-caret')
  })

  it('runs the bar along the foot of the card in step with the clock', () => {
    expect(render(at())).toContain('--pl-run: 0%')
    expect(render(at())).toContain('class="pl-run"')
    expect(render(at({ struck: CHARACTERS, beat: RUN }))).toContain('--pl-run: 100%')
    // the bar only eases between frames while the run is driving it
    expect(render(at({ playing: true, struck: 200, beat: 200 }))).toContain('pl-card running')
  })

  it('offers the two commands only once the document is finished', () => {
    expect(render(at({ struck: 200, beat: 200 }))).not.toContain('class="pl-outs"')

    const done = render(at({ struck: CHARACTERS, beat: RUN }))
    expect(done).toContain('$ loom tangle')
    expect(done).toContain('writes hello.ts')
    expect(done).toContain('$ loom weave')
    expect(done).toContain('writes hello.woven.json')
    expect(done).toContain('class="pl-skip gone"')
  })

  it('drops the file a pressed command writes, and only that one', () => {
    const tangled = render(at({ struck: CHARACTERS, beat: RUN, output: Option.some('tangle') }))
    expect(tangled).toContain('class="pl-result tangle"')
    expect(textOf(tangled)).toContain('export function greet(who: string) {')
    expect(textOf(tangled)).not.toContain('"blocks"')

    const woven = render(at({ struck: CHARACTERS, beat: RUN, output: Option.some('weave') }))
    expect(woven).toContain('class="pl-result weave"')
    expect(textOf(woven)).toContain('"blocks"')
    // the greeting appears inside the weave too, but escaped into a JSON string field
    expect(textOf(woven)).toContain('\\n  return `Hello, ${who}`')
    expect(woven).not.toContain('class="pl-result tangle"')
  })

  it('types the whole document out by the end, marks and all', () => {
    const text = textOf(render(at({ struck: CHARACTERS, beat: RUN })))
    ;['# Loom, explained in Loom', '## Greeting', '=>', '~', '[hello.ts]', "That's it."].forEach(
      (mark) => expect(text).toContain(mark),
    )
    // the two anchors compose the file, and they are written the way a loom writes them
    expect(text).toContain('::[Greeting]')
    expect(text).toContain('::[Run it]')
  })

  it('reveals the document a line at a time rather than all at once', () => {
    const early = frameAt(struckBy(RUN * 0.2), true).length
    const late = frameAt(struckBy(RUN * 0.8), true).length
    expect(early).toBeGreaterThan(0)
    expect(late).toBeGreaterThan(early)
  })
})


// The two moving command illustrations share one 6.2s clock. Both are pure readings of it,
// so the timings are testable without a browser. The numbers come from Loom Landing.dc.html:
// tangle lands a row at 300/620/940/1260/1580, and eject runs 400 → 1500 → 3200 with the
// first two clearing at 3750 and the last at 4800.

// Ejecting is the one illustration whose parts do different things at the same instant, so
// these render it at each stage and assert what moved. The four documents fly one row's
// height further for each step down the list; the folder never flies, it opens then leaves.

// The two stages the first pass missed. Hand-back is the one that matters most: without it
// the reset at 3750ms happens in plain sight, which is what made the loop look broken.

// Ejecting is a vendored SMIL loop rather than a built illustration, so what is worth
// pinning is that the card still wears the same frame as its neighbours and that the loop
// really is self-driving — no clock, no scroll gate, nothing for the model to get wrong.

// Every illustration on the CLI card row is now a vendored SVG that drives itself. What is
// worth pinning is that each card wears the same frame, that the loops really are
// self-contained, and that nothing on this page is waiting for a clock in the model.
describe('the command illustrations', () => {
  const html = renderHtml((h) => fromInitToEject(at(), h))

  it('gives all four commands the same frame', () => {
    expect(html.split('class="ops-frame"').length - 1).toBe(4)
  })

  it('draws three of them as self-driving SVGs and weave as JSON', () => {
    expect(html.split('class="ops-svg"').length - 1).toBe(3)
    expect(html).toContain('class="px-json"')
  })

  it('loops tangling and ejecting on the same period, and leaves init still', () => {
    // two of the three carry SMIL; init is a drawing with nothing animated in it
    expect(html.split('repeatCount="indefinite"').length - 1).toBeGreaterThan(1)
    expect(html).toContain('dur="6.2s"')
    expect(html).toContain('ARCHIVED')
  })

  it('namespaces each drawing so their filters never resolve against each other', () => {
    ;['in-drop', 'tg-drop', 'ej-drop', 'ej-lid'].forEach((id) =>
      expect(html).toContain(`id="${id}"`),
    )
  })
})
