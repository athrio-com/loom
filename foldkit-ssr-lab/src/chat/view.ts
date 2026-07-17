import { Array } from 'effect'
import { type Document, type Html } from '@athrio/foldkit/html'
import { BOUNDARY_ATTRIBUTE } from '@athrio/foldkit-hydration'
import * as AsyncData from '@athrio/foldkit/asyncData'
import {
  ChangedDraft,
  SelectedSession,
  SentMessage,
  h,
  type ChatMessage,
  type Model,
  type Session,
} from './model'

const sessionTab =
  (activeId: string) =>
  (session: Session): Html =>
    h.button(
      [
        h.Class(session.id === activeId ? 'tab on' : 'tab'),
        h.OnClick(SelectedSession({ id: session.id })),
      ],
      [session.title],
    )

const navigation = (model: Model): Html =>
  h.nav([h.Class('channels')], Array.map(model.sessions, sessionTab(model.activeSessionId)))

const messageBubble = (message: ChatMessage): Html =>
  h.li(
    [h.Key(message.id), h.Class(message.author === 'me' ? 'bubble me' : 'bubble them')],
    [message.text],
  )

export const messageFeed = (messages: ReadonlyArray<ChatMessage>): Html =>
  h.ul([h.Class('feed')], Array.map(messages, messageBubble))

const skeletonFeed = (): Html =>
  h.ul(
    [h.Class('feed skeleton')],
    Array.map(['a', 'b', 'c', 'd'], (key) => h.li([h.Key(key), h.Class('bubble ghost')], [])),
  )

const messageRoom = (messages: Model['messages']): Html =>
  h.section(
    [h.Class('room'), h.Attribute(BOUNDARY_ATTRIBUTE, 'messages')],
    [
      AsyncData.match(messages, {
        onIdle: skeletonFeed,
        onLoading: skeletonFeed,
        onRefreshing: (data) => messageFeed(data),
        onFailure: () => h.ul([h.Class('feed')], [h.li([], ['Could not load this channel.'])]),
        onStale: ({ data }) => messageFeed(data),
        onSuccess: (data) => messageFeed(data),
      }),
    ],
  )

const composer = (draft: string): Html =>
  h.form(
    [h.Class('composer'), h.OnSubmit(SentMessage())],
    [
      h.input([
        h.Class('draft'),
        h.Value(draft),
        h.Placeholder('Message the channel…'),
        h.OnInput((text) => ChangedDraft({ text })),
      ]),
      h.button([h.Class('send'), h.Type('submit')], ['Send']),
    ],
  )

export const view = (model: Model): Document => ({
  title: 'Foldkit SSR — Chat',
  body: h.div(
    [h.Id('app'), h.Class('chat')],
    [
      navigation(model),
      h.main([h.Class('main')], [messageRoom(model.messages), composer(model.draft)]),
    ],
  ),
})
