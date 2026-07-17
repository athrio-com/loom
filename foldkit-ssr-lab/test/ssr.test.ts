import '../src/server/browser-globals'
import { expect, test } from 'bun:test'
import { Effect, Stream } from 'effect'
import { Window } from 'happy-dom'
import { toVNode, type VNode } from 'snabbdom'
import { FoldkitRender } from '@athrio/foldkit-ssr'
import { adopt } from '@athrio/foldkit-hydration'
import { view } from '../src/app/view'
import { type Model } from '../src/app/model'

const seed: Model = {
  todos: [
    { id: '0', text: 'Read the Loom book', done: true },
    { id: '1', text: 'Render a view to an HTML string', done: false },
  ],
  draft: '',
  filter: 'all',
  seq: 2,
}

const rendered = (html: VNode): string =>
  Effect.runSync(
    Effect.gen(function* () {
      const render = yield* FoldkitRender
      return yield* render.renderToString(html)
    }).pipe(Effect.provide(FoldkitRender.layer)),
  )

const streamed = (html: VNode): ReadonlyArray<string> =>
  Effect.runSync(
    Effect.gen(function* () {
      const render = yield* FoldkitRender
      return yield* Stream.runCollect(render.renderToStream(html))
    }).pipe(Effect.provide(FoldkitRender.layer)),
  )

test('renderToString serializes the view to HTML', () => {
  const html = rendered(view(seed).body as VNode)
  expect(html).toContain('<div id="app" class="todo">')
  expect(html).toContain('data-fk-key="0"')
  expect(html).toContain('<input class="check" type="checkbox" checked>')
  expect(html).toContain('<span class="text">Read the Loom book</span>')
  expect(html).not.toContain('onclick')
})

test('renderToStream emits the same document in fragments', () => {
  const html = view(seed).body as VNode
  const fragments = streamed(html)
  expect(fragments.length).toBeGreaterThan(1)
  expect(fragments.join('')).toBe(rendered(html))
})

const selectorOf = (node: VNode | string): string | undefined =>
  typeof node === 'string' ? undefined : node.sel

const keyOf = (node: VNode | string): unknown =>
  typeof node === 'string' ? undefined : node.key ?? node.data?.key

const childrenOf = (node: VNode | string): ReadonlyArray<VNode | string> =>
  typeof node === 'string' ? [] : node.children ?? []

const sameShape = (left: VNode | string, right: VNode | string): boolean => {
  const selector = selectorOf(left)
  if (selector !== selectorOf(right)) return false
  if (selector === undefined) return true
  if (keyOf(left) !== keyOf(right)) return false
  const leftChildren = childrenOf(left)
  const rightChildren = childrenOf(right)
  return (
    leftChildren.length === rightChildren.length &&
    leftChildren.every((child, index) => sameShape(child, rightChildren[index]!))
  )
}

test('adopt matches the view node for node, so the client merges', () => {
  const viewNode = view(seed).body as VNode
  const window = new Window()
  window.document.body.innerHTML = rendered(viewNode)
  const serverRoot = window.document.body.firstElementChild as unknown as Element

  expect(toVNode(serverRoot as never).sel).not.toBe(viewNode.sel)

  const adoptedRoot = adopt(serverRoot)
  expect(adoptedRoot.sel).toBe(viewNode.sel)
  expect(adoptedRoot.elm).toBe(serverRoot as never)
  expect(sameShape(adoptedRoot, viewNode)).toBe(true)
})
