import { Effect, Option } from 'effect'
import { Server } from 'foldkit/experimental'
import type { Document, Html, HtmlBuilder } from 'foldkit/html'
import type { Message, Model } from '../src/model'

export const renderDocument = (
  draw: (h: HtmlBuilder<Message>) => Document,
): Server.RenderedApplication =>
  Effect.runSync(
    Server.renderToString(
      { init: () => ({ model: null }), view: (_: null, h: HtmlBuilder<Message>) => draw(h) },
      { isHydratable: false },
    ),
  )

export const renderHtml = (draw: (h: HtmlBuilder<Message>) => Html): string =>
  renderDocument((h) => ({ title: '', body: draw(h) })).html

export const modelAt = (over: Partial<Model> = {}): Model => ({
  route: 'home',
  chapter: '',
  drawerOpen: false,
  runtime: 'bun',
  searchOpen: false,
  caret: 0,
  searching: false,
  found: [],
  activeSection: '',
  player: { struck: 0, beat: 0, playing: false, output: Option.none(), full: false },
  version: '0.0.9',
  query: '',
  exact: false,
  focus: 0,
  copied: '',
  book: Option.none(),
  ...over,
})

export const anchor = (name: string): string => `::${'['}${name}]`
