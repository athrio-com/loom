import { Schema as S } from 'effect'
import { m } from 'foldkit/message'
import * as AsyncData from 'foldkit/asyncData'
import { html } from 'foldkit/html'

export const Session = S.Struct({
  id: S.String,
  title: S.String,
})
export type Session = typeof Session.Type

export const Author = S.Literals(['me', 'them'])
export type Author = typeof Author.Type

export const ChatMessage = S.Struct({
  id: S.String,
  author: Author,
  text: S.String,
})
export type ChatMessage = typeof ChatMessage.Type

export const Feed = AsyncData.Schema(S.Array(ChatMessage), S.String)

export const Model = S.Struct({
  sessions: S.Array(Session),
  activeSessionId: S.String,
  messages: Feed.schema,
  draft: S.String,
})
export type Model = typeof Model.Type

export const Flags = Model
export type Flags = typeof Flags.Type

export const ChangedDraft = m('ChangedDraft', { text: S.String })
export const SelectedSession = m('SelectedSession', { id: S.String })
export const MessagesArrived = m('MessagesArrived', {
  sessionId: S.String,
  messages: S.Array(ChatMessage),
})
export const SentMessage = m('SentMessage')
export const SavedDraft = m('SavedDraft')

export const Message = S.Union([
  ChangedDraft,
  SelectedSession,
  MessagesArrived,
  SentMessage,
  SavedDraft,
])
export type Message = typeof Message.Type

export const h = html<Message>()
