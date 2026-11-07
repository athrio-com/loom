import { Array, Match, Option, Order, pipe } from 'effect'
import type { Diagnostic, Position } from '@athrio/loom-ast/LoomNode'
import type { FrontmatterEntryToken } from '@athrio/loom-ast/LoomTokens'
import {
  type Book,
  type Location,
  type LoomModule,
  reachesOf,
  tropeEntryModuleOf,
} from '@athrio/loom-ast/LoomCorpusAst'
import {
  CircularRoots,
  EntriesOffRoot,
  faulty,
  ForeignEntry,
  type LoomFault,
  PrivateEntry,
  ReachingInside,
  UnknownEntry,
  UnrootedTrope,
  UnsettledMember,
} from './LoomFault'
import { rootsTrope, titleOf, type Trope, tropeOf } from './DeclaredKinds'

export type Listed = {
  readonly name: FrontmatterEntryToken
  readonly chapter: Option.Option<LoomModule>
}

export type TropeNode = {
  readonly name: string
  readonly root: LoomModule
  readonly parent: Option.Option<string>
  readonly listed: ReadonlyArray<Listed>
  readonly entries: ReadonlyArray<Location>
}

export type Boundaries = {
  readonly tropes: ReadonlyMap<string, TropeNode>
  readonly chains: ReadonlyMap<Location, ReadonlyArray<string>>
  readonly derived: ReadonlyMap<Location, string>
}

const parentOf = (root: LoomModule): Option.Option<string> =>
  Option.map(Option.fromNullishOr(root.doc.frontmatter?.rootedIn), (line) => line.value)

const nodeOf = (book: Book, trope: Trope, root: LoomModule): TropeNode => {
  const names = Option.fromNullishOr(root.doc.frontmatter?.entries)
  const listed = Array.map(
    Option.getOrElse(names, () => []),
    (name): Listed => ({ name, chapter: tropeEntryModuleOf(book, name.value) }),
  )
  return {
    name: trope.name,
    root,
    parent: parentOf(root),
    listed,
    entries: Option.isNone(names)
      ? [root.path]
      : Array.getSomes(Array.map(listed, (entry) => Option.map(entry.chapter, (m) => m.path))),
  }
}

const chainOf = (
  tropes: ReadonlyMap<string, TropeNode>,
  name: string,
  seen: ReadonlySet<string> = new Set(),
): ReadonlyArray<string> =>
  seen.has(name)
    ? []
    : Option.match(Option.fromNullishOr(tropes.get(name)), {
        onNone: (): ReadonlyArray<string> => [],
        onSome: (node) => [
          name,
          ...Option.match(node.parent, {
            onNone: (): ReadonlyArray<string> => [],
            onSome: (parent) => chainOf(tropes, parent, new Set([...seen, name])),
          }),
        ],
      })

const namesNoTrope = (module: LoomModule): boolean =>
  Option.isNone(tropeOf(module)) && module.doc.frontmatter?.discussion === undefined

export const boundariesOf = (
  modules: ReadonlyMap<Location, LoomModule>,
  book: Book,
  gathered: ReadonlyArray<Trope>,
): Boundaries => {
  const tropes: ReadonlyMap<string, TropeNode> = new Map(
    Array.getSomes(
      Array.map(gathered, (trope) =>
        Option.map(trope.root, (root) => [trope.name, nodeOf(book, trope, root)] as const),
      ),
    ),
  )
  const held = pipe(
    gathered,
    Array.filter((trope) => tropes.has(trope.name)),
    Array.flatMap((trope) => trope.chapters),
    Array.sort(Order.mapInput(Order.String, (module: LoomModule) => module.path)),
  )
  const chains = new Map(
    Array.map(held, (module) => [
      module.path,
      Option.match(tropeOf(module), {
        onNone: (): ReadonlyArray<string> => [],
        onSome: (name) => chainOf(tropes, name),
      }),
    ]),
  )
  const derived = Array.reduce(held, new Map<Location, string>(), (found, module) =>
    Option.match(tropeOf(module), {
      onNone: () => found,
      onSome: (trope) =>
        Array.reduce(reachesOf(book, module), found, (was, each) =>
          was.has(each.target) ||
          !Option.exists(Option.fromNullishOr(modules.get(each.target)), namesNoTrope)
            ? was
            : new Map(was).set(each.target, trope),
        ),
    }),
  )
  return { tropes, chains, derived }
}

const titleLineOf = (module: LoomModule): Position =>
  Option.getOrElse(
    Option.map(Option.fromNullishOr(module.doc.frontmatter?.title), (title) => title.position),
    () => ({ start: module.doc.position.start, end: module.doc.position.start }),
  )

const entriesOffRoot = (module: LoomModule): ReadonlyArray<Diagnostic> =>
  rootsTrope(module)
    ? []
    : pipe(
        Option.fromNullishOr(module.doc.frontmatter?.entries),
        Option.flatMap(Array.head),
        Option.match({
          onNone: (): ReadonlyArray<Diagnostic> => [],
          onSome: (name) => faulty(EntriesOffRoot(), name.position).diagnostics,
        }),
      )

const loopOf = (
  tropes: ReadonlyMap<string, TropeNode>,
  start: string,
): Option.Option<ReadonlyArray<string>> => {
  const walk = (name: string, path: ReadonlyArray<string>): Option.Option<ReadonlyArray<string>> =>
    pipe(
      Option.fromNullishOr(tropes.get(name)),
      Option.flatMap((node) => node.parent),
      Option.flatMap((parent) =>
        Match.value(parent).pipe(
          Match.when(
            (next: string) => next === start,
            (next) => Option.some([...path, next]),
          ),
          Match.when(
            (next: string) => path.includes(next),
            () => Option.none<ReadonlyArray<string>>(),
          ),
          Match.orElse((next) => walk(next, [...path, next])),
        ),
      ),
    )
  return walk(start, [start])
}

const rootedInFaults = (boundaries: Boundaries, module: LoomModule): ReadonlyArray<Diagnostic> =>
  Option.match(Option.fromNullishOr(module.doc.frontmatter?.rootedIn), {
    onNone: (): ReadonlyArray<Diagnostic> => [],
    onSome: (line) =>
      !boundaries.tropes.has(line.value)
        ? faulty(UnrootedTrope({ trope: line.value }), line.position).diagnostics
        : Option.match(
            Option.flatMap(
              Option.filter(tropeOf(module), () => rootsTrope(module)),
              (own) => loopOf(boundaries.tropes, own),
            ),
            {
              onNone: (): ReadonlyArray<Diagnostic> => [],
              onSome: (loop) => faulty(CircularRoots({ loop }), line.position).diagnostics,
            },
          ),
  })

const undeclaredFaults = (boundaries: Boundaries, module: LoomModule): ReadonlyArray<Diagnostic> =>
  Option.match(Option.fromNullishOr(boundaries.derived.get(module.path)), {
    onNone: (): ReadonlyArray<Diagnostic> => [],
    onSome: (trope) => faulty(UnsettledMember({ trope }), titleLineOf(module)).diagnostics,
  })

const isEntry = (boundaries: Boundaries, trope: string, path: Location): boolean =>
  Option.exists(Option.fromNullishOr(boundaries.tropes.get(trope)), (node) =>
    node.entries.includes(path),
  )

const chainIn = (boundaries: Boundaries, path: Location): ReadonlyArray<string> =>
  Option.getOrElse(Option.fromNullishOr(boundaries.chains.get(path)), () => [])

const listedFault = (
  boundaries: Boundaries,
  trope: string,
  entry: Listed,
): Option.Option<LoomFault> =>
  Option.match(entry.chapter, {
    onNone: () => Option.some(UnknownEntry({ name: entry.name.value })),
    onSome: (chapter) => {
      const chain = chainIn(boundaries, chapter.path)
      const within = chain.indexOf(trope)
      return Option.flatMap(Array.head(chain), (innermost): Option.Option<LoomFault> =>
        within < 0
          ? Option.some(ForeignEntry({ name: entry.name.value, trope: innermost }))
          : Option.map(
              Array.findFirst(
                Array.take(chain, within),
                (inner) => !isEntry(boundaries, inner, chapter.path),
              ),
              (inner) => PrivateEntry({ name: entry.name.value, trope: inner }),
            ),
      )
    },
  })

const entryFaults = (boundaries: Boundaries, module: LoomModule): ReadonlyArray<Diagnostic> =>
  pipe(
    Array.fromIterable(boundaries.tropes.values()),
    Array.filter((node) => node.root.path === module.path),
    Array.flatMap((node) =>
      Array.flatMap(node.listed, (entry) =>
        Option.match(listedFault(boundaries, node.name, entry), {
          onNone: (): ReadonlyArray<Diagnostic> => [],
          onSome: (fault) => faulty(fault, entry.name.position).diagnostics,
        }),
      ),
    ),
  )

const crossedFault = (
  boundaries: Boundaries,
  modules: ReadonlyMap<Location, LoomModule>,
  own: ReadonlyArray<string>,
  target: LoomModule,
): Option.Option<LoomFault> =>
  pipe(
    Array.findLast(
      Array.filter(chainIn(boundaries, target.path), (trope) => !own.includes(trope)),
      (trope) => !isEntry(boundaries, trope, target.path),
    ),
    Option.flatMap((trope) => Option.fromNullishOr(boundaries.tropes.get(trope))),
    Option.map((node) =>
      ReachingInside({
        chapter: titleOf(target),
        trope: node.name,
        entries: Array.getSomes(
          Array.map(node.entries, (path) =>
            Option.map(Option.fromNullishOr(modules.get(path)), titleOf),
          ),
        ),
      }),
    ),
  )

const reachingInside = (
  boundaries: Boundaries,
  book: Book,
  modules: ReadonlyMap<Location, LoomModule>,
  module: LoomModule,
): ReadonlyArray<Diagnostic> => {
  const own = Option.match(Option.fromNullishOr(boundaries.chains.get(module.path)), {
    onSome: (chain) => chain,
    onNone: () =>
      Option.match(Option.fromNullishOr(boundaries.derived.get(module.path)), {
        onNone: (): ReadonlyArray<string> => [],
        onSome: (trope) => chainOf(boundaries.tropes, trope),
      }),
  })
  return boundaries.tropes.size === 0
    ? []
    : Array.flatMap(reachesOf(book, module), (each) =>
        Option.match(
          Option.flatMap(Option.fromNullishOr(modules.get(each.target)), (target) =>
            crossedFault(boundaries, modules, own, target),
          ),
          {
            onNone: (): ReadonlyArray<Diagnostic> => [],
            onSome: (fault) => faulty(fault, each.at).diagnostics,
          },
        ),
      )
}

export const boundaryFaults = (
  boundaries: Boundaries,
  book: Book,
  modules: ReadonlyMap<Location, LoomModule>,
  module: LoomModule,
): ReadonlyArray<Diagnostic> => [
  ...entriesOffRoot(module),
  ...rootedInFaults(boundaries, module),
  ...entryFaults(boundaries, module),
  ...undeclaredFaults(boundaries, module),
  ...reachingInside(boundaries, book, modules, module),
]
