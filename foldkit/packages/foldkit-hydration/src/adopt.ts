import { Array, Match, pipe } from 'effect'
import type { VNode, VNodeData } from 'snabbdom'

const PROPERTY_NAMES = [
  'accept', 'action', 'alt', 'autocomplete', 'autofocus', 'autoplay', 'checked',
  'cite', 'colSpan', 'cols', 'controls', 'dateTime', 'dir', 'disabled', 'download',
  'draggable', 'enctype', 'formAction', 'formEnctype', 'formMethod', 'formNoValidate',
  'formTarget', 'hidden', 'high', 'href', 'htmlFor', 'id', 'inert', 'isMap', 'label',
  'lang', 'loop', 'low', 'max', 'maxLength', 'method', 'min', 'minLength', 'multiple',
  'muted', 'name', 'noValidate', 'open', 'optimum', 'pattern', 'placeholder',
  'playsInline', 'poster', 'preload', 'readOnly', 'rel', 'required', 'reversed',
  'rowSpan', 'rows', 'selected', 'size', 'span', 'src', 'start', 'step', 'tabIndex',
  'target', 'title', 'type', 'value', 'wrap',
]

const propertyOfAttribute: Readonly<Record<string, string>> = {
  ...Object.fromEntries(PROPERTY_NAMES.map((name) => [name.toLowerCase(), name])),
  for: 'htmlFor',
}

const BOOLEAN_PROPERTIES: ReadonlySet<string> = new Set([
  'autofocus', 'autoplay', 'checked', 'controls', 'disabled', 'draggable', 'hidden',
  'inert', 'isMap', 'loop', 'multiple', 'muted', 'noValidate', 'formNoValidate',
  'open', 'playsInline', 'readOnly', 'required', 'reversed', 'selected',
])

const adoptClasses = (value: string): Record<string, boolean> =>
  pipe(
    value.split(/\s+/),
    Array.filter((name) => name.length > 0),
    Array.reduce({} as Record<string, boolean>, (classes, name) => ({ ...classes, [name]: true })),
  )

type Buckets = {
  readonly props: Record<string, string | boolean>
  readonly classes: Record<string, boolean>
  readonly attrs: Record<string, string>
  readonly key: string | undefined
  readonly rawHtml: boolean
}

const emptyBuckets: Buckets = { props: {}, classes: {}, attrs: {}, key: undefined, rawHtml: false }

const classify = (buckets: Buckets, attribute: Attr): Buckets =>
  Match.value(attribute.name).pipe(
    Match.when('class', () => ({
      ...buckets,
      classes: { ...buckets.classes, ...adoptClasses(attribute.value) },
    })),
    Match.when('data-fk-key', () => ({ ...buckets, key: attribute.value })),
    Match.when('data-fk-html', () => ({ ...buckets, rawHtml: true })),
    Match.orElse(() => {
      const property = propertyOfAttribute[attribute.name]
      return property === undefined
        ? { ...buckets, attrs: { ...buckets.attrs, [attribute.name]: attribute.value } }
        : {
            ...buckets,
            props: {
              ...buckets.props,
              [property]: BOOLEAN_PROPERTIES.has(property) ? true : attribute.value,
            },
          }
    }),
  )

const foldBuckets = (element: Element): Buckets =>
  Array.reduce(Array.fromIterable(element.attributes), emptyBuckets, classify)

export const adopt = (node: Node): VNode => {
  if (node.nodeType === Node.TEXT_NODE) {
    return { sel: undefined, data: undefined, children: undefined, text: node.textContent ?? '', elm: node, key: undefined }
  }
  if (node.nodeType === Node.COMMENT_NODE) {
    return { sel: '!', data: {}, children: [], text: node.textContent ?? '', elm: node, key: undefined }
  }

  const element = node as Element
  const buckets = foldBuckets(element)
  const props = buckets.rawHtml
    ? { ...buckets.props, innerHTML: element.innerHTML }
    : buckets.props

  const data: VNodeData = {
    ...(Object.keys(props).length > 0 ? { props } : {}),
    ...(Object.keys(buckets.classes).length > 0 ? { class: buckets.classes } : {}),
    ...(Object.keys(buckets.attrs).length > 0 ? { attrs: buckets.attrs } : {}),
    ...(buckets.key !== undefined ? { key: buckets.key } : {}),
  }

  const children = buckets.rawHtml
    ? []
    : Array.map(Array.fromIterable(element.childNodes), adopt)

  return {
    sel: element.tagName.toLowerCase(),
    data,
    children,
    text: undefined,
    elm: element,
    key: buckets.key,
  }
}
