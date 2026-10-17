import { Array, Option, pipe } from 'effect'
import type { Html } from 'foldkit/html'
import {
  Copied,
  PickedRuntime,
  WentTo,
  h,
  type Model,
  type Runtime,
} from './model'
import {
  bunIcon,
  loomMark,
  npmIcon,
  pnpmIcon,
} from './components'

const wordmark = (): Html =>
  h.div(
    [h.Class('hero-mark')],
    [
      loomMark('paper', 1.2),
      h.div([h.Class('hero-word')], ['Loom']),
    ],
  )

const claim = (): Html =>
  h.div(
    [h.Class('hero-claim')],
    [
      h.h1([], ['Literate programming framework for AI-assisted engineering']),
      h.p(
        [h.Class('hero-lead')],
        [
          'Write your program the way you write a book. You write the reasoning in prose and the code beneath it, in the order you thought of it. ',
          h.span([h.Class('hero-cmd')], ['loom tangle']),
          ' resolves the sections and writes the real files.',
        ],
      ),
    ],
  )

type Install = {
  readonly runtime: Runtime
  readonly label: string
  readonly command: string
  readonly logo: Html
}

const installs: ReadonlyArray<Install> = [
  { runtime: 'bun', label: 'bun', command: 'bun add -g @athrio/loom', logo: bunIcon() },
  { runtime: 'npm', label: 'npm', command: 'npm install -g @athrio/loom', logo: npmIcon() },
  { runtime: 'pnpm', label: 'pnpm', command: 'pnpm add -g @athrio/loom', logo: pnpmIcon() },
]

const commandFor = (runtime: Runtime): string =>
  pipe(
    Array.findFirst(installs, (install) => install.runtime === runtime),
    Option.map((install) => install.command),
    Option.getOrElse(() => ''),
  )

const runtimeTab = (install: Install, here: boolean): Html =>
  h.button(
    [
      h.Class(here ? 'rt-tab here' : 'rt-tab'),
      h.Type('button'),
      h.OnClick(PickedRuntime({ runtime: install.runtime })),
    ],
    [install.logo, install.label],
  )

const installLine = (model: Model): Html => {
  const command = commandFor(model.runtime)
  const taken = model.copied === 'install'
  return h.div(
    [h.Class('hero-install')],
    [
      h.div(
        [h.Class('rt-tabs')],
        Array.map(installs, (install) =>
          runtimeTab(install, install.runtime === model.runtime),
        ),
      ),
      h.button(
        [
          h.Class('rt-command'),
          h.Type('button'),
          h.Title('Copy install command'),
          h.OnClick(Copied({ id: 'install', text: command })),
        ],
        [
          h.span([h.Class('prompt')], ['$']),
          h.span([h.Class('line')], [command]),
          h.span([h.Class(taken ? 'took done' : 'took')], [taken ? 'copied' : 'copy']),
        ],
      ),
    ],
  )
}

const onward = (): Html =>
  h.div(
    [h.Class('hero-onward')],
    [
      h.a(
        [
          h.Class('hero-link'),
          h.Href('/docs'),
          h.Style({ '--hero-ink': '#1D4FBF' }),
          h.OnClick(WentTo({ route: 'docs' })),
        ],
        ['Read the docs →'],
      ),
      h.a(
        [
          h.Class('hero-link'),
          h.Href('/source'),
          h.Style({ '--hero-ink': '#C2410C' }),
          h.OnClick(WentTo({ route: 'source' })),
        ],
        ['Browse the source'],
      ),
    ],
  )

export const hero = (model: Model): Html =>
  h.div(
    [h.Class('section section-hero'), h.Id('loom-top')],
    [
      wordmark(),
      h.div(
        [h.Class('hero-columns')],
        [
          claim(),
          h.div([h.Class('hero-right')], [installLine(model), onward()]),
        ],
      ),
    ],
  )
