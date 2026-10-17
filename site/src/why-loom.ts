import { Array, Option } from 'effect'
import { type Html, inertHtml as ih } from 'foldkit/html'
import {
  broadSeam,
  type Carpet,
  carpetMark,
  carpetStyle,
  fineSeam,
  loomMark,
  whyLoomCarpet,
} from './components'

const NAVY = '#14204A'

type Place = {
  readonly name: string
  readonly action: string
  readonly href: string
  readonly emblem: Carpet
  readonly key: 'github' | 'discord'
}

const places: ReadonlyArray<Place> = [
  {
    name: 'GitHub',
    action: 'Star the repo',
    href: 'https://github.com/athrio-com/loom',
    key: 'github',
    emblem: {
      rows: ['...a...', '..aaa..', 'aaaaaaa', '.aaaaa.', '..aaa..', '.aa.aa.', '.a...a.'],
      threads: { '.': NAVY, a: '#FFC53D' },
    },
  },
  {
    name: 'Discord',
    action: 'Join community',
    href: 'https://discord.gg/loom',
    key: 'discord',
    emblem: {
      rows: ['.......', '.vvvvv.', '.v.b.v.', '.vbpbv.', '.v.b.v.', '.vvvvv.', '.......'],
      threads: { '.': NAVY, v: '#8B5CF6', b: '#2E6FF2', p: '#F2EFE6' },
    },
  },
]

const placeCard = (place: Place): Html =>
  ih.a(
    [ih.Class(`why-link ${place.key}`), ih.Href(place.href)],
    [
      pixels(place.emblem, 'why-emblem'),
      ih.span(
        [ih.Class('why-link-lines')],
        [
          ih.span([ih.Class('eyebrow')], [place.name]),
          ih.span([ih.Class('why-link-title')], [place.action]),
        ],
      ),
    ],
  )

const pixels = (carpet: Carpet, className: string): Html =>
  ih.span(
    [
      ih.AriaHidden(true),
      ih.Class(className),
      ih.Style(carpetStyle(carpet, fineSeam)),
    ],
    [],
  )

const motivation: ReadonlyArray<string> = [
  'AI-assisted engineering relies on natural language as a primary medium for building software. But the prose describing a system and the code that implements it tend to drift apart and fight for authority. The result is a split brain: the prose on one side, the code on the other.',
  'Loom applies literate programming principles to address this and the deeper problems behind it. It treats prose and code as equal constituents of a single program. We write prose beside each code chunk, defining what it does and why.',
  'Keeping intent in the program itself matters most when writing code with AI. The agent reads the prose alongside the code it is changing. Prose and code stay in sync because they live together and change together.',
  'The state of the art is the other reason for Loom. Literate programming has never come with the tooling modern development takes for granted, and every earlier attempt shows the same pattern: tangling that works for any language, with a full language server behind it, has never come together outside an experiment. Loom brings the two together.',
]

type Pair = { readonly problem: string; readonly answer: string }

const pairs: ReadonlyArray<Pair> = [
  {
    problem: 'Specs and code drift. Sync machinery becomes a system within a system.',
    answer: 'Prose and code stay in sync because they live together and change together.',
  },
  {
    problem:
      'AI code generation is approximate, never deterministic. The same prose interpreted twice gives two different programs.',
    answer:
      'You edit the source directly, with its prose beside it. Every change is an ordinary change to the source, never a re-roll of the generator.',
  },
  {
    problem:
      'In large codebases, prose can no longer be traced to its code, and the same ground gets covered again in new chapters.',
    answer:
      'Every passage sits beside the code it describes, and the table of contents is generated from the chapters themselves.',
  },
  {
    problem: 'Natural language does not follow the order a compiler demands.',
    answer:
      'With Loom you write a program in the order you reason about it, and tangling puts each piece where the compiler wants it.',
  },
  {
    problem:
      'A program is a graph of files and modules pointing at one another, with no clear place to start reading.',
    answer:
      'A Loom project can grow into a book. Parts and chapters read top to bottom, under a table of contents generated from the chapters themselves.',
  },
  {
    problem: 'Adopting a new format usually means converting a whole codebase before any of it pays off.',
    answer:
      'Loom can host one file at a time. The rest of the codebase stays as it is until you choose to move it.',
  },
  {
    problem: 'Specs end up scattered across the codebase, with no shape of the whole.',
    answer: 'Loom gives the corpus a shape of parts and chapters, so every chapter has a place.',
  },
  {
    problem:
      'Literate programming tools understand no language, so the document gets no completion, no diagnostics, no go-to-definition.',
    answer: 'Loom gives every supported language a real language server.',
  },
]

type Hue = { readonly ink: string; readonly tint: string }

const hues: Array.NonEmptyReadonlyArray<Hue> = [
  { ink: '#FF6A3D', tint: '#FDEDE6' },
  { ink: '#2E6FF2', tint: '#E9F0FE' },
  { ink: '#00B37E', tint: '#E4F5EF' },
  { ink: '#8B5CF6', tint: '#F0EAFE' },
  { ink: '#E8318A', tint: '#FCE8F1' },
  { ink: '#FFC53D', tint: '#FDF3DF' },
  { ink: '#14204A', tint: '#E8EAF1' },
]

const problemMark: Carpet = {
  rows: ['.ooo.', 'o...o', '...o.', '..o..', '.....', '..o..'],
  threads: { '.': 'transparent', o: '#FF6A3D' },
}

const answerMark: Carpet = {
  rows: ['....g', '...g.', 'g.g..', '.g...', '.....'],
  threads: { '.': 'transparent', g: '#00714F' },
}

const legend = (): Html =>
  ih.div(
    [ih.Class('why-legend')],
    [
      ih.span([ih.Class('why-key problem')], [pixels(problemMark, 'why-q'), 'Problem']),
      ih.span([ih.Class('why-key answer')], [pixels(answerMark, 'why-a'), 'Solution']),
    ],
  )

const pairLine = (mark: Html, text: string): Html =>
  ih.div([ih.Class('why-line')], [mark, ih.span([], [text])])

const hueAt = (at: number): Hue =>
  Option.getOrElse(Array.get(hues, at % hues.length), () => Array.headNonEmpty(hues))

const pairCard = (pair: Pair, at: number): Html => {
  const hue = hueAt(at)
  return ih.div(
    [
      ih.Class('why-pair'),
      ih.Style({ '--pair-ink': hue.ink, '--pair-tint': hue.tint }),
    ],
    [
      pairLine(pixels(problemMark, 'why-q'), pair.problem),
      pairLine(pixels(answerMark, 'why-a'), pair.answer),
    ],
  )
}

const whyHead = (): Html =>
  ih.div(
    [ih.Class('section section-hero why-hero'), ih.Id('why-top')],
    [
      ih.div(
        [ih.Class('why-title')],
        [loomMark('paper', 0.8), ih.h1([], ['Why Loom?'])],
      ),
      ih.div(
        [ih.Class('why-hero-grid')],
        [
          ih.p(
            [ih.Class('prose why-lead')],
            [
              'The motivation behind Loom is simple. AI-assisted engineering relies on natural language as a primary medium for building software. Literate programming has been doing that since 1984.',
            ],
          ),
          ih.div([ih.Class('why-links')], Array.map(places, placeCard)),
        ],
      ),
    ],
  )

const whyMotivation = (): Html =>
  ih.div(
    [ih.Class('section'), ih.Id('why-pairs')],
    [
      ih.div(
        [ih.Class('section-head')],
        [
          carpetMark(whyLoomCarpet, '42px', broadSeam),
          ih.div(
            [ih.Class('lines')],
            [ih.span([ih.Class('eyebrow')], ['The motivation']), ih.h2([], ['The modern problem'])],
          ),
        ],
      ),
      ih.div(
        [ih.Class('prose-columns why-prose')],
        Array.map(motivation, (paragraph) => ih.p([ih.Class('prose')], [paragraph])),
      ),
      legend(),
      ih.div([ih.Class('why-pair-set')], Array.map(pairs, pairCard)),
    ],
  )

export const whyLoom = (): ReadonlyArray<Html> => [whyHead(), whyMotivation()]
