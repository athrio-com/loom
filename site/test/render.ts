import { Effect } from 'effect'
import { Server } from 'foldkit/experimental'
import type { Document, Html, HtmlBuilder } from 'foldkit/html'
import type { Message } from '../src/model'

// Foldkit hands a builder only to a view, so a test draws a piece of the page by
// wrapping it in a one-off application and rendering that as static markup.
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
