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
import { type Path } from '@athrio/loom-ast/LoomCorpusAst'
import { type BuildSettings } from './PackageConfig'
import { isWorkspace } from '@athrio/loom-lang-services/LoomStore'

export interface LoomProject {
  readonly root: Path
  readonly ignore: ReadonlyArray<string>
}

export const projectIn = (settings: BuildSettings): Option.Option<LoomProject> =>
  Option.map(Option.fromNullishOr(settings.workspaceRoot), (root) => ({
    root,
    ignore: settings.ignore ?? [],
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

const verdictIn = (layer: Layer, path: Path, isDir: boolean): Option.Option<boolean> =>
  Option.flatMap(relativeIn(layer.base, path), (rel) =>
    Match.value(layer.rules.test(isDir ? `${rel}/` : rel)).pipe(
      Match.when({ ignored: true }, () => Option.some(true)),
      Match.when({ unignored: true }, () => Option.some(false)),
      Match.orElse(() => Option.none<boolean>()),
    ),
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

const repositoryAt = (top: Path): ReadonlyArray<Layer> =>
  Array.getSomes([
    fileLayer(top, join(commonDirOf(gitDirOf(top)), 'info', 'exclude')),
    fileLayer(top, join(top, '.gitignore')),
  ])

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

export const storeDirs: ReadonlySet<string> = new Set(['node_modules', '.loom', 'dist', '.git'])

interface Scope {
  readonly opens: (dir: Path) => boolean
  readonly keeps: (loom: Path) => boolean
  readonly into: (dir: Path) => Scope
}

const projectScope = (own: Layer, git: GitRules): Scope => ({
  opens: (dir) =>
    !storeDirs.has(basename(dir)) && !isWorkspace(dir) && !ignores(own, git, dir, true),
  keeps: (loom) => !ignores(own, git, loom, false),
  into: (dir) => projectScope(own, entering(dir, git)),
})

const looseScope: Scope = {
  opens: (dir) => !storeDirs.has(basename(dir)),
  keeps: () => true,
  into: () => looseScope,
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

const walk = (dir: Path, scope: Scope): ReadonlyArray<Path> =>
  Array.flatMap(entriesIn(dir), (entry) => {
    const full = resolvePath(dir, entry.name)
    return Match.value(entry).pipe(
      Match.when(
        (e) => e.isDirectory() && scope.opens(full),
        () => walk(full, scope.into(full)),
      ),
      Match.when(
        (e) => !e.isDirectory() && e.name.endsWith('.loom') && scope.keeps(full),
        (): ReadonlyArray<Path> => [full],
      ),
      Match.orElse((): ReadonlyArray<Path> => []),
    )
  })

export const loomsIn = (dir: Path, project: Option.Option<LoomProject>): ReadonlyArray<Path> =>
  walk(
    dir,
    Option.match(project, {
      onNone: () => looseScope,
      onSome: (p) => scopeAt(p, dir),
    }),
  )

const foldersBetween = (root: Path, dir: Path): ReadonlyArray<Path> =>
  dir === root || dirname(dir) === dir ? [] : [...foldersBetween(root, dirname(dir)), dir]

export const holds = (project: LoomProject, loom: Path): boolean =>
  Option.isSome(relativeIn(project.root, loom)) &&
  pipe(
    foldersBetween(project.root, dirname(loom)),
    Array.reduce(Option.some(scopeAt(project, project.root)), (scope, dir) =>
      scope.pipe(
        Option.filter((s) => s.opens(dir)),
        Option.map((s) => s.into(dir)),
      ),
    ),
    Option.exists((scope) => scope.keeps(loom)),
  )
