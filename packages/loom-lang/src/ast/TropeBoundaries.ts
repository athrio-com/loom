import { Array, Option, pipe, Result } from 'effect'
import type { Diagnostic, Position } from '@athrio/loom-ast/LoomNode'
import type { FrontmatterEntryToken } from '@athrio/loom-ast/LoomTokens'
import {
  type Book,
  tropeEntryModuleOf,
  type Location,
  type LoomModule,
  reach,
  reachesOf,
} from '@athrio/loom-ast/LoomCorpusAst'
import {
  EntriesOffRoot,
  faulty,
  ReachingInside,
  UnknownEntry,
  UnreachedMember,
  UnrootedTrope,
  UnsettledMember,
} from './LoomFault'
import { rootsTrope, titleOf, type Trope, tropeLineOf, tropeOf } from './DeclaredKinds'

export type UnknownName = {
  readonly name: FrontmatterEntryToken
  readonly owner: Option.Option<string>
}

export type Boundary = {
  readonly trope: string
  readonly root: LoomModule
  readonly entries: ReadonlyArray<LoomModule>
  readonly unknown: ReadonlyArray<UnknownName>
  readonly guarded: ReadonlyArray<LoomModule>
  readonly unreached: ReadonlyArray<LoomModule>
  readonly unsettled: ReadonlyArray<LoomModule>
  readonly insiders: ReadonlySet<Location>
}

export type Boundaries = {
  readonly bounded: ReadonlyArray<Boundary>
  readonly unrooted: ReadonlyArray<Trope>
}

const entryOf = (
  book: Book,
  trope: string,
  name: FrontmatterEntryToken,
): Result.Result<LoomModule, UnknownName> =>
  Option.match(tropeEntryModuleOf(book, name.value), {
    onNone: () => Result.fail({ name, owner: Option.none() }),
    onSome: (module) =>
      Option.match(
        Option.filter(tropeOf(module), (owner) => owner !== trope),
        {
          onNone: () => Result.succeed(module),
          onSome: (owner) => Result.fail({ name, owner: Option.some(owner) }),
        },
      ),
  })

const entriesOf = (
  book: Book,
  trope: string,
  root: LoomModule,
): readonly [ReadonlyArray<LoomModule>, ReadonlyArray<UnknownName>] =>
  Option.match(Option.fromNullishOr(root.doc.frontmatter?.entries), {
    onNone: () => [[root], []],
    onSome: (names) => Array.separate(Array.map(names, (name) => entryOf(book, trope, name))),
  })

const outsideEveryTrope = (module: LoomModule): boolean =>
  Option.isNone(tropeOf(module)) && module.doc.frontmatter?.discussion === undefined

const boundaryOf = (
  modules: ReadonlyMap<Location, LoomModule>,
  book: Book,
  trope: Trope,
  root: LoomModule,
): Boundary => {
  const chapters = new Map(Array.map(trope.chapters, (chapter) => [chapter.path, chapter] as const))
  const [entries, unknown] = entriesOf(book, trope.name, root)
  const reached = reach([root.path, ...Array.map(entries, (module) => module.path)], (path) =>
    Option.match(Option.fromNullishOr(chapters.get(path)), {
      onNone: (): ReadonlyArray<Location> => [],
      onSome: (chapter) => Array.map(reachesOf(book, chapter), (each) => each.target),
    }),
  )
  const unsettled = pipe(
    Array.fromIterable(reached),
    Array.filter((path) => !chapters.has(path)),
    Array.flatMap((path) => Option.toArray(Option.fromNullishOr(modules.get(path)))),
    Array.filter(outsideEveryTrope),
  )
  const entered = new Set(Array.map(entries, (module) => module.path))
  return {
    trope: trope.name,
    root,
    entries,
    unknown,
    guarded: Array.filter(trope.chapters, (chapter) => !entered.has(chapter.path)),
    unreached: Array.filter(
      trope.chapters,
      (chapter) => !reached.has(chapter.path) && !rootsTrope(chapter),
    ),
    unsettled,
    insiders: new Set([...chapters.keys(), ...Array.map(unsettled, (module) => module.path)]),
  }
}

export const boundariesOf = (
  modules: ReadonlyMap<Location, LoomModule>,
  book: Book,
  tropes: ReadonlyArray<Trope>,
): Boundaries => ({
  bounded: Array.getSomes(
    Array.map(tropes, (trope) =>
      Option.map(trope.root, (root) => boundaryOf(modules, book, trope, root)),
    ),
  ),
  unrooted: Array.filter(tropes, (trope) => Option.isNone(trope.root)),
})

const titleLineOf = (module: LoomModule): Position =>
  Option.getOrElse(
    Option.map(Option.fromNullishOr(module.doc.frontmatter?.title), (title) => title.position),
    () => ({ start: module.doc.position.start, end: module.doc.position.start }),
  )

const isModule =
  (module: LoomModule) =>
  (other: LoomModule): boolean =>
    other.path === module.path

const unrootedFaults = (boundaries: Boundaries, module: LoomModule): ReadonlyArray<Diagnostic> =>
  pipe(
    boundaries.unrooted,
    Array.filter((trope) => Array.some(trope.chapters, isModule(module))),
    Array.flatMap(
      (trope) => faulty(UnrootedTrope({ trope: trope.name }), tropeLineOf(module)).diagnostics,
    ),
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

const entryFaults = (boundary: Boundary, module: LoomModule): ReadonlyArray<Diagnostic> =>
  isModule(module)(boundary.root)
    ? Array.flatMap(
        boundary.unknown,
        ({ name, owner }) =>
          faulty(
            UnknownEntry({
              name: name.value,
              ...Option.match(owner, { onNone: () => ({}), onSome: (held) => ({ owner: held }) }),
            }),
            name.position,
          ).diagnostics,
      )
    : []

const memberFaults = (boundary: Boundary, module: LoomModule): ReadonlyArray<Diagnostic> => [
  ...(Array.some(boundary.unreached, isModule(module))
    ? faulty(UnreachedMember({ trope: boundary.trope }), tropeLineOf(module)).diagnostics
    : []),
  ...(Array.some(boundary.unsettled, isModule(module))
    ? faulty(UnsettledMember({ trope: boundary.trope }), titleLineOf(module)).diagnostics
    : []),
]

export const boundaryFaults = (
  boundaries: Boundaries,
  book: Book,
  module: LoomModule,
): ReadonlyArray<Diagnostic> => [
  ...unrootedFaults(boundaries, module),
  ...entriesOffRoot(module),
  ...Array.flatMap(boundaries.bounded, (boundary) => [
    ...entryFaults(boundary, module),
    ...memberFaults(boundary, module),
  ]),
  ...reachingInside(boundaries, book, module),
]

const reachingInside = (
  boundaries: Boundaries,
  book: Book,
  module: LoomModule,
): ReadonlyArray<Diagnostic> => {
  const guarding = Array.filter(
    boundaries.bounded,
    (boundary) =>
      Array.isReadonlyArrayNonEmpty(boundary.guarded) && !boundary.insiders.has(module.path),
  )
  return Array.isReadonlyArrayNonEmpty(guarding)
    ? Array.flatMap(reachesOf(book, module), (each) =>
        Array.flatMap(guarding, (boundary) =>
          Option.match(
            Array.findFirst(boundary.guarded, (guarded) => guarded.path === each.target),
            {
              onNone: (): ReadonlyArray<Diagnostic> => [],
              onSome: (guarded) =>
                faulty(
                  ReachingInside({
                    trope: boundary.trope,
                    chapter: titleOf(guarded),
                    entries: Array.map(boundary.entries, titleOf),
                  }),
                  each.at,
                ).diagnostics,
            },
          ),
        ),
      )
    : []
}
