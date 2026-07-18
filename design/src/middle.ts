import { Array, Match } from 'effect'
import type { Html } from 'foldkit/html'
import { h, type Message, type Model, MovedFocus, SelectedStep, Typed } from './model'

type Step = {
  file: string
  lines: number
  num: string
  heading: string
  body: string
  code: string
}

const anchorMark = '::' + '['

const STEPS: ReadonlyArray<Step> = [
  {
    file: 'corpus/01-write.loom',
    lines: 24,
    num: 'STEP 01 · WRITE',
    heading: 'Prose and code, in one file.',
    body: 'A section is a heading, the prose that explains it, and the code it describes — kept in the order a person reads, not the order the compiler needs.',
    code: '# A friendly greeting\nA greeter turns a name into a line.\n\n=> greet\nexport const greet = (name) =>\n  `Hello, ${name}.`',
  },
  {
    file: 'corpus/02-compose.loom',
    lines: 31,
    num: 'STEP 02 · COMPOSE',
    heading: 'Compose by name, not by paste.',
    body: `A section draws in another with a ${anchorMark}…] anchor. The product pass resolves every anchor and assembles the sections into one whole — nothing is copied, nothing drifts.`,
    code: `# The module\n${anchorMark}imports]\n${anchorMark}greet]\n${anchorMark}export]\n\n→ one file, composed by name`,
  },
  {
    file: 'corpus/03-tangle.loom',
    lines: 18,
    num: 'STEP 03 · TANGLE',
    heading: 'Tangle it into real source.',
    body: 'A {Tangle} section binds the composed code to a path. loom tangle writes plain source to disk — TypeScript, Bash, JSON — and the prose leaves no trace.',
    code: '$ loom tangle\n✓ src/greeter.ts       17 lines\n✓ src/classifier.ts    58 lines\n→ prose left no trace',
  },
  {
    file: 'corpus/04-read.loom',
    lines: 22,
    num: 'STEP 04 · READ',
    heading: 'Read the whole thing as a book.',
    body: 'loom weave projects the corpus into a documentation site — parts, chapters, and code you can navigate. The program and the book are one source.',
    code: '$ loom weave\n✓ 10 parts · 51 chapters\n→ serving the book at :4321',
  },
]

const treeRow = (step: Step, index: number, active: number): Html =>
  h.div(
    [
      h.Class(
        index + 1 === active
          ? 'tree-row tree-indent active'
          : 'tree-row tree-indent',
      ),
      h.OnClick(SelectedStep({ step: index + 1 })),
    ],
    [
      h.span([h.Class('tree-bullet')], []),
      step.file.replace('corpus/', ''),
      h.span([h.Class('tree-meta')], [`∙ ${step.lines} lines`]),
    ],
  )

const tangledRow = (name: string): Html =>
  h.div(
    [h.Class('tree-row tree-indent'), h.Style({ color: 'var(--fg-3)' })],
    [h.span([h.Class('tree-bullet')], []), name],
  )

const fileTree = (model: Model): Html =>
  h.div(
    [h.Class('file-tree')],
    [
      h.div(
        [h.Class('panel-head')],
        [
          h.span([h.Class('dot'), h.Style({ background: 'var(--acc-cyan)' })], []),
          h.span([], ['EXPLORER']),
          h.span([h.Class('right')], ['loom · main']),
        ],
      ),
      h.div(
        [h.Class('tree-list')],
        [
          h.div(
            [h.Class('tree-row dir')],
            [h.span([h.Class('tree-bullet')], []), 'corpus/'],
          ),
          ...Array.map(STEPS, (step, index) => treeRow(step, index, model.howStep)),
          h.div(
            [h.Class('tree-row dir'), h.Style({ marginTop: '10px' })],
            [h.span([h.Class('tree-bullet')], []), 'tangled/'],
          ),
          tangledRow('greeter.ts'),
          tangledRow('classifier.ts'),
          tangledRow('index.ts'),
        ],
      ),
    ],
  )

const stepDetail = (model: Model): Html => {
  const step = STEPS[model.howStep - 1] ?? STEPS[0]
  return h.div(
    [h.Class('how-detail')],
    [
      h.div(
        [h.Class('panel-head')],
        [
          h.span([h.Class('dot')], []),
          h.span([], [step.file]),
          h.span([h.Class('right')], ['read-only · preview']),
        ],
      ),
      h.div(
        [h.Class('how-body')],
        [
          h.div(
            [],
            [
              h.div([h.Class('how-step-num')], [step.num]),
              h.h3([h.Class('how-step-h')], [step.heading]),
              h.p([h.Class('how-step-p')], [step.body]),
            ],
          ),
          h.div(
            [h.Class('how-snippet')],
            [
              h.span([h.Style({ color: 'var(--fg-4)' })], ['// preview']),
              `\n${step.code}`,
            ],
          ),
        ],
      ),
    ],
  )
}

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
  { glyph: '❯', label: 'loom new', kind: 'command', tags: ['new', 'init', 'scaffold'] },
  { glyph: '◈', label: '@athrio/loom-cli', kind: 'package', tags: ['cli', 'package', 'npm'] },
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
                  h.h2([h.Class('sec-h')], ['Written to be read.']),
                  h.p(
                    [h.Class('sec-lede')],
                    [
                      'A ',
                      h.code(
                        [h.Style({ fontFamily: 'var(--mono)', color: 'var(--acc-cyan)', fontSize: '0.92em' })],
                        ['.loom'],
                      ),
                      ' corpus is a set of files written to be read in order, like chapters in a book. Open one and follow it through: prose and code side by side, sections composed by name, then tangled into real source.',
                    ],
                  ),
                ],
              ),
            ],
          ),
          h.div([h.Class('how-grid')], [fileTree(model), stepDetail(model)]),
          palette(model),
        ],
      ),
    ],
  )

export const middle = (model: Model): Html => howItWorks(model)
