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

type PairGroup = { readonly title: string; readonly pairs: ReadonlyArray<Pair> }

const pairsEmblem: Carpet = {
  rows: ['.......', '.a...b.', '..a.b..', '...p...', '..b.a..', '.b...a.', '.......'],
  threads: { '.': '#14204A', p: '#F2EFE6', a: '#FF6A3D', b: '#2E6FF2' },
}

const pairGroups: ReadonlyArray<PairGroup> = [
  {
    title: 'Prose and code that agree',
    pairs: [
      {
        problem: 'Specs and code drift. Sync machinery becomes a system within a system.',
        answer: 'Prose and code stay in sync because they live together and change together.',
      },
      {
        problem:
          'Generating code from a spec is never deterministic. Give an agent the same spec twice and it writes two different programs.',
        answer:
          'In Loom the code is written down, not regenerated. Prose and code are both source, so every change is an edit we can review, never a fresh roll of the dice.',
      },
      {
        problem:
          'In large codebases, prose can no longer be traced to its code, and the same ground gets covered again in new chapters.',
        answer:
          'Every passage sits beside the code it describes, and the table of contents is generated from the chapters themselves.',
      },
    ],
  },
  {
    title: 'A program we can read',
    pairs: [
      {
        problem: 'Natural language does not follow the order a compiler demands.',
        answer:
          'With Loom we write a program in the order we reason about it, and tangling puts each piece where the compiler wants it.',
      },
      {
        problem:
          'A program is a graph of files and modules pointing at one another, with no shape of the whole and no clear place to start reading.',
        answer:
          'A Loom project can grow into a book. Its parts and chapters read top to bottom, so every piece has a place and every reader a place to start.',
      },
    ],
  },
  {
    title: 'Tooling we can adopt today',
    pairs: [
      {
        problem:
          'Adopting a new format usually means converting a whole codebase before any of it pays off.',
        answer:
          'Loom can host one file at a time. The rest of the codebase stays as it is until we choose to move it.',
      },
      {
        problem:
          'Literate programming tools were each built for one language, as WEB was for Pascal and CWEB for C, or they treat every language as plain text.',
        answer:
          'Loom composes any language, and one chapter can mix several. Literate programming reaches every language a project is written in.',
      },
      {
        problem:
          'In the editor, a literate document gets no completion, no diagnostics and no go-to-definition, because its tools understand none of the code.',
        answer: 'Loom gives every supported language a real language server.',
      },
    ],
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
  rows: ['.o...o.', '..ooo..', '.ooooo.', 'o.o.o.o', '.ooooo.', 'o.o.o.o', '..ooo..'],
  threads: { '.': 'transparent', o: '#CE3F5C' },
}

const answerMark: Carpet = {
  rows: ['....g', '...g.', 'g.g..', '.g...', '.....'],
  threads: { '.': 'transparent', g: '#00714F' },
}

const pairLine = (mark: Html, text: string): Html =>
  ih.div([ih.Class('why-line')], [mark, ih.span([], [text])])

const hueAt = (at: number): Hue =>
  Option.getOrElse(Array.get(hues, at % hues.length), () => Array.headNonEmpty(hues))

const pairCard = (pair: Pair, at: number): Html => {
  const hue = hueAt(at)
  return ih.div(
    [ih.Class('why-pair'), ih.Style({ '--pair-ink': hue.ink, '--pair-tint': hue.tint })],
    [
      pairLine(pixels(problemMark, 'why-bug'), pair.problem),
      pairLine(pixels(answerMark, 'why-a'), pair.answer),
    ],
  )
}

const pairGroup = (group: PairGroup, from: number): Html =>
  ih.div(
    [ih.Class('why-group')],
    [
      ih.h3([ih.Class('why-group-title')], [group.title]),
      ih.div(
        [ih.Class('why-pair-set')],
        Array.map(group.pairs, (pair, at) => pairCard(pair, from + at)),
      ),
    ],
  )

const pairSet = (): Html =>
  ih.div(
    [ih.Class('why-cases')],
    [
      ih.div(
        [ih.Class('section-head')],
        [
          carpetMark(pairsEmblem, '42px', broadSeam),
          ih.div(
            [ih.Class('lines')],
            [ih.span([ih.Class('eyebrow')], ['Problem and solution']), ih.h2([], ['What Loom solves'])],
          ),
        ],
      ),
      ...Array.zipWith(
        pairGroups,
        Array.scan(pairGroups, 0, (from, group) => from + group.pairs.length),
        pairGroup,
      ),
    ],
  )

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
      pairSet(),
    ],
  )

export const whyLoom = (): ReadonlyArray<Html> => [whyHead(), whyMotivation()]
