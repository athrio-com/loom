import { Array, Match, Option, pipe } from 'effect'
import type { Html } from 'foldkit/html'
import { marked } from 'marked'
import {
  GotGameMessage,
  h,
  type Message,
  type Model,
  MovedFocus,
  SelectedLoomView,
  SelectedSection,
  SelectedTab,
  Typed,
} from './model'
import * as Gomoku from '../../examples/gomoku/gomoku'
import { loomIcon, playIcon } from './components'
import wovenCorpus from './gomoku.woven.json'
import highlighted from './gomoku.highlighted.json'

type AnchorLink = { readonly targetId: string; readonly offset: number; readonly length: number }
type Source = { readonly chapter: string; readonly section: string }

type Block =
  | { readonly type: 'heading'; readonly source: Source; readonly level: number; readonly title: string; readonly id: string }
  | { readonly type: 'prose'; readonly markdown: string }
  | { readonly type: 'code'; readonly source: Source; readonly language: string; readonly code: string; readonly links: ReadonlyArray<AnchorLink> }
  | { readonly type: 'note'; readonly markdown: string }

type Heading = Extract<Block, { type: 'heading' }>
type Code = Extract<Block, { type: 'code' }>
type Page = { readonly slug: string; readonly title: string; readonly blocks: ReadonlyArray<Block> }
type Highlighted = { readonly loomHtml: string; readonly tangledHtml: string; readonly codeHtml: ReadonlyArray<string> }

const page: Page = (wovenCorpus as unknown as { pages: ReadonlyArray<Page> }).pages[0]
const marks = highlighted as unknown as Highlighted

const isHeading = (block: Block): block is Heading => block.type === 'heading'
const isCode = (block: Block): block is Code => block.type === 'code'

const headings = pipe(page.blocks, Array.filter(isHeading))
const loomTitle = headings[0]
const sections = Array.filter(headings, (heading) => heading.level === 2)
const codeHtmlOf: ReadonlyMap<Code, string> = new Map(Array.zip(Array.filter(page.blocks, isCode), marks.codeHtml))

const sinkSections: ReadonlySet<string> = new Set(
  pipe(
    page.blocks,
    Array.filter(isCode),
    Array.filter((code) => code.links.length > 0),
    Array.map((code) => code.source.section),
  ),
)

const activeClass = (base: string, on: boolean): string =>
  on ? `${base} active` : base

const proseMarkup = (markdown: string): Html =>
  h.div([h.Class('how-prose'), h.InnerHTML(marked.parse(markdown) as string)], [])

const headingMarkup = (active: string) => (block: Heading): Html => {
  const label: ReadonlyArray<Html | string> = sinkSections.has(block.source.section)
    ? [block.title, h.span([h.Class('how-spec')], ['{Tangle}'])]
    : [block.title]
  return Match.value(block.level).pipe(
    Match.when(1, () =>
      h.h3([h.Class(activeClass('how-file-title', block.id === active)), h.Id(block.id)], label),
    ),
    Match.orElse(() =>
      h.h4([h.Class(activeClass('how-section-h', block.id === active)), h.Id(block.id)], label),
    ),
  )
}

const codeMarkup = (block: Code): Html =>
  h.div(
    [
      h.Class('how-code'),
      h.InnerHTML(Option.getOrElse(Option.fromNullishOr(codeHtmlOf.get(block)), () => '')),
    ],
    [],
  )

const blockView = (active: string) => (block: Block): Html =>
  Match.value(block).pipe(
    Match.when({ type: 'heading' }, headingMarkup(active)),
    Match.when({ type: 'prose' }, (prose) => proseMarkup(prose.markdown)),
    Match.when({ type: 'code' }, codeMarkup),
    Match.when({ type: 'note' }, (note) => proseMarkup(note.markdown)),
    Match.exhaustive,
  )

const outlineRow = (active: string) => (section: Heading): Html =>
  h.div(
    [h.Class(activeClass('how-outline-row', section.id === active)), h.OnClick(SelectedSection({ id: section.id }))],
    [section.title],
  )

const previewTab = (active: string): Html =>
  h.div(
    [h.Class('how-preview'), h.Key('preview')],
    [
      h.div([h.Class('how-scroll')], Array.map(page.blocks, blockView(active))),
      h.div(
        [h.Class('how-outline')],
        [
          h.div([h.Class('how-outline-head')], ['OUTLINE']),
          outlineRow(active)(loomTitle),
          ...Array.map(sections, outlineRow(active)),
        ],
      ),
    ],
  )

type TabId = 'loom' | 'tangled' | 'play'

const TABS: ReadonlyArray<{ readonly id: TabId; readonly label: string }> = [
  { id: 'loom', label: 'gomoku.loom' },
  { id: 'tangled', label: 'gomoku.ts' },
  { id: 'play', label: 'Play' },
]

const tabIcon = (id: TabId): Html =>
  Match.value(id).pipe(
    Match.when('loom', () => h.span([h.Class('ex-icon white')], [loomIcon()])),
    Match.when('tangled', () => h.span([h.Class('tab-badge white')], ['TS'])),
    Match.when('play', () => h.span([h.Class('ex-icon green')], [playIcon()])),
    Match.exhaustive,
  )

const tabClass = (id: TabId, active: TabId): string =>
  `ex-tab${id === active ? ' active' : ''}${id === 'play' ? ' play' : ''}`

const tabButton = (active: TabId) => (item: { readonly id: TabId; readonly label: string }): Html =>
  h.button(
    [h.Class(tabClass(item.id, active)), h.OnClick(SelectedTab({ tab: item.id }))],
    [tabIcon(item.id), item.label],
  )

const codeCanvas = (key: string, html: string): Html =>
  h.div([h.Class('how-scroll shiki-scroll'), h.Key(key), h.InnerHTML(html)], [])

type LoomView = 'preview' | 'source'

const loomToggleButton = (view: LoomView, label: string, active: LoomView): Html =>
  h.button(
    [
      h.Class(view === active ? 'loom-toggle-btn active' : 'loom-toggle-btn'),
      h.OnClick(SelectedLoomView({ view })),
    ],
    [label],
  )

const loomBody = (model: Model): Html =>
  Match.value(model.loomView).pipe(
    Match.when('preview', () => previewTab(model.activeSection)),
    Match.when('source', () => codeCanvas('source', marks.loomHtml)),
    Match.exhaustive,
  )

const loomPane = (model: Model): Html =>
  h.div(
    [h.Class('how-loom'), h.Key('loom')],
    [
      h.div(
        [h.Class('loom-toggle')],
        [
          loomToggleButton('preview', 'Preview', model.loomView),
          loomToggleButton('source', 'Source', model.loomView),
        ],
      ),
      loomBody(model),
    ],
  )

const tabBody = (model: Model): Html =>
  Match.value(model.exampleTab).pipe(
    Match.when('loom', () => loomPane(model)),
    Match.when('tangled', () => codeCanvas('tangled', marks.tangledHtml)),
    Match.when('play', () =>
      h.div(
        [h.Class('how-play'), h.Key('play')],
        [
          h.submodel({
            slotId: 'gomoku',
            model: model.game,
            view: Gomoku.view,
            toParentMessage: (message) => GotGameMessage({ message }),
          }),
        ],
      ),
    ),
    Match.exhaustive,
  )

const examplePanel = (model: Model): Html =>
  h.div(
    [h.Class('how-detail')],
    [
      h.div([h.Class('ex-tabs')], Array.map(TABS, tabButton(model.exampleTab))),
      h.div([h.Class('how-body')], [tabBody(model)]),
    ],
  )

type Command = {
  glyph: string
  label: string
  kind: string
  tags: ReadonlyArray<string>
}

const COMMANDS: ReadonlyArray<Command> = [
  { glyph: '§', label: 'A first loom', kind: 'chapter', tags: ['getting started', 'first', 'intro'] },
  { glyph: '§', label: 'The classifier stage', kind: 'chapter', tags: ['classifier', 'parser', 'weft'] },
  { glyph: '§', label: 'The tokeniser stage', kind: 'chapter', tags: ['tokeniser', 'parser', 'token'] },
  { glyph: '§', label: 'The product', kind: 'chapter', tags: ['product', 'compose', 'anchor'] },
  { glyph: '§', label: 'Tangling', kind: 'chapter', tags: ['tangle', 'output', 'source'] },
  { glyph: '¶', label: 'The shape of a loom', kind: 'part', tags: ['ast', 'shape', 'part'] },
  { glyph: '¶', label: 'Reading the text', kind: 'part', tags: ['parser', 'reading', 'part'] },
  { glyph: '¶', label: 'The editor', kind: 'part', tags: ['editor', 'volar', 'lsp'] },
  { glyph: '❯', label: 'loom tangle', kind: 'command', tags: ['tangle', 'cli', 'build'] },
  { glyph: '❯', label: 'loom weave', kind: 'command', tags: ['weave', 'site', 'docs'] },
  { glyph: '❯', label: 'loom init', kind: 'command', tags: ['new', 'init', 'scaffold'] },
  { glyph: '◈', label: '@athrio/loom', kind: 'package', tags: ['cli', 'package', 'npm'] },
  { glyph: '◈', label: '@athrio/loom-lang', kind: 'package', tags: ['lang', 'composition', 'package'] },
]

const matches =
  (query: string) =>
  (command: Command): boolean => {
    const f = query.trim().toLowerCase()
    return (
      f === '' ||
      command.label.toLowerCase().includes(f) ||
      command.tags.some((tag) => tag.includes(f)) ||
      command.kind.includes(f)
    )
  }

const highlightLabel = (label: string, query: string): ReadonlyArray<Html | string> => {
  const f = query.trim().toLowerCase()
  const at = f === '' ? -1 : label.toLowerCase().indexOf(f)
  if (at < 0) return [label]
  return [
    label.slice(0, at),
    h.span([h.Class('cmd-hi')], [label.slice(at, at + f.length)]),
    label.slice(at + f.length),
  ]
}

const keyToMessage = (key: string, count: number): Message =>
  Match.value(key).pipe(
    Match.when('ArrowDown', () => MovedFocus({ delta: 1, count })),
    Match.when('ArrowUp', () => MovedFocus({ delta: -1, count })),
    Match.orElse(() => MovedFocus({ delta: 0, count })),
  )

const commandRow = (query: string, focus: number) => (command: Command, index: number): Html =>
  h.div(
    [h.Class(index === focus ? 'cmd-item focused' : 'cmd-item')],
    [
      h.span([h.Class('cmd-glyph')], [command.glyph]),
      h.span([], highlightLabel(command.label, query)),
      h.span([h.Class('cmd-kind')], [command.kind]),
    ],
  )

const emptyRow = (): Html =>
  h.div(
    [h.Class('cmd-item'), h.Style({ color: 'var(--fg-4)', cursor: 'default' })],
    [
      h.span([], []),
      h.span([], ['no results · try "tangle" or "classifier"']),
      h.span([], []),
    ],
  )

const palette = (model: Model): Html => {
  const results = Array.filter(COMMANDS, matches(model.query))
  return h.div(
    [h.Class('cmd-wrap')],
    [
      h.div(
        [h.Class('cmd-input-wrap')],
        [
          h.span([h.Class('prompt')], ['⌘K']),
          h.input([
            h.Class('cmd-input'),
            h.Value(model.query),
            h.Placeholder('search chapters, parts, commands…'),
            h.OnInput((query) => Typed({ query })),
            h.OnKeyDown((key) => keyToMessage(key, results.length)),
          ]),
          h.span(
            [h.Style({ color: 'var(--fg-4)', fontFamily: 'var(--mono)', fontSize: '11px' })],
            ['try: tangle · classifier · weave'],
          ),
        ],
      ),
      h.div(
        [h.Class('cmd-list')],
        results.length === 0
          ? [emptyRow()]
          : Array.map(results, commandRow(model.query, model.focus)),
      ),
      h.div(
        [h.Class('cmd-foot')],
        [
          h.span(
            [],
            [
              h.kbd([], ['↑']), ' ', h.kbd([], ['↓']), ' navigate · ',
              h.kbd([], ['↵']), ' open · ', h.kbd([], ['esc']), ' close',
            ],
          ),
          h.span(
            [],
            [`${results.length} result${results.length === 1 ? '' : 's'}`],
          ),
        ],
      ),
    ],
  )
}

const howItWorks = (model: Model): Html =>
  h.section(
    [h.Class('s'), h.Id('how')],
    [
      h.div(
        [h.Class('wrap')],
        [
          h.div(
            [h.Class('sec-head')],
            [
              h.div(
                [h.Class('sec-num')],
                [h.span([h.Class('arrow')], ['▸']), ' 01 · HOW IT WORKS'],
              ),
              h.div(
                [],
                [
                  h.h2([h.Class('sec-h')], ['Built for reading by people.']),
                  h.p(
                    [h.Class('sec-lede')],
                    [
                      'A ',
                      h.code(
                        [h.Style({ fontFamily: 'var(--mono)', color: 'var(--acc-cyan)', fontSize: '0.92em' })],
                        ['.loom'],
                      ),
                      ' corpus is a set of files read in order, like chapters in a book. Open one and read it top to bottom: each section explains a piece in prose, then shows the code that piece becomes. The sections compose by name, and tangle resolves them into real source.',
                    ],
                  ),
                ],
              ),
            ],
          ),
          examplePanel(model),
        ],
      ),
    ],
  )

export const middle = (model: Model): Html => howItWorks(model)
