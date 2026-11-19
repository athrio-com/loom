import { Array, Option, Record } from 'effect'

export type Tagged = { readonly type: string }

export type Node = Tagged & Readonly<Record<string, unknown>>

export const isNode = (value: unknown): value is Node =>
  typeof value === 'object' && value !== null && 'type' in value && typeof value.type === 'string'

export type NodesOf<Tree> =
  Tree extends ReadonlyArray<infer Item>
    ? NodesOf<Item>
    : Tree extends Tagged
      ? Tree | { readonly [Key in keyof Tree]-?: NodesOf<Tree[Key]> }[keyof Tree]
      : never

export type Cases<Tree, Edits> = {
  readonly [Tag in keyof Edits]: (
    node: Extract<NodesOf<Tree>, { readonly type: Tag }>,
  ) => Edits[Tag]
}

export type Rewritten<Tree, Edits> =
  Tree extends ReadonlyArray<infer Item>
    ? ReadonlyArray<Rewritten<Item, Edits>>
    : Tree extends { readonly type: infer Tag }
      ? Tag extends keyof Edits
        ? Edits[Tag]
        : { readonly [Key in keyof Tree]: Rewritten<Tree[Key], Edits> }
      : Tree

type Case = (node: Node) => unknown

type AnyCases = Readonly<Record<string, Case>>

export const rewritten = <Tree, Edits>(
  tree: Tree,
  cases: Cases<Tree, Edits>,
): Rewritten<Tree, Edits> => walked(cases as AnyCases, tree) as Rewritten<Tree, Edits>

const walked = (cases: AnyCases, value: unknown): unknown => {
  if (Array.isArray(value)) return walkedItems(value, cases)
  if (!isNode(value)) return value
  return Option.match(Record.get(cases, value.type), {
    onSome: (edit) => edit(value),
    onNone: () => walkedFields(value, cases),
  })
}

const walkedItems = (items: ReadonlyArray<unknown>, cases: AnyCases): ReadonlyArray<unknown> => {
  const next = items.map((item) => walked(cases, item))
  return next.every((item, at) => item === items[at]) ? items : next
}

const walkedFields = (node: Node, cases: AnyCases): Node => {
  const keys = Record.keys(node)
  const next = keys.map((key) => walked(cases, node[key]))
  return next.every((field, at) => field === node[keys[at]!])
    ? node
    : (Record.fromEntries(Array.zip(keys, next)) as Node)
}
