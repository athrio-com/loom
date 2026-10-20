const HeadingBlock = S.Struct({
  type: S.Literal('heading'),
  level: S.Number,
  title: S.String,
  id: S.String,
})
export type HeadingBlock = typeof HeadingBlock.Type

const ProseBlock = S.Struct({ type: S.Literal('prose'), markdown: S.String })

const CodeLink = S.Struct({
  name: S.String,
  offset: S.Number,
  length: S.Number,
  targetSlug: S.String,
  targetId: S.String,
})
export type CodeLink = typeof CodeLink.Type

const CodeBlock = S.Struct({
  type: S.Literal('code'),
  language: S.String,
  code: S.String,
  links: S.Array(CodeLink),
})
export type CodeBlock = typeof CodeBlock.Type

const NoteBlock = S.Struct({ type: S.Literal('note'), markdown: S.String })

export const Block = S.Union([HeadingBlock, ProseBlock, CodeBlock, NoteBlock])
export type Block = typeof Block.Type

const Chapter = S.Struct({
  number: S.String,
  title: S.String,
  slug: S.String,
  language: S.optional(S.String),
})
export type Chapter = typeof Chapter.Type

const Part = S.Struct({ number: S.String, name: S.String, chapters: S.Array(Chapter) })
export type Part = typeof Part.Type

const Page = S.Struct({
  slug: S.String,
  title: S.String,
  frontmatter: S.optional(S.String),
  blocks: S.Array(Block),
})
export type Page = typeof Page.Type

export const Corpus = S.Struct({ nav: S.Array(Part), pages: S.Array(Page) })
export type Corpus = typeof Corpus.Type

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

export const SearchHit = S.Struct({
  href: S.String,
  place: S.String,
  heading: S.String,
  pre: S.String,
  hit: S.String,
  post: S.String,
})
export type SearchHit = typeof SearchHit.Type

export const SearchGroup = S.Struct({ route: Route, hits: S.Array(SearchHit) })
export type SearchGroup = typeof SearchGroup.Type

export const Model = S.Struct({
  route: Route,
  chapter: S.String,
  drawerOpen: S.Boolean,
  runtime: Runtime,
  searchOpen: S.Boolean,
  caret: S.Number,
  searching: S.Boolean,
  found: S.Array(SearchGroup),
  activeSection: S.String,
  player: Player,
  version: S.String,
  query: S.String,
  focus: S.Number,
  copied: S.String,
  book: S.OptionFromNullOr(Corpus),
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

export const drawsInPlace = (route: Route): boolean => route !== 'source'

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
  Found: { query: S.String, groups: S.Array(SearchGroup) },
  OpenedHit: { href: S.String },
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
  Found,
  OpenedHit,
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
