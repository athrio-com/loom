import { Array } from 'effect'
import { type Html, inertHtml as ih } from 'foldkit/html'
import { broadSeam, carpetMark, communityCarpet } from './components'
import { pageHead } from './page-head'

type Channel = {
  readonly place: string
  readonly title: string
  readonly body: string
  readonly href: string
  readonly ink: string
  readonly tint: string
}

const channels: ReadonlyArray<Channel> = [
  {
    place: 'Telegram',
    title: 'Ask anything',
    body: 'The fastest way to get an answer. Bring a corpus that will not tangle, a language server that will not attach, or a question about what a section should mean. The group is Athrio’s community, and Loom is one of its topics.',
    href: 'https://t.me/athrio',
    ink: '#2E6FF2',
    tint: '#E9F0FE',
  },
  {
    place: 'Issues',
    title: 'Say where it broke',
    body: 'A file that tangles wrong is worth more than a feature request. Paste the corpus, the command and what you expected to come out.',
    href: 'https://github.com/athrio-com/loom/issues',
    ink: '#FF6A3D',
    tint: '#FDEDE6',
  },
  {
    place: 'Pull requests',
    title: 'Add a language',
    body: 'Every language arrives as a package behind the same contract: the language service the editor talks to. Start with the one you already write.',
    href: 'https://github.com/athrio-com/loom/pulls',
    ink: '#00B37E',
    tint: '#E4F5EF',
  },
  {
    place: 'GitHub Discussions',
    title: 'Argue about the design',
    body: 'Format changes, new marks and anything that would alter what a Loom document is. Slower than chat, and written down, which is the point.',
    href: 'https://github.com/athrio-com/loom/discussions',
    ink: '#8B5CF6',
    tint: '#F0EAFE',
  },
]

const channelCard = (channel: Channel): Html =>
  ih.a(
    [
      ih.Class('channel-card'),
      ih.Href(channel.href),
      ih.Style({ '--channel-ink': channel.ink, '--channel-tint': channel.tint }),
    ],
    [
      ih.span(
        [ih.Class('place-lines')],
        [
          ih.span([ih.Class('eyebrow')], [channel.place]),
          ih.span([ih.Class('place-title')], [channel.title]),
        ],
      ),
      ih.span([ih.Class('channel-body')], [channel.body]),
    ],
  )

const communityHead = (): Html =>
  pageHead(
    'community-top',
    'Community',
    'Loom is young and the shape of it is still being argued over. Reading the source, asking a question and saying where it broke are all real contributions at this stage.',
  )

const communityChannels = (): Html =>
  ih.div(
    [ih.Class('section'), ih.Id('community-ways')],
    [
      ih.div(
        [ih.Class('section-head')],
        [
          carpetMark(communityCarpet, '42px', broadSeam),
          ih.div(
            [ih.Class('lines')],
            [
              ih.span([ih.Class('eyebrow')], ['Where the work happens']),
              ih.h2([], ['Contribute in your way']),
            ],
          ),
        ],
      ),
      ih.div([ih.Class('channel-set')], Array.map(channels, channelCard)),
    ],
  )

export const community = (): ReadonlyArray<Html> => [communityHead(), communityChannels()]
