import { Schema as S } from 'effect'
import { html } from 'foldkit/html'
import { m } from 'foldkit/message'
import * as Gomoku from '../../examples/gomoku/gomoku'

export const Model = S.Struct({
  rotatorIndex: S.Number,
  rotatorPhase: S.Literals(['normal', 'out', 'in-start']),
  activeSection: S.String,
  exampleTab: S.Literals(['loom', 'tangled', 'play']),
  loomView: S.Literals(['preview', 'source']),
  game: Gomoku.Model,
  version: S.String,
  query: S.String,
  focus: S.Number,
  copied: S.String,
  packageManager: S.Literals(['npm', 'pnpm', 'yarn', 'bun']),
})
export type Model = typeof Model.Type

export const SelectedTab = m('SelectedTab', { tab: S.Literals(['loom', 'tangled', 'play']) })
export const SelectedLoomView = m('SelectedLoomView', { view: S.Literals(['preview', 'source']) })
export const GotGameMessage = m('GotGameMessage', { message: Gomoku.Message })
export const SelectedSection = m('SelectedSection', { id: S.String })
export const SectionScrolled = m('SectionScrolled')
export const SpottedSection = m('SpottedSection', { id: S.String })
export const Typed = m('Typed', { query: S.String })
export const MovedFocus = m('MovedFocus', { delta: S.Number, count: S.Number })
export const Copied = m('Copied', { id: S.String, text: S.String })
export const CopyReset = m('CopyReset')
export const SelectedPackageManager = m('SelectedPackageManager', {
  packageManager: S.Literals(['npm', 'pnpm', 'yarn', 'bun']),
})
export const RotatedOut = m('RotatedOut')
export const RotatedIn = m('RotatedIn')
export const RotatorSettled = m('RotatorSettled')

export const Message = S.Union([
  SelectedTab,
  SelectedLoomView,
  GotGameMessage,
  SelectedSection,
  SectionScrolled,
  SpottedSection,
  Typed,
  MovedFocus,
  Copied,
  CopyReset,
  SelectedPackageManager,
  RotatedOut,
  RotatedIn,
  RotatorSettled,
])
export type Message = typeof Message.Type

export const h = html<Message>()
