import './hydration-setup'
import { expect, test } from 'bun:test'
import { Effect, Schema as S } from 'effect'
import {
  adopt,
  patch,
  snapshotServerNodes,
  warnOnHydrationRebuild,
  type VNode,
} from '@athrio/foldkit-hydration'
import { html, type Html } from 'foldkit/html'
import { FoldkitRender } from '@athrio/foldkit-ssr'
import { Model } from '../src/app/model'

const h = html<never>()

const renderToHtml = (node: Html): string =>
  Effect.runSync(
    Effect.gen(function* () {
      const render = yield* FoldkitRender
      return yield* render.renderToString(node)
    }).pipe(Effect.provide(FoldkitRender.layer)),
  )

const stage = (node: Html): { readonly container: Element; readonly root: Element } => {
  document.body.innerHTML = `<div id="root">${renderToHtml(node)}</div>`
  const container = document.getElementById('root')!
  return { container, root: container.firstElementChild! }
}

const hydrate = (root: Element, node: Html): void => {
  patch(adopt(root), node as VNode)
}

const checkboxView = (checked: boolean): Html =>
  h.div([h.Id('app')], [h.input([h.Type('checkbox'), h.Checked(checked)])])

test('a property-valued attribute is left untouched, not churned', () => {
  const { root } = stage(checkboxView(true))
  const input = root.querySelector('input')!
  hydrate(root, checkboxView(true))
  expect(root.querySelector('input')).toBe(input)
  expect(input.checked).toBe(true)
})

const listView = (ids: ReadonlyArray<string>): Html =>
  h.div([h.Id('app')], [h.ul([], ids.map((id) => h.li([h.Key(id)], [id])))])

test('a reordered list moves its nodes rather than rebuilding them', () => {
  const { root } = stage(listView(['a', 'b', 'c']))
  const itemA = root.querySelector('li[data-fk-key="a"]')!
  hydrate(root, listView(['c', 'a', 'b']))
  expect(root.querySelector('li[data-fk-key="a"]')).toBe(itemA)
  const order = Array.from(root.querySelectorAll('li')).map((li) => li.getAttribute('data-fk-key'))
  expect(order).toEqual(['c', 'a', 'b'])
})

test('the serializer emits no whitespace, so the DOM has no stray text nodes', () => {
  const { root } = stage(h.div([h.Id('app')], [h.span([], ['x']), h.span([], ['y'])]))
  expect(root.childNodes.length).toBe(2)
  expect(Array.from(root.childNodes).every((node) => node.nodeType === 1)).toBe(true)
})

test('a client that disagrees with the server reconciles onto the same node', () => {
  const { root } = stage(checkboxView(false))
  const input = root.querySelector('input')!
  expect(input.hasAttribute('checked')).toBe(false)
  hydrate(root, checkboxView(true))
  expect(root.querySelector('input')).toBe(input)
  expect(input.checked).toBe(true)
})

test('the model round-trips through JSON unchanged', () => {
  const model: Model = {
    todos: [{ id: '0', text: 'read', done: true }],
    draft: 'x',
    filter: 'active',
    seq: 1,
  }
  const roundTripped = S.decodeUnknownSync(Model)(JSON.parse(JSON.stringify(S.encodeSync(Model)(model))))
  expect(roundTripped).toEqual(model)
})

test('model text is escaped, never injected as markup', () => {
  const evil = '<img src=x onerror="boom()">'
  const rendered = renderToHtml(h.div([h.Id('app')], [h.span([], [evil])]))
  expect(rendered).not.toContain('<img')
  expect(rendered).toContain('&lt;img')
  const { root } = stage(h.div([h.Id('app')], [h.span([], [evil])]))
  expect(root.querySelector('span')!.textContent).toBe(evil)
  expect(root.querySelector('img')).toBeNull()
})

const islandView = (markup: string): Html =>
  h.div([h.Id('app')], [h.div([h.Class('island'), h.InnerHTML(markup)], [])])

test('a raw-HTML island hydrates without rebuilding its content', () => {
  const { root } = stage(islandView('<b>bold</b>'))
  const inner = root.querySelector('.island')!.firstElementChild!
  hydrate(root, islandView('<b>bold</b>'))
  expect(root.querySelector('.island')!.firstElementChild).toBe(inner)
})

test('rendering is deterministic — the same model gives the same HTML', () => {
  expect(renderToHtml(checkboxView(true))).toBe(renderToHtml(checkboxView(true)))
})

const textFieldView = (value: string): Html =>
  h.div([h.Id('app')], [h.input([h.Type('text'), h.Value(value)])])

test('a focused element keeps focus across hydration', () => {
  const { root } = stage(textFieldView(''))
  const input = root.querySelector('input')!
  input.focus()
  expect(document.activeElement).toBe(input)
  hydrate(root, textFieldView(''))
  expect(document.activeElement).toBe(input)
})

const tableView = (): Html => h.div([h.Id('app')], [h.table([], [h.tr([], [h.td([], ['x'])])])])

test.failing('a table survives the browser-injected tbody without rebuilding', () => {
  const { root } = stage(tableView())
  const cell = root.querySelector('td')!
  hydrate(root, tableView())
  expect(root.querySelector('td')).toBe(cell)
})

test('a hydration rebuild is reported by the conformance check', () => {
  const { container, root } = stage(tableView())
  const serverNodes = snapshotServerNodes(container)
  const warnings: Array<string> = []
  const priorWarn = console.warn
  console.warn = (message: unknown) => {
    warnings.push(String(message))
  }
  try {
    hydrate(root, tableView())
    warnOnHydrationRebuild(serverNodes, container)
  } finally {
    console.warn = priorWarn
  }
  expect(warnings.some((message) => message.includes('rebuilt'))).toBe(true)
})
