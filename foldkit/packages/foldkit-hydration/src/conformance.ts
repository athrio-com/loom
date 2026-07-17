import { Array } from 'effect'

export const snapshotServerNodes = (container: Element): ReadonlyArray<Element> => {
  const root = container.firstElementChild
  return root === null ? [] : [root, ...Array.fromIterable(root.querySelectorAll('*'))]
}

export const warnOnHydrationRebuild = (
  serverNodes: ReadonlyArray<Element>,
  container: Element,
): void => {
  const rebuilt = Array.filter(serverNodes, (node) => !container.contains(node))
  if (rebuilt.length === 0) {
    return
  }
  const tags = [...new Set(Array.map(rebuilt, (node) => node.tagName.toLowerCase()))].join(', ')
  console.warn(
    `[foldkit] Hydration rebuilt ${rebuilt.length} server-rendered node(s) instead of ` +
      `merging onto them (${tags}). The view and the server HTML disagree in structure — ` +
      'often a browser normalization the view does not declare, such as a <tbody> injected ' +
      'into a table written without one, or content the view supplies through innerHTML. ' +
      'The server nodes were replaced, so first paint flickered and their DOM state was lost. ' +
      'Align the view with the HTML the browser parses so the two match node for node.',
  )
}
