import './hydration-setup'
import { beforeEach, expect, test } from 'bun:test'
import { Effect, Schema as S } from 'effect'
import {
  BOUNDARY_ATTRIBUTE,
  BOUNDARY_FILL_EVENT,
  STREAMING_FILL_SCRIPT,
  adopt,
  boundaryFillChunk,
  bufferedFills,
  markBooted,
  patch,
  type VNode,
} from '@athrio/foldkit-hydration'
import { type Html } from '@athrio/foldkit/html'
import { FoldkitRender } from '@athrio/foldkit-ssr'
import { messageFeed, view } from '../src/chat/view'
import { ChatMessage, Feed, type Model } from '../src/chat/model'
import { messagesOf, sessions } from '../src/chat/conversations'

const renderToHtml = (node: Html): string =>
  Effect.runSync(
    Effect.gen(function* () {
      const render = yield* FoldkitRender
      return yield* render.renderToString(node)
    }).pipe(Effect.provide(FoldkitRender.layer)),
  )

const messages = messagesOf('general')
const encodeMessages = S.encodeSync(S.Array(ChatMessage))

const shellModel: Model = {
  sessions,
  activeSessionId: 'general',
  messages: Feed.Loading(),
  draft: '',
}
const loadedModel: Model = { ...shellModel, messages: Feed.Success({ data: messages }) }

const fillWindow = () =>
  window as unknown as { __foldkitFill: (id: string, data: unknown) => void }

const installFillScript = (): void => {
  new Function(STREAMING_FILL_SCRIPT)()
}

const resetStream = (): void => {
  const scope = window as unknown as Record<string, unknown>
  delete scope.__foldkitFills
  delete scope.__foldkitBooted
  delete scope.__foldkitFill
  document.body.innerHTML = ''
}

beforeEach(resetStream)

test('a fill chunk carries the boundary, its feed, and its data', () => {
  const chunk = boundaryFillChunk(
    'messages',
    renderToHtml(messageFeed(messages)),
    '{"sessionId":"general","messages":[]}',
  )
  expect(chunk).toContain('<template data-fk-fill="messages">')
  expect(chunk).toContain('data-fk-key="g1"')
  expect(chunk).toContain('window.__foldkitFill("messages",')
})

test('a fill before boot swaps the feed in and buffers it', () => {
  document.body.innerHTML =
    `<div ${BOUNDARY_ATTRIBUTE}="messages"><ul class="feed skeleton"></ul></div>` +
    `<template data-fk-fill="messages">${renderToHtml(messageFeed(messages))}</template>`
  installFillScript()
  fillWindow().__foldkitFill('messages', {
    sessionId: 'general',
    messages: encodeMessages(messages),
  })
  const boundary = document.querySelector(`[${BOUNDARY_ATTRIBUTE}="messages"]`)!
  expect(boundary.querySelector('.skeleton')).toBeNull()
  expect(boundary.querySelector('li[data-fk-key="g1"]')).not.toBeNull()
  expect(bufferedFills().length).toBe(1)
})

test('the streamed feed hydrates onto the same nodes, not rebuilt', () => {
  document.body.innerHTML =
    `<div id="root">${renderToHtml(view(shellModel).body)}</div>` +
    `<template data-fk-fill="messages">${renderToHtml(messageFeed(messages))}</template>`
  installFillScript()
  fillWindow().__foldkitFill('messages', {
    sessionId: 'general',
    messages: encodeMessages(messages),
  })
  const boundary = document.querySelector(`[${BOUNDARY_ATTRIBUTE}="messages"]`)!
  const firstBubble = boundary.querySelector('li[data-fk-key="g1"]')
  expect(firstBubble).not.toBeNull()

  const root = document.getElementById('root')!.firstElementChild!
  patch(adopt(root), view(loadedModel).body as VNode)
  expect(boundary.querySelector('li[data-fk-key="g1"]')).toBe(firstBubble)
})

test('a fill after boot buffers and signals but does not swap', () => {
  markBooted()
  document.body.innerHTML =
    `<div ${BOUNDARY_ATTRIBUTE}="messages"><ul class="feed skeleton"></ul></div>` +
    `<template data-fk-fill="messages">${renderToHtml(messageFeed(messages))}</template>`
  installFillScript()
  let heard = false
  window.addEventListener(BOUNDARY_FILL_EVENT, () => {
    heard = true
  })
  fillWindow().__foldkitFill('messages', {
    sessionId: 'general',
    messages: encodeMessages(messages),
  })
  const boundary = document.querySelector(`[${BOUNDARY_ATTRIBUTE}="messages"]`)!
  expect(boundary.querySelector('.skeleton')).not.toBeNull()
  expect(boundary.querySelector('li[data-fk-key="g1"]')).toBeNull()
  expect(heard).toBe(true)
  expect(bufferedFills().length).toBe(1)
})

test('the view names the document for the head', () => {
  expect(view(shellModel).title).toBe('Foldkit SSR — Chat')
})
