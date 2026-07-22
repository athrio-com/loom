import { Array, Match } from 'effect'
import type { Html } from 'foldkit/html'
import {
  copyButton,
  bookIcon,
  externalIcon,
  arrowIcon,
  bunIcon,
  denoIcon,
  npmIcon,
  pnpmIcon,
} from './components'
import { h, type Model } from './model'

export const ROTATOR_WORDS = ['a book', 'an article', 'a spec']

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
      h.span([h.Class('hl-1')], ['Write your program']),
      h.br([]),
      h.span([h.Class('hl-2')], [`the way you write`]),
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

type Runtime = {
  readonly id: string
  readonly command: string
  readonly icon: Html
}

const RUNTIMES: ReadonlyArray<Runtime> = [
  { id: 'bun', command: 'bun add -g @athrio/loom', icon: bunIcon() },
  { id: 'deno', command: 'deno install -g -n loom npm:@athrio/loom', icon: denoIcon() },
  { id: 'npm', command: 'npm install -g @athrio/loom', icon: npmIcon() },
  { id: 'pnpm', command: 'pnpm add -g @athrio/loom', icon: pnpmIcon() },
]

const installRow = (copied: string) => (runtime: Runtime): Html =>
  h.div(
    [h.Class('install-row')],
    [
      h.span([h.Class('rt-mark')], [runtime.icon]),
      h.code([h.Class('rt-cmd')], [runtime.command]),
      copyButton({ id: `install-${runtime.id}`, text: runtime.command, copied }),
    ],
  )

const initRow = (copied: string): Html =>
  h.div(
    [h.Class('init-row')],
    [
      h.div(
        [h.Class('install-row')],
        [
          h.span([h.Class('rt-mark then')], [arrowIcon()]),
          h.code([h.Class('rt-cmd')], ['loom init']),
          copyButton({ id: 'loom-init', text: 'loom init', copied }),
        ],
      ),
      h.div(
        [h.Class('rt-note')],
        ['Scaffolds a Loom workspace in the current directory.'],
      ),
    ],
  )

const installRows = (model: Model): Html =>
  h.div(
    [h.Class('install-rows')],
    [...Array.map(RUNTIMES, installRow(model.copied)), initRow(model.copied)],
  )

const metaRow = (version: string): Html =>
  h.div(
    [h.Class('meta-row')],
    [
      h.span(
        [h.Class('pill')],
        [h.span([h.Class('gh')], ['~']), ` loom · v${version}`],
      ),
      h.span([], ['Built with Loom']),
    ],
  )

export const hero = (model: Model): Html =>
  h.section(
    [h.Class('hero')],
    [
      h.div(
        [h.Class('wrap')],
        [
          h.div(
            [h.Class('hero-col')],
            [
              metaRow(model.version),
              headline(model),
              installRows(model),
              h.div(
                [h.Class('actions hero-cta')],
                [
                  h.a(
                    [h.Class('btn primary'), h.Href('#')],
                    ['Read the docs', bookIcon()],
                  ),
                  h.a(
                    [h.Class('btn'), h.Href('#')],
                    ['Browse the source', externalIcon()],
                  ),
                ],
              ),
            ],
          ),
        ],
      ),
    ],
  )
