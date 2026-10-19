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
import { defineMessageUnion } from 'foldkit/message'

export const Route = S.Literals(['home', 'why-loom', 'docs', 'community', 'source', 'license'])
export type Route = typeof Route.Type

export const Runtime = S.Literals(['bun', 'npm', 'pnpm', 'curl'])
export type Runtime = typeof Runtime.Type

export const Model = S.Struct({
  route: Route,
  chapter: S.String,
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
    Match.when('license', () => '/license'),
    Match.exhaustive,
  )

export const routeOf = (pathname: string): Option.Option<Route> =>
  Array.findFirst(Route.literals, (route) => pathOf(route) === pathname)

export const Message = defineMessageUnion({
  WentTo: { route: Route },
  OpenedChapter: { slug: S.String },
  PickedRuntime: { runtime: Runtime },
  OpenedDrawer: {},
  ClosedDrawer: {},
  OpenedSearch: {},
  FocusedPalette: {},
  ClosedSearch: {},
  MovedCaret: { at: S.Number },
  SettledSearch: {},
  ToggledPlay: {},
  ReplayedDocument: {},
  SkippedToEnd: {},
  ToggledFullHeight: {},
  GrewCard: {},
  Ticked: { delta: S.Number },
  ShowedOutput: { which: PlayerOutput },
  StageMoved: {},
  SelectedSection: { id: S.String },
  SectionScrolled: {},
  SpottedSection: { id: S.String },
  Typed: { query: S.String },
  MovedFocus: { delta: S.Number, count: S.Number },
  Copied: { id: S.String, text: S.String },
  CopyReset: {},
})
export type Message = typeof Message.Type

export const {
  WentTo,
  OpenedChapter,
  PickedRuntime,
  OpenedDrawer,
  ClosedDrawer,
  OpenedSearch,
  FocusedPalette,
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
} = Message
