import { describe, expect, it } from 'bun:test'
import { Array, Option } from 'effect'
import { CHARACTERS, RUN, example, frameAt, struckBy, wholeDocument } from '../src/example'
import { fromInitToEject } from '../src/operations'
import { type Model, type Player } from '../src/model'
import { anchor, modelAt, renderHtml } from './render'

const at = (over: Partial<Player> = {}): Model =>
  modelAt({ player: { ...modelAt().player, ...over } })

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
    expect(html).toContain('id="loom-stage"')
  })

  it('has a run long enough to be a document and a clock that only goes forward', () => {
    expect(CHARACTERS).toBeGreaterThan(600)
    expect(RUN).toBeGreaterThan(0)
    expect(struckBy(0)).toBe(0)
    expect(struckBy(RUN)).toBe(CHARACTERS)
    const walked = [0, 0.1, 0.25, 0.5, 0.75, 1].map((part) => struckBy(part * RUN))
    Array.zip(walked, walked.slice(1)).forEach(([before, after]) =>
      expect(after).toBeGreaterThanOrEqual(before),
    )
  })

  it('stands the whole document on the card before anyone presses play', () => {
    const text = textOf(render(at()))
    expect(text).toContain('# Loom, explained in Loom')
    expect(text).toContain('Prose first.')
    expect(text).toContain("That's it.")
    expect(wholeDocument().length).toBe(frameAt(CHARACTERS, false).length)
  })

  it('carries the transport from the first frame, with no poster over it', () => {
    const resting = render(at())
    expect(resting).toContain('class="pl-bar"')
    expect(resting).not.toContain('pl-poster')
    expect(resting).not.toContain('class="pl-caret')
    expect(render(at({ playing: true, struck: 200, beat: 200 }))).toContain('class="pl-bar"')
  })

  it('carries the caret while it plays and drops it when it stops', () => {
    expect(render(at({ playing: true, struck: 200, beat: 200 }))).toContain('class="pl-caret')
    expect(render(at({ struck: 200, beat: 200 }))).not.toContain('class="pl-caret')
  })

  it('runs the bar along the foot of the card in step with the clock', () => {
    expect(render(at())).toContain('--pl-run: 0%')
    expect(render(at())).toContain('class="pl-run"')
    expect(render(at({ struck: CHARACTERS, beat: RUN }))).toContain('--pl-run: 100%')
    expect(render(at({ playing: true, struck: 200, beat: 200 }))).toContain('pl-card running')
  })

  it('grows the card to full height and offers the button that gives the page back', () => {
    const resting = render(at())
    expect(resting).toContain('class="pl-hold"')
    expect(resting).toContain('title="Full height"')
    const grown = render(at({ full: true }))
    expect(grown).toContain('class="pl-hold full"')
    expect(grown).toContain('title="Leave full height"')
    expect(grown).toContain('class="pl-card open"')
  })

  it('offers the two commands to a reader who grew the card and stopped partway', () => {
    expect(render(at({ struck: 200, beat: 200, full: true }))).toContain('class="pl-outs"')
    expect(render(at({ struck: 200, beat: 200, full: true, playing: true }))).not.toContain(
      'class="pl-outs"',
    )
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
    expect(textOf(woven)).toContain('\\n  return `Hello, ${who}`')
    expect(woven).not.toContain('class="pl-result tangle"')
  })

  it('types the whole document out by the end, marks and all', () => {
    const text = textOf(render(at({ struck: CHARACTERS, beat: RUN })))
    ;['# Loom, explained in Loom', '## Greeting', '=>', '~', '[hello.ts]', "That's it."].forEach(
      (mark) => expect(text).toContain(mark),
    )
    expect(text).toContain(anchor('Greeting'))
    expect(text).toContain(anchor('Run it'))
  })

  it('reveals the document a line at a time rather than all at once', () => {
    const early = frameAt(struckBy(RUN * 0.2), true).length
    const late = frameAt(struckBy(RUN * 0.8), true).length
    expect(early).toBeGreaterThan(0)
    expect(late).toBeGreaterThan(early)
  })
})

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
    expect(html.split('repeatCount="indefinite"').length - 1).toBeGreaterThan(1)
    expect(html).toContain('dur="6.2s"')
    expect(html).toContain('ARCHIVED')
  })

  it('namespaces each drawing so their filters never resolve against each other', () => {
    ;['in-drop', 'tg-drop', 'ej-drop', 'ej-lid'].forEach((id) => expect(html).toContain(`id="${id}"`))
  })
})
