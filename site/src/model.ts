export const PlayerOutput = S.Literals(['tangle', 'weave'])
export type PlayerOutput = typeof PlayerOutput.Type

export const Player = S.Struct({
  struck: S.Number,
  beat: S.Number,
  playing: S.Boolean,
  output: S.Option(PlayerOutput),
  full: S.Boolean,
})
export type Player = typeof Player.Type

import { Array, Match, Option, Schema as S } from 'effect'
import { html } from 'foldkit/html'
import { m } from 'foldkit/message'

export const Route = S.Literals(['home', 'why-loom', 'docs', 'community', 'source'])
export type Route = typeof Route.Type

export const Runtime = S.Literals(['bun', 'npm', 'pnpm'])
export type Runtime = typeof Runtime.Type

export const Model = S.Struct({
  route: Route,
  chapter: S.String,
  navHidden: S.Boolean,
  drawerOpen: S.Boolean,
  runtime: Runtime,
  searchOpen: S.Boolean,
  caret: S.Number,
  searching: S.Boolean,
  activeSection: S.String,
  player: Player,
  version: S.String,
  query: S.String,
  focus: S.Number,
  copied: S.String,
})
export type Model = typeof Model.Type

export const pathOf = (route: Route): string =>
  Match.value(route).pipe(
    Match.when('home', () => '/'),
    Match.when('docs', () => '/docs'),
    Match.when('why-loom', () => '/why-loom'),
    Match.when('community', () => '/community'),
    Match.when('source', () => '/source'),
    Match.exhaustive,
  )

export const routeOf = (pathname: string): Option.Option<Route> =>
  Array.findFirst(Route.literals, (route) => pathOf(route) === pathname)

export const WentTo = m('WentTo', { route: Route })
export const OpenedChapter = m('OpenedChapter', { slug: S.String })
export const PickedRuntime = m('PickedRuntime', { runtime: Runtime })
export const ScrolledBar = m('ScrolledBar', { hidden: S.Boolean })
export const OpenedDrawer = m('OpenedDrawer')
export const ClosedDrawer = m('ClosedDrawer')
export const OpenedSearch = m('OpenedSearch')
export const ClosedSearch = m('ClosedSearch')
export const MovedCaret = m('MovedCaret', { at: S.Number })
export const SettledSearch = m('SettledSearch')
export const ToggledPlay = m('ToggledPlay')
export const ReplayedDocument = m('ReplayedDocument')
export const SkippedToEnd = m('SkippedToEnd')
export const ToggledFullHeight = m('ToggledFullHeight')
export const GrewCard = m('GrewCard')
export const Ticked = m('Ticked', { delta: S.Number })
export const ShowedOutput = m('ShowedOutput', { which: PlayerOutput })
export const StageMoved = m('StageMoved')
export const SelectedSection = m('SelectedSection', { id: S.String })
export const SectionScrolled = m('SectionScrolled')
export const SpottedSection = m('SpottedSection', { id: S.String })
export const Typed = m('Typed', { query: S.String })
export const MovedFocus = m('MovedFocus', { delta: S.Number, count: S.Number })
export const Copied = m('Copied', { id: S.String, text: S.String })
export const CopyReset = m('CopyReset')

export const Message = S.Union([
  WentTo,
  OpenedChapter,
  PickedRuntime,
  ScrolledBar,
  OpenedDrawer,
  ClosedDrawer,
  OpenedSearch,
  ClosedSearch,
  MovedCaret,
  SettledSearch,
  ToggledPlay,
  ReplayedDocument,
  SkippedToEnd,
  ToggledFullHeight,
  GrewCard,
  Ticked,
  ShowedOutput,
  StageMoved,
  SelectedSection,
  SectionScrolled,
  SpottedSection,
  Typed,
  MovedFocus,
  Copied,
  CopyReset,
])
export type Message = typeof Message.Type

export const h = html<Message>()
