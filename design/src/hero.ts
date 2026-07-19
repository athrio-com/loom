import { Array, Match } from 'effect'
import type { Html } from 'foldkit/html'
import { copyButton, bookIcon, externalIcon } from './components'
import { h, type Model, SelectedPackageManager } from './model'

export const ROTATOR_WORDS = ['a book', 'an article', 'a prompt']

const rotatorClass = (phase: Model['rotatorPhase']): string =>
  Match.value(phase).pipe(
    Match.when('out', () => 'rotator-word out'),
    Match.when('in-start', () => 'rotator-word in-start'),
    Match.orElse(() => 'rotator-word'),
  )

const headline = (model: Model): Html =>
  h.h1(
    [h.Class('loom-h')],
    [
      h.span([h.Class('hl-1')], ['Write programs']),
      h.br([]),
      h.span([h.Class('hl-2')], [`the way you'd write`]),
      h.br([]),
      h.span(
        [h.Class('rotator-host hl-3'), h.AriaLive('polite')],
        [
          h.span(
            [h.Class(rotatorClass(model.rotatorPhase))],
            [ROTATOR_WORDS[model.rotatorIndex] ?? ROTATOR_WORDS[0]],
          ),
        ],
      ),
      h.span([h.Class('caret'), h.AriaHidden(true)], []),
    ],
  )

const PACKAGE_MANAGERS = ['npm', 'pnpm', 'yarn', 'bun'] as const

const installCommand = (packageManager: Model['packageManager']): string =>
  Match.value(packageManager).pipe(
    Match.when('npm', () => 'npm install -g @athrio/loom'),
    Match.when('pnpm', () => 'pnpm add -g @athrio/loom'),
    Match.when('yarn', () => 'yarn global add @athrio/loom'),
    Match.when('bun', () => 'bun add -g @athrio/loom'),
    Match.exhaustive,
  )

const packageManagerTabs = (model: Model): Html =>
  h.div(
    [h.Class('pm-tabs')],
    Array.map(PACKAGE_MANAGERS, (packageManager) =>
      h.button(
        [
          h.Class(packageManager === model.packageManager ? 'pm-tab active' : 'pm-tab'),
          h.OnClick(SelectedPackageManager({ packageManager })),
        ],
        [packageManager],
      ),
    ),
  )

const pitch = (model: Model): Html =>
  h.div(
    [],
    [
      h.div(
        [h.Class('meta-row')],
        [
          h.span(
            [h.Class('pill')],
            [h.span([h.Class('gh')], ['~']), ' loom · v0.9.0'],
          ),
          h.span([], ['literate programming · open source']),
        ],
      ),
      headline(model),
      h.p(
        [h.Class('lede')],
        [
          'Loom is an AI-friendly framework where specifications and code do not drift apart ',
          h.span([h.Class('tok-str')], ['— because prose is the program']),
          '.',
        ],
      ),
      h.div(
        [h.Class('actions')],
        [
          h.div(
            [h.Class('cmd-line'), h.Title('Copy the install command')],
            [
              h.span([h.Class('prompt')], ['$']),
              h.code([], [installCommand(model.packageManager)]),
              copyButton({
                id: 'install',
                text: installCommand(model.packageManager),
                copied: model.copied,
              }),
            ],
          ),
        ],
      ),
      h.div(
        [h.Class('actions'), h.Style({ marginTop: '16px' })],
        [
          h.a(
            [h.Class('btn primary'), h.Href('#')],
            ['Read the book', bookIcon()],
          ),
          h.a(
            [h.Class('btn'), h.Href('#')],
            ['Browse the source', externalIcon()],
          ),
        ],
      ),
    ],
  )

const qsLine = (id: string, command: string, copied: string): Html =>
  h.div(
    [h.Class('qs-line')],
    [
      h.span([h.Class('qs-prompt')], ['$']),
      h.code([], [command]),
      copyButton({ id, text: command, copied }),
    ],
  )

const quickstart = (model: Model): Html =>
  h.div(
    [h.Class('quickstart')],
    [
      packageManagerTabs(model),
      qsLine('qs-install', installCommand(model.packageManager), model.copied),
      qsLine('qs-new', 'loom init greeter', model.copied),
      qsLine('qs-tangle', 'loom tangle', model.copied),
      h.div(
        [h.Class('qs-out')],
        [
          h.span([h.Class('ok')], ['✓']),
          ' wrote ',
          h.span([h.Class('path')], ['src/greeter.ts']),
          ' — prose left no trace.',
        ],
      ),
    ],
  )

export const hero = (model: Model): Html =>
  h.section(
    [h.Class('hero')],
    [
      h.div(
        [h.Class('wrap')],
        [h.div([h.Class('hero-grid')], [pitch(model), quickstart(model)])],
      ),
    ],
  )
