import { Array, Match, Option, Record } from 'effect'

export type Tagged = { readonly type: string }

type Node = Tagged & Readonly<Record<string, unknown>>

const isNode = (value: unknown): value is Node =>
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
): Rewritten<Tree, Edits> => walked(tree, cases as AnyCases) as Rewritten<Tree, Edits>

const walked = (value: unknown, cases: AnyCases): unknown =>
  Match.value(value).pipe(
    Match.when(Array.isArray, (items) => walkedItems(items, cases)),
    Match.when(isNode, (node) =>
      Option.match(Record.get(cases, node.type), {
        onSome: (edit) => edit(node),
        onNone: () => walkedFields(node, cases),
      }),
    ),
    Match.orElse((plain) => plain),
  )

const walkedItems = (items: ReadonlyArray<unknown>, cases: AnyCases): ReadonlyArray<unknown> => {
  const next = Array.map(items, (item) => walked(item, cases))
  return Array.every(next, (item, at) => item === items[at]) ? items : next
}

const walkedFields = (node: Node, cases: AnyCases): Node => {
  const next = Record.map(node, (field) => walked(field, cases))
  return Record.every(next, (field, key) => field === node[key])
    ? node
    : { ...next, type: node.type }
}
