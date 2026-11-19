import { Array, Match, Option, pipe } from 'effect'
import ignore, { type Ignore } from 'ignore'
import { existsSync, readdirSync, readFileSync, type Dirent } from 'node:fs'
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve as resolvePath,
  sep,
} from 'node:path'
import { type ResolvedConfig } from '@athrio/loom-config/LoomConfig'
import { configurationOf, isWorkspace } from '@athrio/loom-lang-services/LoomStore'

export type Path = string

export interface LoomProject {
  readonly root: Path
  readonly ignore: ReadonlyArray<string>
}

export const projectIn = (config: ResolvedConfig): Option.Option<LoomProject> =>
  Option.map(Option.fromNullishOr(config.workspaceRoot), (root) => ({
    root,
    ignore: config.ignore ?? [],
  }))

interface Layer {
  readonly base: Path
  readonly rules: Ignore
}

const layerOf = (base: Path, patterns: string | ReadonlyArray<string>): Layer => ({
  base,
  rules: ignore().add(patterns),
})

const relativeIn = (base: Path, path: Path): Option.Option<string> => {
  const rel = relative(base, path)
  return rel === '' || rel.split(sep)[0] === '..' || isAbsolute(rel)
    ? Option.none()
    : Option.some(rel.split(sep).join('/'))
}

const verdictOf: (tested: ReturnType<Ignore['test']>) => Option.Option<boolean> = Match.type<
  ReturnType<Ignore['test']>
>().pipe(
  Match.when({ ignored: true }, () => Option.some(true)),
  Match.when({ unignored: true }, () => Option.some(false)),
  Match.orElse(() => Option.none<boolean>()),
)

const verdictIn = (layer: Layer, path: Path, isDir: boolean): Option.Option<boolean> =>
  Option.flatMap(relativeIn(layer.base, path), (rel) =>
    verdictOf(layer.rules.test(isDir ? `${rel}/` : rel)),
  )

const textOf = (file: Path): Option.Option<string> => {
  try {
    return Option.some(readFileSync(file, 'utf8'))
  } catch {
    return Option.none()
  }
}

const fileLayer = (base: Path, file: Path): Option.Option<Layer> =>
  Option.map(textOf(file), (text) => layerOf(base, text))

const gitDirOf = (top: Path): Path =>
  pipe(
    textOf(join(top, '.git')),
    Option.map((text) => resolvePath(top, text.replace(/^gitdir:/, '').trim())),
    Option.getOrElse(() => join(top, '.git')),
  )

const commonDirOf = (gitDir: Path): Path =>
  pipe(
    textOf(join(gitDir, 'commondir')),
    Option.map((text) => resolvePath(gitDir, text.trim())),
    Option.getOrElse(() => gitDir),
  )

const excludeOf = (top: Path): Path => join(commonDirOf(gitDirOf(top)), 'info', 'exclude')

const repositoryAt = (top: Path): ReadonlyArray<Layer> =>
  Array.getSomes([fileLayer(top, excludeOf(top)), fileLayer(top, join(top, '.gitignore'))])

type GitRules = Option.Option<ReadonlyArray<Layer>>

const entering = (dir: Path, outside: GitRules): GitRules =>
  existsSync(join(dir, '.git'))
    ? Option.some(repositoryAt(dir))
    : Option.map(outside, (layers) => [
        ...layers,
        ...Option.toArray(fileLayer(dir, join(dir, '.gitignore'))),
      ])

const gitRulesAt = (dir: Path): GitRules => {
  const parent = dirname(dir)
  return entering(dir, parent === dir ? Option.none() : gitRulesAt(parent))
}

const defaultIgnore: ReadonlyArray<string> = ['*.fixture.loom']

const ignores = (own: Layer, git: GitRules, path: Path, isDir: boolean): boolean =>
  pipe(
    [own, ...Array.reverse(Option.getOrElse(git, (): ReadonlyArray<Layer> => []))],
    Array.findFirst((layer) => verdictIn(layer, path, isDir)),
    Option.getOrElse(() => false),
  )

export interface Reading<Answer> {
  readonly answer: Answer
  readonly from: ReadonlyArray<Path>
}

const gitFilesOf = (dir: Path): ReadonlyArray<Path> => [
  join(dir, '.git'),
  join(dir, '.gitignore'),
  ...(existsSync(join(dir, '.git')) ? [join(gitDirOf(dir), 'commondir'), excludeOf(dir)] : []),
]

const gitFilesTo = (dir: Path): ReadonlyArray<Path> => {
  const parent = dirname(dir)
  return [...(parent === dir ? [] : gitFilesTo(parent)), ...gitFilesOf(dir)]
}

const askedAbout = (dir: Path): ReadonlyArray<Path> => [configurationOf(dir), ...gitFilesOf(dir)]

export const storeDirs: ReadonlySet<string> = new Set(['node_modules', '.loom', 'dist', '.git'])

interface Scope {
  readonly opens: (dir: Path) => boolean
  readonly keeps: (loom: Path) => boolean
  readonly into: (dir: Path) => Scope
  readonly asks: (dir: Path) => ReadonlyArray<Path>
}

const projectScope = (own: Layer, git: GitRules): Scope => ({
  opens: (dir) =>
    !storeDirs.has(basename(dir)) && !isWorkspace(dir) && !ignores(own, git, dir, true),
  keeps: (loom) => !ignores(own, git, loom, false),
  into: (dir) => projectScope(own, entering(dir, git)),
  asks: askedAbout,
})

const looseScope: Scope = {
  opens: (dir) => !storeDirs.has(basename(dir)),
  keeps: () => true,
  into: () => looseScope,
  asks: () => [],
}

const scopeAt = (project: LoomProject, dir: Path): Scope =>
  projectScope(layerOf(project.root, [...defaultIgnore, ...project.ignore]), gitRulesAt(dir))

const entriesIn = (dir: Path): ReadonlyArray<Dirent> => {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

type Walk = Reading<ReadonlyArray<Path>>

const noLooms: Walk = { answer: [], from: [] }

const readingAt = Match.fn(
  (
    _within: {
      readonly full: Path
      readonly scope: Scope
    },
    entry: { readonly opened: boolean; readonly closed: boolean; readonly kept: boolean },
  ) => entry,
).pipe(
  Match.withReturnType<Walk>(),
  Match.when({ opened: true }, (_entry, { full, scope }) => {
    const below = walk(full, scope.into(full))
    return { answer: below.answer, from: [...scope.asks(full), ...below.from] }
  }),
  Match.when({ closed: true }, (_entry, { full, scope }) => ({ answer: [], from: scope.asks(full) })),
  Match.when({ kept: true }, (_entry, { full }) => ({ answer: [full], from: [] })),
  Match.orElse(() => noLooms),
)

const walk = (dir: Path, scope: Scope): Walk => {
  const below = entriesIn(dir).map((entry) => {
    const full = resolvePath(dir, entry.name)
    const opened = entry.isDirectory() && scope.opens(full)
    return readingAt({ full, scope }, {
      opened,
      closed: entry.isDirectory() && !opened && !storeDirs.has(entry.name),
      kept: !entry.isDirectory() && entry.name.endsWith('.loom') && scope.keeps(full),
    })
  })
  return {
    answer: below.flatMap((reading) => reading.answer),
    from: [dir, ...below.flatMap((reading) => reading.from)],
  }
}

export const walkIn = (dir: Path, project: Option.Option<LoomProject>): Walk =>
  Option.match(project, {
    onNone: () => walk(dir, looseScope),
    onSome: (p) => {
      const below = walk(dir, scopeAt(p, dir))
      return { answer: below.answer, from: [...gitFilesTo(dir), ...below.from] }
    },
  })

export const loomsIn = (dir: Path, project: Option.Option<LoomProject>): ReadonlyArray<Path> =>
  walkIn(dir, project).answer

const foldersBetween = (root: Path, dir: Path): ReadonlyArray<Path> =>
  dir === root || dirname(dir) === dir ? [] : [...foldersBetween(root, dirname(dir)), dir]

const holdsFrom =
  (project: LoomProject, atRoot: Scope) =>
  (loom: Path): boolean =>
    Option.isSome(relativeIn(project.root, loom)) &&
    pipe(
      foldersBetween(project.root, dirname(loom)).reduce(
        (scope, dir) =>
          scope.pipe(
            Option.filter((s) => s.opens(dir)),
            Option.map((s) => s.into(dir)),
          ),
        Option.some(atRoot),
      ),
      Option.exists((scope) => scope.keeps(loom)),
    )

export const holdsOf = (project: LoomProject): Reading<(loom: Path) => boolean> => ({
  answer: holdsFrom(project, scopeAt(project, project.root)),
  from: gitFilesTo(project.root),
})

export const holds = (project: LoomProject, loom: Path): boolean => holdsOf(project).answer(loom)
