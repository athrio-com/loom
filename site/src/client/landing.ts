import { ClickedCopy, h, pathForSlug } from './model'
import type { Html } from '@athrio/foldkit/html'

const example = [
  '---',
  'Language: TypeScript',
  'Package: src/main.ts',
  '---',
  '',
  '# A greeting',
  '',
  'The greet function welcomes someone by name.',
  '',
  '=>',
  '',
  'export const greet = (name: string): string =>',
  '  `Hello, ${name}!`',
  '',
  '# The entry point {Tangle}',
  '',
  '=>',
  '',
  '::' + '[A greeting]',
  '',
  'console.log(greet("world"))',
].join('\n')

const install = 'bun install -g @athrio/loom'

const heroView = (firstSlug: string): Html =>
  h.div(
    [h.Class('loom-hero')],
    [
      h.div(
        [],
        [
          h.div([h.Class('loom-hero-eyebrow')], ['Literate programming']),
          h.h1(
            [h.Class('loom-hero-title')],
            ['Prose and code, ', h.em([], ['woven']), ' into one source.'],
          ),
          h.p(
            [h.Class('loom-hero-lede')],
            [
              'Loom is a literate programming framework. You write a .loom file as prose and code in reading order — then tangle composes it into real source on disk.',
            ],
          ),
          h.div(
            [h.Class('loom-hero-actions')],
            [
              h.div(
                [h.Class('loom-install')],
                [
                  h.span([h.Class('loom-install-prompt')], ['$']),
                  h.span([], [install]),
                  h.button([h.Class('loom-copy'), h.OnClick(ClickedCopy({ text: install }))], ['copy']),
                ],
              ),
            ],
          ),
          h.div(
            [h.Class('loom-hero-actions'), h.Style({ 'margin-top': '14px' })],
            [
              h.a([h.Class('loom-btn loom-btn-primary'), h.Href(pathForSlug(firstSlug))], ['Read the docs']),
              h.a([h.Class('loom-btn'), h.Href('#')], ['Browse the source']),
            ],
          ),
        ],
      ),
      h.div(
        [h.Class('loom-hero-panel')],
        [
          h.div([h.Class('loom-hero-panel-head')], ['greeting.loom']),
          h.pre([], [example]),
        ],
      ),
    ],
  )

const featureView = (title: string, body: string): Html =>
  h.div(
    [h.Class('loom-feature')],
    [
      h.div([h.Class('loom-feature-title')], [title]),
      h.div([h.Class('loom-feature-body')], [body]),
    ],
  )

const featuresView = (): Html =>
  h.div(
    [h.Class('loom-features')],
    [
      featureView(
        'Woven, not commented',
        'Prose and code are equal layers. A section draws in another by name — never by copying it.',
      ),
      featureView(
        'Tangled to real source',
        'loom tangle drops the prose and writes plain TypeScript, Bash, or JSON — the file the compiler sees.',
      ),
      featureView(
        'Alive in the editor',
        'Every section is first-class: go to an anchor’s definition, catch a broken one, type-check in place.',
      ),
    ],
  )

const footView = (firstSlug: string): Html =>
  h.div(
    [h.Class('loom-foot')],
    [
      h.span([], ['© 2026 Loom']),
      h.span(
        [],
        [h.a([h.Href(pathForSlug(firstSlug))], ['Docs']), ' · ', h.a([h.Href('#')], ['Source'])],
      ),
    ],
  )

export const landingView = (firstSlug: string): Html =>
  h.div(
    [h.Class('loom-landing')],
    [h.div([h.Class('loom-landing-inner')], [heroView(firstSlug), featuresView(), footView(firstSlug)])],
  )
