import { Schema as S } from 'effect'
import { html } from 'foldkit/html'
import { m } from 'foldkit/message'

export const Model = S.Struct({
  rotatorIndex: S.Number,
  rotatorPhase: S.Literals(['normal', 'out', 'in-start']),
  howStep: S.Number,
  query: S.String,
  focus: S.Number,
  copied: S.String,
})
export type Model = typeof Model.Type

export const SelectedStep = m('SelectedStep', { step: S.Number })
export const Typed = m('Typed', { query: S.String })
export const MovedFocus = m('MovedFocus', { delta: S.Number, count: S.Number })
export const Copied = m('Copied', { id: S.String, text: S.String })
export const CopyReset = m('CopyReset')
export const RotatedOut = m('RotatedOut')
export const RotatedIn = m('RotatedIn')
export const RotatorSettled = m('RotatorSettled')

export const Message = S.Union([
  SelectedStep,
  Typed,
  MovedFocus,
  Copied,
  CopyReset,
  RotatedOut,
  RotatedIn,
  RotatorSettled,
])
export type Message = typeof Message.Type

export const h = html<Message>()
