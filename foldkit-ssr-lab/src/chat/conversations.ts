import { Array, Option, pipe } from 'effect'
import { type ChatMessage, type Session } from './model'

type Conversation = {
  readonly session: Session
  readonly messages: ReadonlyArray<ChatMessage>
}

const conversations: ReadonlyArray<Conversation> = [
  {
    session: { id: 'general', title: '# general' },
    messages: [
      { id: 'g1', author: 'them', text: 'Morning — did the release go out?' },
      { id: 'g2', author: 'me', text: 'Just now. Green across the board.' },
      { id: 'g3', author: 'them', text: 'Beautiful. Closing the incident.' },
    ],
  },
  {
    session: { id: 'design', title: '# design' },
    messages: [
      { id: 'd1', author: 'them', text: 'The mint-on-dark palette looks great hydrated.' },
      { id: 'd2', author: 'me', text: 'Same nodes the server sent, no rebuild.' },
    ],
  },
  {
    session: { id: 'random', title: '# random' },
    messages: [
      { id: 'r1', author: 'me', text: 'Anyone else think streaming SSR is underrated?' },
      { id: 'r2', author: 'them', text: 'The shell paints before the data even lands.' },
      { id: 'r3', author: 'me', text: 'Exactly. Progressive, not all-or-nothing.' },
    ],
  },
]

export const sessions: ReadonlyArray<Session> = Array.map(
  conversations,
  (conversation) => conversation.session,
)

export const messagesOf = (id: string): ReadonlyArray<ChatMessage> =>
  pipe(
    Array.findFirst(conversations, (conversation) => conversation.session.id === id),
    Option.map((conversation) => conversation.messages),
    Option.getOrElse(() => []),
  )
