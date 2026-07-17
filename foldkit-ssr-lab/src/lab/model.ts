import { Schema as S } from 'effect'
import { m } from '@athrio/foldkit/message'
import * as AsyncData from '@athrio/foldkit/asyncData'
import { html } from '@athrio/foldkit/html'

export const Strategy = S.Literals(['native', 'streaming', 'client'])
export type Strategy = typeof Strategy.Type

export const Body = AsyncData.Schema(S.String, S.String)

export const Card = S.Struct({
  id: S.String,
  title: S.String,
  strategy: Strategy,
  priority: S.Number,
  content: Body.schema,
})
export type Card = typeof Card.Type

export const LogEntry = S.Struct({
  at: S.Number,
  label: S.String,
  strategy: Strategy,
})
export type LogEntry = typeof LogEntry.Type

export const Model = S.Struct({
  cards: S.Array(Card),
  log: S.Array(LogEntry),
})
export type Model = typeof Model.Type

export const Flags = Model
export type Flags = typeof Flags.Type

export const CardLoaded = m('CardLoaded', { id: S.String, body: S.String })
export const Observed = m('Observed', { at: S.Number, label: S.String, strategy: Strategy })

export const Message = S.Union([CardLoaded, Observed])
export type Message = typeof Message.Type

export const h = html<Message>()
