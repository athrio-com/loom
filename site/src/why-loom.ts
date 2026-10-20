import { Array, Option } from 'effect'
import { type Html, inertHtml as ih } from 'foldkit/html'
import { broadSeam, type Carpet, carpetMark, whyLoomCarpet } from './components'
import { pageHead, pixels } from './page-head'

type Motivation = { readonly question: ReadonlyArray<string>; readonly answer: ReadonlyArray<string> }

const motivation: Motivation = {
  question: [
    "How do we find our way into a large codebase when we don't know where to start? How do we keep the intent behind code once it has left our memory? How do we know the documentation still describes the code? How do we carry context from one agent to the next, or from one model to another?",
    "Each of the questions asks the same thing: where does the meaning of the code live? Code records what a system does, but not why. The why ends up in documents, tickets and people's heads, and drifts away from the code it was meant to explain.",
  ],
  answer: [
    'In Loom, the why lives in the program. Prose and code are equal parts of one source. The prose defines what the system does and why, and the code does it.',
    'So the codebase stays open to people. We can return to it at any time, on our first day or years later, to review its quality, recover the intent behind a decision, audit its business logic, or plan the next change. No one has to reconstruct the reasons.',
    'With AI, this matters most of all. An agent reads the prose alongside the code it changes, so it works from our intent instead of guessing at it.',
  ],
}

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
      'We edit the source directly, with its prose beside it. Every change is an ordinary change to the source, never a re-roll of the generator.',
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
      'With Loom we write a program in the order we reason about it, and tangling puts each piece where the compiler wants it.',
  },
  {
    problem:
      'A program is a graph of files and modules pointing at one another, with no clear place to start reading.',
    answer:
      'A Loom project can grow into a book. Parts and chapters read top to bottom, under a table of contents generated from the chapters themselves.',
  },
  {
    problem:
      'Adopting a new format usually means converting a whole codebase before any of it pays off.',
    answer:
      'Loom can host one file at a time. The rest of the codebase stays as it is until we choose to move it.',
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
    [ih.Class('why-pair'), ih.Style({ '--pair-ink': hue.ink, '--pair-tint': hue.tint })],
    [
      pairLine(pixels(problemMark, 'why-q'), pair.problem),
      pairLine(pixels(answerMark, 'why-a'), pair.answer),
    ],
  )
}

const whyHead = (): Html =>
  pageHead(
    'why-top',
    'Why Loom?',
    "A program's reasoning belongs in the program. Literate programming has worked that way since 1984. Now that we write code with AI, it matters more than ever.",
  )

const motivationColumn = (paragraphs: ReadonlyArray<string>): Html =>
  ih.div(
    [ih.Class('why-column')],
    Array.map(paragraphs, (paragraph) => ih.p([ih.Class('prose')], [paragraph])),
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
            [ih.span([ih.Class('eyebrow')], ['The motivation']), ih.h2([], ['The missing why'])],
          ),
        ],
      ),
      ih.div(
        [ih.Class('why-prose')],
        [motivationColumn(motivation.question), motivationColumn(motivation.answer)],
      ),
      legend(),
      ih.div([ih.Class('why-pair-set')], Array.map(pairs, pairCard)),
    ],
  )

export const whyLoom = (): ReadonlyArray<Html> => [whyHead(), whyMotivation()]
