import {
  Array,
  Context,
  Data,
  Effect,
  Layer,
  Match,
  Option,
  Predicate,
  Stream,
  pipe,
} from 'effect'
import type { VNode, VNodeData } from 'snabbdom'
import type { Html } from '@athrio/foldkit/html'

const escapeText = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const escapeAttr = (value: string): string =>
  escapeText(value).replace(/"/g, '&quot;')

type Selector = {
  readonly tag: string
  readonly id: Option.Option<string>
  readonly classes: ReadonlyArray<string>
}

const parseSelector = (sel: string): Selector => {
  const [head = '', ...classes] = sel.split('.')
  const [tag = '', id] = head.split('#')
  return { tag: tag === '' ? 'div' : tag, id: Option.fromNullishOr(id), classes }
}

const propAttrNames: Readonly<Record<string, string>> = {
  className: 'class',
  htmlFor: 'for',
  tabIndex: 'tabindex',
  readOnly: 'readonly',
  maxLength: 'maxlength',
  minLength: 'minlength',
}

const attrNameOf = (property: string): string =>
  Option.getOrElse(Option.fromNullishOr(propAttrNames[property]), () => property)

const attributeText = (name: string, value: unknown): Option.Option<string> =>
  Match.value(value).pipe(
    Match.when(true, () => Option.some(name)),
    Match.when(Predicate.isNullish, () => Option.none<string>()),
    Match.when(false, () => Option.none<string>()),
    Match.orElse((present) => Option.some(`${name}="${escapeAttr(String(present))}"`)),
  )

const kebab = (name: string): string =>
  name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)

const joinedAttribute = (
  name: string,
  values: ReadonlyArray<string>,
  separator: string,
): Option.Option<string> =>
  values.length === 0
    ? Option.none()
    : Option.some(`${name}="${escapeAttr(Array.join(values, separator))}"`)

const idFragment = (selector: Selector, data: VNodeData): Option.Option<string> =>
  pipe(
    Option.orElse(selector.id, () =>
      Option.fromNullishOr(data.props?.id as string | undefined),
    ),
    Option.map((id) => `id="${escapeAttr(id)}"`),
  )

const classFragment = (selector: Selector, data: VNodeData): Option.Option<string> => {
  const declared = pipe(
    Object.entries(data.class ?? {}),
    Array.filter(([, on]) => on),
    Array.map(([name]) => name),
  )
  return joinedAttribute('class', [...selector.classes, ...declared], ' ')
}

const propsFragments = (data: VNodeData): ReadonlyArray<string> =>
  pipe(
    Object.entries(data.props ?? {}),
    Array.filter(([name]) => name !== 'id' && name !== 'className' && name !== 'innerHTML'),
    Array.map(([name, value]) => attributeText(attrNameOf(name), value)),
    Array.getSomes,
  )

const attrsFragments = (data: VNodeData): ReadonlyArray<string> =>
  pipe(
    Object.entries(data.attrs ?? {}),
    Array.map(([name, value]) => attributeText(name, value)),
    Array.getSomes,
  )

const styleFragment = (data: VNodeData): Option.Option<string> =>
  joinedAttribute(
    'style',
    pipe(
      Object.entries(data.style ?? {}),
      Array.map(([property, value]) => `${kebab(property)}: ${value}`),
    ),
    '; ',
  )

const datasetFragments = (data: VNodeData): ReadonlyArray<string> =>
  pipe(
    Object.entries(data.dataset ?? {}),
    Array.map(([name, value]) => `data-${kebab(name)}="${escapeAttr(String(value))}"`),
  )

const keyFragment = (data: VNodeData): Option.Option<string> =>
  pipe(
    Option.fromNullishOr(data.key),
    Option.map((key) => `data-fk-key="${escapeAttr(String(key))}"`),
  )

const htmlMarkerFragment = (data: VNodeData): Option.Option<string> =>
  data.props?.innerHTML === undefined ? Option.none() : Option.some('data-fk-html')

const attributeFragments = (selector: Selector, data: VNodeData): ReadonlyArray<string> => [
  ...Array.getSomes([idFragment(selector, data), classFragment(selector, data)]),
  ...propsFragments(data),
  ...attrsFragments(data),
  ...Array.getSomes([styleFragment(data)]),
  ...datasetFragments(data),
  ...Array.getSomes([keyFragment(data), htmlMarkerFragment(data)]),
]

const voidTags: ReadonlySet<string> = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
])

const openingTag = (tag: string, attributes: ReadonlyArray<string>): string =>
  attributes.length === 0
    ? `<${tag}>`
    : `<${tag} ${Array.join(attributes, ' ')}>`

const childFragments = (child: VNode | string): ReadonlyArray<string> =>
  typeof child === 'string' ? [escapeText(child)] : nodeFragments(child)

const innerFragments = (
  data: VNodeData,
  children: ReadonlyArray<VNode | string>,
): ReadonlyArray<string> =>
  Option.match(Option.fromNullishOr(data.props?.innerHTML as string | undefined), {
    onSome: (raw) => [raw],
    onNone: () => Array.flatMap(children, childFragments),
  })

const elementFragments = (
  sel: string,
  data: VNodeData,
  children: ReadonlyArray<VNode | string>,
): ReadonlyArray<string> => {
  const selector = parseSelector(sel)
  const opening = openingTag(selector.tag, attributeFragments(selector, data))
  return voidTags.has(selector.tag)
    ? [opening]
    : [opening, ...innerFragments(data, children), `</${selector.tag}>`]
}

type NodeKind = Data.TaggedEnum<{
  Text: { readonly text: string }
  Comment: { readonly text: string }
  Fragment: { readonly children: ReadonlyArray<VNode | string> }
  Element: {
    readonly sel: string
    readonly data: VNodeData
    readonly children: ReadonlyArray<VNode | string>
  }
}>

const { Text, Comment, Fragment, Element } = Data.taggedEnum<NodeKind>()

const nodeKindOf = (node: VNode): NodeKind =>
  Match.value(node).pipe(
    Match.when({ sel: '!' }, (comment) => Comment({ text: comment.text ?? '' })),
    Match.when(
      (candidate) => candidate.sel === undefined && typeof candidate.text === 'string',
      (text) => Text({ text: text.text as string }),
    ),
    Match.when(
      (candidate) => candidate.sel === undefined,
      (fragment) => Fragment({ children: fragment.children ?? [] }),
    ),
    Match.orElse((element) =>
      Element({
        sel: element.sel as string,
        data: element.data ?? {},
        children: element.children ?? [],
      }),
    ),
  )

const nodeFragments = (node: VNode): ReadonlyArray<string> =>
  Match.value(nodeKindOf(node)).pipe(
    Match.tag('Text', ({ text }) => [escapeText(text)]),
    Match.tag('Comment', ({ text }) => [`<!--${text}-->`]),
    Match.tag('Fragment', ({ children }) => Array.flatMap(children, childFragments)),
    Match.tag('Element', ({ sel, data, children }) => elementFragments(sel, data, children)),
    Match.exhaustive,
  )

const fragmentsOfHtml = (html: Html): ReadonlyArray<string> =>
  html === null ? [] : nodeFragments(html)

export class FoldkitRender extends Context.Service<FoldkitRender>()('FoldkitRender', {
  make: Effect.succeed({
    renderToString: (html: Html): Effect.Effect<string> =>
      Effect.succeed(Array.join(fragmentsOfHtml(html), '')),
    renderToStream: (html: Html): Stream.Stream<string> =>
      Stream.fromIterable(fragmentsOfHtml(html)),
  } as const),
}) {
  static readonly layer = Layer.effect(this, this.make)
}
