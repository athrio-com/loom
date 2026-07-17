const FILLS_KEY = '__foldkitFills'
const BOOTED_KEY = '__foldkitBooted'

export const BOUNDARY_ATTRIBUTE = 'data-fk-boundary'
export const BOUNDARY_FILL_EVENT = 'foldkit:boundary-fill'

export type BoundaryFill = { readonly id: string; readonly data: unknown }

type StreamingScope = {
  [FILLS_KEY]?: Array<BoundaryFill>
  [BOOTED_KEY]?: boolean
}

export const STREAMING_FILL_SCRIPT = `(function () {
  var fills = (window.${FILLS_KEY} = window.${FILLS_KEY} || [])
  window.__foldkitFill = function (id, data) {
    var slot = document.querySelector('[${BOUNDARY_ATTRIBUTE}="' + id + '"]')
    var template = document.querySelector('template[data-fk-fill="' + id + '"]')
    if (!window.${BOOTED_KEY} && slot && template) {
      slot.replaceChildren(template.content.cloneNode(true))
    }
    fills.push({ id: id, data: data })
    window.dispatchEvent(new CustomEvent('${BOUNDARY_FILL_EVENT}', { detail: { id: id, data: data } }))
  }
})();`

export const boundaryFillChunk = (
  id: string,
  innerHtml: string,
  dataJson: string,
): string =>
  `<template data-fk-fill="${id}">${innerHtml}</template>` +
  `<script>window.__foldkitFill(${JSON.stringify(id)},${dataJson})</script>`

export const markBooted = (): void => {
  ;(window as unknown as StreamingScope)[BOOTED_KEY] = true
}

export const bufferedFills = (): ReadonlyArray<BoundaryFill> =>
  (window as unknown as StreamingScope)[FILLS_KEY] ?? []
