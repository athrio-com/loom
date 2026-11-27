import {
  Array,
  Cause,
  Console,
  Data,
  Effect,
  Equal,
  FileSystem,
  Logger,
  Match,
  Option,
  Order,
  Result,
  Schema,
  type Scope,
  Stream,
  pipe,
} from 'effect'
import { Argument, type CliError, Command, Flag, Prompt } from 'effect/cli'
import { ChildProcess } from 'effect/process'
import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { delimiter, dirname, relative, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { DocumentSource, LoomCompiler, type TangledFile } from '@athrio/loom-lang/LoomCompiler'
import {
  broke,
  failureIn,
  failureWording,
  type LoomFailure,
  type Problem,
  problem,
  reasonOf,
  refusedBy,
  type Wording,
} from '@athrio/loom-lang/ast/LoomFailure'
import { FileSystemEnvironment } from '@athrio/loom-lang/WorkspaceSource'
import { type Drift, driftsIn } from '@athrio/loom-lang/ast/Relations'
import { LanguagePackages } from '@athrio/loom-lang/LanguagePackages'
import { TropePackages } from '@athrio/loom-lang/TropePackages'
import { LoomTangler, NotWritten, readText } from '@athrio/loom-lang/LoomTangler'
import { LoomWeaver } from '@athrio/loom-lang/weave/LoomWeaver'
import { LoomSummaries } from '@athrio/loom-lang/LoomSummaries'
import { LoomFormatter } from '@athrio/loom-lang/LoomFormatter'
import {
  defaultWidth,
  isVariableName,
  LoomConfig,
  NotAVariableName,
  type SettingsNotWritten,
} from '@athrio/loom-config/LoomConfig'
import {
  installedTropeVersion,
  installedVersion,
  installService,
  installTropes,
  isLoomTrope,
  devBuild,
  devRegistry,
  embeddedFile,
  fetchedExecutable,
  fetchedTypeScriptDir,
  removeService,
  removeTropes,
  PackageInstall,
  servicePackage,
  serviceVersion,
  standalone,
  storeDir,
  tropesPackage,
  typeScriptVersion,
  workspaceOf,
  workspaceRoot,
} from '@athrio/loom-lang-services/LoomStore'
import type { LanguageService } from '@athrio/loom-lang-services/LanguageService'

const reset = '\x1b[0m'
const teal = (s: string): string => `\x1b[38;5;44m${s}${reset}`
const dim = (s: string): string => `\x1b[2m${s}${reset}`

const wordmark = [
  '   ██╗      ██████╗  ██████╗ ███╗   ███╗',
  '   ██║     ██╔═══██╗██╔═══██╗████╗ ████║',
  '   ██║     ██║   ██║██║   ██║██╔████╔██║',
  '   ██║     ██║   ██║██║   ██║██║╚██╔╝██║',
  '   ███████╗╚██████╔╝╚██████╔╝██║ ╚═╝ ██║',
  '   ╚══════╝ ╚═════╝  ╚═════╝ ╚═╝     ╚═╝',
].join('\n')

const banner = Console.log(`\n${teal(wordmark)}\n   ${dim('a literate framework')}\n`)

const reportWritten = (written: ReadonlyArray<TangledFile>): Effect.Effect<void> =>
  written.length === 0
    ? Console.log('loom: no {path} sinks to tangle')
    : Effect.forEach(written, (f) => Console.log(`loom: tangled ${f.section} → ${f.path}`), {
        discard: true,
      })

const tangleOnce = (file: string) =>
  Effect.gen(function* () {
    const tangler = yield* LoomTangler
    const written = yield* tangler.tangle(resolvePath(process.cwd(), file))
    yield* reportWritten(written)
  })

const tangleWatch = (file: string) =>
  Effect.gen(function* () {
    const tangler = yield* LoomTangler
    yield* Console.log(`loom: watching ${file} — re-tangling on change`)
    yield* Stream.runForEach(
      tangler.watch(resolvePath(process.cwd(), file)),
      Result.match({ onSuccess: reportWritten, onFailure: tell }),
    )
  })

const tangle = (file: string, watch: boolean) => (watch ? tangleWatch(file) : tangleOnce(file))

const orphans = (prune: boolean) =>
  Effect.gen(function* () {
    const tangler = yield* LoomTangler
    if (prune) {
      const removed = yield* tangler.prune(process.cwd())
      yield* removed.length === 0
        ? Console.log('loom: no orphans to prune')
        : Effect.forEach(removed, (path) => Console.log(`loom: pruned ${path}`))
    } else {
      const found = yield* tangler.orphans(process.cwd())
      yield* Effect.forEach(found, (path) => Console.log(path))
    }
  })

const weave = (file: string, out: string) =>
  Effect.gen(function* () {
    const weaver = yield* LoomWeaver
    const written = yield* weaver.weave(
      resolvePath(process.cwd(), file),
      resolvePath(process.cwd(), out),
    )
    yield* Console.log(`loom: wove ${file} → ${written}`)
  })

const refresh = (file: string) =>
  Effect.gen(function* () {
    const writer = yield* LoomSummaries
    const written = yield* writer.write(resolvePath(process.cwd(), file))
    yield* Array.isReadonlyArrayNonEmpty(written)
      ? Effect.forEach(written, (loom) => Console.log(`loom: refreshed the summaries in ${loom}`), {
          discard: true,
        })
      : Console.log('loom: every box is in step')
  })

const chosenAt = (
  target: string,
): { readonly path: string; readonly line: Option.Option<number> } =>
  Option.match(Option.fromNullishOr(/^(.*):(\d+)$/.exec(target)), {
    onNone: () => ({ path: target, line: Option.none<number>() }),
    onSome: (found) => ({ path: found[1] ?? target, line: Option.some(Number(found[2])) }),
  })

const onLine =
  (line: Option.Option<number>) =>
  (reference: { readonly at: { readonly start: { readonly line: number } } }): boolean =>
    Option.match(line, {
      onNone: () => true,
      onSome: (named) => reference.at.start.line === named,
    })

const approve = (target: string) =>
  Effect.gen(function* () {
    const compiler = yield* LoomCompiler
    const formatter = yield* LoomFormatter
    const { path, line } = chosenAt(target)
    const looms = yield* formatter.looms(resolvePath(process.cwd(), path))
    const approved = yield* Effect.forEach(looms, (loom) => compiler.approve(loom, onLine(line)))
    const count = approved.flat().length
    yield* count === 0
      ? Console.log(`loom: found no reference to approve at ${target}`)
      : Console.log(`loom: approved ${count} ${count === 1 ? 'reference' : 'references'}`)
  })

type Reviewed = {
  readonly loom: string
  readonly section: string
  readonly references: ReadonlyArray<{
    readonly at: string
    readonly kind: string
    readonly to: string
  }>
}

const reviewedFrom =
  (cwd: string) =>
  (drift: Drift): Reviewed => ({
    loom: relative(cwd, drift.loom),
    section: drift.section,
    references: drift.relations.map((relation) => ({
      at: `${relative(cwd, relation.loom)}:${relation.at.start.line}`,
      kind: relation.kind,
      to: relation.to,
    })),
  })

const driftText = (drift: Reviewed): string =>
  [
    `\`${drift.section}\` in ${drift.loom} has changed since these references to it were approved:`,
    ...drift.references.map((reference) => `  ${reference.at}  ${reference.kind}`),
  ].join('\n')

const reviewText = Match.fn(
  (
    drifts: ReadonlyArray<Reviewed>,
    json: boolean,
  ) => ({ json, drifted: Array.isReadonlyArrayNonEmpty(drifts) }),
).pipe(
  Match.withReturnType<string>(),
  Match.when({ json: true }, (_facts, drifts) => JSON.stringify(drifts, null, 2)),
  Match.when({ drifted: false }, () => 'loom: no approved reference has drifted'),
  Match.orElse((_facts, drifts) => drifts.map(driftText).join('\n\n')),
)

const review = (target: Option.Option<string>, json: boolean, check: boolean) =>
  Effect.gen(function* () {
    const compiler = yield* LoomCompiler
    const formatter = yield* LoomFormatter
    const cwd = process.cwd()
    const { path, line } = chosenAt(Option.getOrElse(target, () => '.'))
    const looms = yield* formatter.looms(resolvePath(cwd, path))
    const relations = yield* Effect.forEach(looms, (loom) => compiler.relations(loom))
    const drifts = driftsIn(relations.flat().filter(onLine(line)))
    yield* Console.log(reviewText(drifts.map(reviewedFrom(cwd)), json))
    if (check && Array.isReadonlyArrayNonEmpty(drifts)) yield* exitNonZero
  })

const writing = <A>(path: string, write: (path: string) => A): Effect.Effect<A, NotWritten> =>
  Effect.try({ try: () => write(path), catch: (cause) => new NotWritten({ path, cause }) })

const readIfThere = (fs: FileSystem.FileSystem, path: string) =>
  existsSync(path) ? Effect.map(readText(fs, path), Option.some) : Effect.succeedNone

const format = (path: string, check: boolean) =>
  Effect.gen(function* () {
    const formatter = yield* LoomFormatter
    const fs = yield* FileSystem.FileSystem
    const target = resolvePath(process.cwd(), path)
    const languages = yield* formatLanguages(target)
    const looms = yield* formatter.looms(target)
    const changed = yield* Effect.filter(looms, (loom) =>
      Effect.gen(function* () {
        const text = yield* readText(fs, loom)
        const formatted = yield* formatter.format(loom, text, languages)
        if (formatted === text) return false
        if (!check) yield* writing(loom, (file) => writeFileSync(file, formatted))
        return true
      }),
    )
    yield* changed.length === 0
      ? Console.log('loom: every loom is formatted')
      : Effect.forEach(
          changed,
          (loom) => Console.log(`loom: ${check ? 'would format' : 'formatted'} ${loom}`),
          { discard: true },
        )
    if (check && changed.length > 0) yield* exitNonZero
  })

const formatLanguages = (target: string) =>
  Effect.gen(function* () {
    const config = yield* LoomConfig
    const root = workspaceRoot(dirname(target))
    const manifest = yield* config.manifest(root)
    const ids = Object.keys(manifest?.languages ?? {})
    if (ids.length === 0) return [] as ReadonlyArray<LanguageService>
    yield* Effect.sync(() => {
      ;(globalThis as { require?: unknown }).require ??= createRequire(import.meta.url)
    })
    const { installHostRuntime } = yield* Effect.promise(
      () => import('@athrio/loom-lang-services/Runtime'),
    )
    const { loadActive } = yield* Effect.promise(
      () => import('@athrio/loom-lang-services/LanguageLoader'),
    )
    yield* Effect.sync(() => installHostRuntime())
    return yield* loadActive(ids, root)
  })

interface ManagedBlock {
  readonly begin: string
  readonly end: string
  readonly lines: ReadonlyArray<string>
  readonly owned: RegExp
}

const withManagedBlock = (text: string, managed: ManagedBlock): Option.Option<string> => {
  const block = [managed.begin, ...managed.lines, managed.end].join('\n')
  const start = text.indexOf(managed.begin)
  const end = text.indexOf(managed.end, start)
  if (start >= 0 && end > start)
    return Option.some(text.slice(0, start) + block + text.slice(end + managed.end.length))
  if (managed.owned.test(text)) return Option.none()
  const kept = text.replace(/\s*$/, '')
  return Option.some(kept === '' ? `${block}\n` : `${kept}\n\n${block}\n`)
}

const editorconfigBlock = (width: number): ManagedBlock => ({
  begin: '# Loom: written by `loom init`, which replaces this block on every run',
  end: '# Loom: end',
  lines: ['[*.loom]', `max_line_length = ${width}`],
  owned: /^\s*\[\*\.loom\]\s*$/m,
})

const init = (dir: Option.Option<string>) =>
  Effect.gen(function* () {
    const root = resolvePath(
      process.cwd(),
      Option.getOrElse(dir, () => '.'),
    )
    const config = yield* LoomConfig
    const fs = yield* FileSystem.FileSystem
    yield* banner

    const configFile = resolvePath(root, '.loom', 'config.yaml')
    const configured = yield* Effect.sync(() => existsSync(configFile))

    if (configured) {
      yield* Console.log(`\n   ${dim(`✓ using the configuration at ${configFile}`)}\n`)
    } else {
      const language = yield* Prompt.run(
        Prompt.String({
          message: 'Primary language for specifier-less sections',
          default: 'typescript',
        }),
      )
      const activation = yield* Prompt.run(
        Prompt.String({
          message: 'Activate editor services for (space-separated language ids)',
          default: language,
        }),
      )
      const ids = activation.split(/\s+/).filter((id) => id.length > 0)
      yield* config.materialize(root, {
        corpus: 'corpus',
        languages: Object.fromEntries(ids.map((id) => [id, {}])),
        primary: language,
        ignore: [],
      })
      yield* writing(resolvePath(root, '.loom', '.gitignore'), (file) =>
        writeFileSync(file, 'services/\n'),
      )
      yield* Console.log(
        `\n   ${teal('✓')} wrote ${configFile}\n` +
          `   ${dim(`primary language: ${language}`)}\n` +
          `   ${dim(`activated: ${ids.join(', ') || 'none'}`)}\n`,
      )
    }

    const manifest = yield* config.manifest(root)
    const corpusDir = resolvePath(root, manifest?.corpus ?? 'corpus')
    yield* writing(corpusDir, (dir) => mkdirSync(dir, { recursive: true }))
    yield* Console.log(`   ${teal('✓')} corpus at ${corpusDir}\n`)

    const editorconfig = resolvePath(root, '.editorconfig')
    const current = Option.getOrElse(yield* readIfThere(fs, editorconfig), () => '')
    const block = editorconfigBlock(manifest?.width ?? defaultWidth)
    yield* Option.match(withManagedBlock(current, block), {
      onNone: () => Console.log(`   ${dim(`✓ kept the [*.loom] section in ${editorconfig}`)}\n`),
      onSome: (text) =>
        writing(editorconfig, (file) => writeFileSync(file, text)).pipe(
          Effect.andThen(Console.log(`   ${teal('✓')} wrote ${editorconfig}\n`)),
        ),
    })
  }).pipe(Effect.catchTag('QuitError', () => Console.log(dim('\n   Cancelled.\n'))))

type Entries = 'languages' | 'tropes'

const updateEntries = (
  config: LoomConfig['Service'],
  dir: string,
  key: Entries,
  change: (ids: ReadonlyArray<string>) => ReadonlyArray<string>,
): Effect.Effect<void, SettingsNotWritten> =>
  Effect.gen(function* () {
    const workspace = workspaceRoot(dir)
    const current = (yield* config.manifest(workspace))?.[key] ?? {}
    const ids = change(Object.keys(current))
    yield* config.edit(
      workspace,
      [key],
      Object.fromEntries(ids.map((id) => [id, current[id] ?? {}])),
    )
  })

const activatedIn = (
  config: LoomConfig['Service'],
  dir: string,
  key: Entries,
): Effect.Effect<ReadonlyArray<string>> =>
  config
    .manifest(workspaceRoot(dir))
    .pipe(Effect.map((manifest) => Object.keys(manifest?.[key] ?? {})))

const installNote = (packageName: string, change: PackageInstall): string =>
  PackageInstall.$match(change, {
    Current: () => `${packageName} ${serviceVersion} is already in the store`,
    Installed: () => `installed ${packageName} ${serviceVersion}`,
    Updated: ({ from }) => `updated ${packageName} from ${from} to ${serviceVersion}`,
  })

const alreadyOn = (name: string, state: string, version: Option.Option<string>) =>
  Console.log(
    `\n   ${teal('✓')} ${name} is already ${state}\n` +
      Option.match(version, {
        onNone: () =>
          `   ${dim(`its package is not in the store; \`loom update ${name}\` installs it`)}\n`,
        onSome: (held) =>
          held === serviceVersion
            ? ''
            : `   ${dim(`the store holds its package at ${held}; \`loom update ${name}\` brings it to ${serviceVersion}`)}\n`,
      }),
  )

const addLanguage = (language: string) =>
  Effect.gen(function* () {
    const config = yield* LoomConfig
    const dir = process.cwd()
    const activated = yield* activatedIn(config, dir, 'languages')
    if (activated.includes(language))
      return yield* alreadyOn(language, 'activated', installedVersion(language, dir))
    const change = yield* installService(language, dir)
    yield* updateEntries(config, dir, 'languages', (ids) => [...ids, language])
    yield* Console.log(
      `\n   ${teal('✓')} activated ${language}\n` +
        `   ${dim(installNote(servicePackage(language), change))}\n` +
        `   ${dim(`store: ${storeDir(dir)}`)}\n`,
    )
  })

const addTrope = (trope: string) =>
  Effect.gen(function* () {
    const config = yield* LoomConfig
    const dir = process.cwd()
    const installed = yield* activatedIn(config, dir, 'tropes')
    if (installed.includes(trope))
      return yield* alreadyOn(trope, 'installed', installedTropeVersion(trope, dir))
    const change = yield* installTropes(dir)
    yield* updateEntries(config, dir, 'tropes', (ids) => [...ids, trope])
    yield* Console.log(
      `\n   ${teal('✓')} installed the trope ${trope}\n` +
        `   ${dim(installNote(tropesPackage, change))}\n` +
        `   ${dim(`store: ${storeDir(dir)}`)}\n`,
    )
  })

const removeLanguage = (language: string) =>
  Effect.gen(function* () {
    const config = yield* LoomConfig
    const dir = process.cwd()
    yield* removeService(language, dir)
    yield* updateEntries(config, dir, 'languages', (ids) => ids.filter((id) => id !== language))
    yield* Console.log(`\n   ${teal('✓')} removed ${language}\n`)
  })

const removeTrope = (trope: string) =>
  Effect.gen(function* () {
    const config = yield* LoomConfig
    const dir = process.cwd()
    yield* updateEntries(config, dir, 'tropes', (ids) => ids.filter((id) => id !== trope))
    const left = yield* activatedIn(config, dir, 'tropes')
    if (left.length === 0) yield* removeTropes(dir)
    yield* Console.log(`\n   ${teal('✓')} removed the trope ${trope}\n`)
  })

const add = (name: string) => (isLoomTrope(name) ? addTrope(name) : addLanguage(name))

const remove = (name: string) => (isLoomTrope(name) ? removeTrope(name) : removeLanguage(name))

class NothingToUpdate extends Data.TaggedError('NothingToUpdate')<{}> {}

class NamesWithAll extends Data.TaggedError('NamesWithAll')<{}> {}

class NotActivated extends Data.TaggedError('NotActivated')<{
  readonly names: ReadonlyArray<string>
}> {}

const installOf = (name: string, dir: string) =>
  isLoomTrope(name)
    ? installTropes(dir).pipe(Effect.map((change) => installNote(tropesPackage, change)))
    : installService(name, dir).pipe(
        Effect.map((change) => installNote(servicePackage(name), change)),
      )

const update = (names: ReadonlyArray<string>, all: boolean) =>
  Effect.gen(function* () {
    if (names.length === 0 && !all) return yield* Effect.fail(new NothingToUpdate())
    if (names.length > 0 && all) return yield* Effect.fail(new NamesWithAll())
    const config = yield* LoomConfig
    const dir = process.cwd()
    const on = [
      ...(yield* activatedIn(config, dir, 'languages')),
      ...(yield* activatedIn(config, dir, 'tropes')),
    ]
    const off = names.filter((id) => !on.includes(id))
    if (off.length > 0) return yield* Effect.fail(new NotActivated({ names: off }))
    const ids = all ? on : names
    if (ids.length === 0)
      return yield* Console.log(`\n   ${dim('no languages or tropes are activated')}\n`)
    yield* Console.log('')
    yield* Effect.forEach(ids, (id) =>
      installOf(id, dir).pipe(
        Effect.flatMap((note) => Console.log(`   ${teal('✓')} ${dim(note)}`)),
      ),
    )
    yield* Console.log(`   ${dim(`store: ${storeDir(dir)}`)}\n`)
  })

type ProjectManager = 'npm' | 'bun' | 'pnpm' | 'yarn'

type Installation = Data.TaggedEnum<{
  Executable: {}
  Unowned: {}
  Homebrew: {}
  Npm: {}
  Bun: {}
  Pnpm: {}
  Project: { readonly root: string; readonly manager: ProjectManager }
}>
const Installation = Data.taggedEnum<Installation>()

const lockfiles: ReadonlyArray<readonly [string, ProjectManager]> = [
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
]

const projectManager = (root: string): ProjectManager =>
  pipe(
    Array.findFirst(lockfiles, ([lockfile]) => existsSync(resolvePath(root, lockfile))),
    Option.match({ onNone: (): ProjectManager => 'npm', onSome: ([, manager]) => manager }),
  )

const projectAt = (path: string): Option.Option<string> =>
  pipe(
    Option.fromNullishOr(/^(.*?)[\\/]node_modules[\\/]/.exec(path)),
    Option.flatMap((found) => Option.fromNullishOr(found[1])),
    Option.filter((root) => existsSync(resolvePath(root, 'package.json'))),
  )

const marked = (mark: RegExp) => (path: string) => mark.test(path)

const installationAt = Match.fn((path: string, _otherwise: Installation) => path).pipe(
  Match.withReturnType<Installation>(),
  Match.when(marked(/[\\/]Cellar[\\/]/), () => Installation.Homebrew()),
  Match.when(marked(/[\\/]\.bun[\\/]/), () => Installation.Bun()),
  Match.when(marked(/[\\/]pnpm[\\/]/), () => Installation.Pnpm()),
  Match.when(marked(/[\\/]node_modules[\\/]/), (p) =>
    Option.match(projectAt(p), {
      onNone: () => Installation.Npm(),
      onSome: (root) => Installation.Project({ root, manager: projectManager(root) }),
    }),
  ),
  Match.when(marked(/[\\/]npm[\\/][^\\/]+$/), () => Installation.Npm()),
  Match.orElse((_matched, _path, otherwise) => otherwise),
)

const realOf = (path: string): string =>
  Option.getOrElse(Option.liftThrowable(() => realpathSync(path))(), () => path)

const thisFile = standalone ? process.execPath : fileURLToPath(import.meta.url)

const thisInstallation: Installation = installationAt(
  realOf(thisFile),
  standalone ? Installation.Executable() : Installation.Npm(),
)

const describedInstallation = Installation.$match({
  Executable: () => 'a standalone executable',
  Unowned: () => 'a file no installer owns',
  Homebrew: () => 'installed by Homebrew',
  Npm: () => 'installed by npm',
  Bun: () => 'installed by Bun',
  Pnpm: () => 'installed by pnpm',
  Project: ({ root, manager }) => `installed by ${manager} in the project at ${root}`,
})

const quoted = (path: string): string => `"${path}"`

const loomVersion = '0.0.20'

type Channel = Data.TaggedEnum<{
  Public: {}
  Dev: {}
}>
const Channel = Data.taggedEnum<Channel>()

const channelOf = (dev: boolean): Channel => (dev || devBuild ? Channel.Dev() : Channel.Public())

const projectCommands: Record<ProjectManager, { readonly add: string; readonly remove: string }> = {
  npm: { add: 'npm install', remove: 'npm uninstall' },
  bun: { add: 'bun add', remove: 'bun remove' },
  pnpm: { add: 'pnpm add', remove: 'pnpm remove' },
  yarn: { add: 'yarn add', remove: 'yarn remove' },
}

const loomPackage = Channel.$match({
  Public: () => '@athrio/loom@latest',
  Dev: () => `@athrio/loom@dev --registry ${devRegistry}`,
})

const installerUpgrade = (installation: Installation, channel: Channel): Option.Option<string> =>
  Installation.$match(installation, {
    Executable: () => Option.none(),
    Unowned: () => Option.none(),
    Homebrew: () => Option.some('brew upgrade loom'),
    Npm: () => Option.some(`npm install -g ${loomPackage(channel)}`),
    Bun: () => Option.some(`bun add -g ${loomPackage(channel)}`),
    Pnpm: () => Option.some(`pnpm add -g ${loomPackage(channel)}`),
    Project: ({ root, manager }) =>
      Option.some(`cd ${quoted(root)} && ${projectCommands[manager].add} ${loomPackage(channel)}`),
  })

type Identifier = readonly [kind: number, number: number, text: string]

type Precedence = readonly [
  numbers: ReadonlyArray<number>,
  release: number,
  identifiers: ReadonlyArray<Identifier>,
]

const identifierOf = (identifier: string): Identifier =>
  /^\d+$/.test(identifier) ? [0, Number(identifier), ''] : [1, 0, identifier]

const precedenceOf = (version: string): Precedence => {
  const [numbers = '', ...prerelease] = version.split('-')
  const identifiers = prerelease
    .join('-')
    .split('.')
    .filter((identifier) => identifier !== '')
  return [
    numbers.split('.').map(Number),
    identifiers.length === 0 ? 1 : 0,
    identifiers.map(identifierOf),
  ]
}

const versionOrder: Order.Order<string> = Order.mapInput(
  Order.Tuple([
    Order.Array(Order.Number),
    Order.Number,
    Order.Array(Order.Tuple([Order.Number, Order.Number, Order.String])),
  ]),
  precedenceOf,
)

const isNewer = (version: string): boolean =>
  Order.isGreaterThan(versionOrder)(version, loomVersion)

const releases =
  process.env.LOOM_RELEASES ?? 'https://api.github.com/repos/athrio-com/loom/releases'

const ReleaseSchema = Schema.Struct({
  tag_name: Schema.String,
  assets: Schema.Array(Schema.Struct({ name: Schema.String, browser_download_url: Schema.String })),
})

type Release = typeof ReleaseSchema.Type

class ReleaseUnreachable extends Data.TaggedError('ReleaseUnreachable')<{
  readonly url: string
  readonly cause: unknown
}> {}

const fetched = (url: string): Effect.Effect<Response, ReleaseUnreachable> =>
  Effect.tryPromise({
    try: () => fetch(url, { headers: { 'user-agent': 'loom' } }),
    catch: (cause) => new ReleaseUnreachable({ url, cause }),
  }).pipe(
    Effect.filterOrFail(
      (response) => response.ok,
      (response) =>
        new ReleaseUnreachable({ url, cause: `${response.status} ${response.statusText}` }),
    ),
  )

const decodedAt = <A>(
  url: string,
  decode: (body: unknown) => Effect.Effect<A, Schema.SchemaError>,
): Effect.Effect<A, ReleaseUnreachable> =>
  fetched(url).pipe(
    Effect.flatMap((response) =>
      Effect.tryPromise({
        try: () => response.json(),
        catch: (cause) => new ReleaseUnreachable({ url, cause }),
      }),
    ),
    Effect.flatMap((body) =>
      decode(body).pipe(Effect.mapError((cause) => new ReleaseUnreachable({ url, cause }))),
    ),
  )

const latestRelease: Effect.Effect<Release, ReleaseUnreachable> = decodedAt(
  `${releases}/latest`,
  Schema.decodeUnknownEffect(ReleaseSchema),
)

const bytesAt = (url: string): Effect.Effect<Uint8Array, ReleaseUnreachable> =>
  fetched(url).pipe(
    Effect.flatMap((response) =>
      Effect.tryPromise({
        try: async () => new Uint8Array(await response.arrayBuffer()),
        catch: (cause) => new ReleaseUnreachable({ url, cause }),
      }),
    ),
  )

const executableName =
  process.platform === 'win32'
    ? `loom-windows-${process.arch}.exe`
    : `loom-${process.platform}-${process.arch}`

const assetName = `${executableName}.gz`

class ReleaseLacksAsset extends Data.TaggedError('ReleaseLacksAsset')<{
  readonly version: string
  readonly asset: string
}> {}

class ChecksumMismatch extends Data.TaggedError('ChecksumMismatch')<{
  readonly asset: string
}> {}

const assetUrl = (release: Release, asset: string): Effect.Effect<string, ReleaseLacksAsset> =>
  Option.match(
    Array.findFirst(release.assets, (candidate) => candidate.name === asset),
    {
      onNone: () => Effect.fail(new ReleaseLacksAsset({ version: release.tag_name, asset })),
      onSome: (found) => Effect.succeed(found.browser_download_url),
    },
  )

const listedChecksum = (sums: string, asset: string): Option.Option<string> =>
  pipe(
    sums.split('\n').map((line) => line.trim().split(/\s+/)),
    Array.findFirst((fields) => fields[1] === asset || fields[1] === `*${asset}`),
    Option.flatMap((fields) => Option.fromNullishOr(fields[0])),
  )

const sha256Of = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

const verified = (
  bytes: Uint8Array,
  listed: Option.Option<string>,
  checksumOf: (bytes: Uint8Array) => string,
  asset: string,
): Effect.Effect<Uint8Array, ChecksumMismatch> =>
  Option.contains(listed, checksumOf(bytes))
    ? Effect.succeed(bytes)
    : Effect.fail(new ChecksumMismatch({ asset }))

class UnpackFailed extends Data.TaggedError('UnpackFailed')<{
  readonly asset: string
  readonly cause: unknown
}> {}

const unpacked = (archive: Uint8Array): Effect.Effect<Uint8Array, UnpackFailed> =>
  Effect.try({
    try: () => new Uint8Array(gunzipSync(archive)),
    catch: (cause) => new UnpackFailed({ asset: assetName, cause }),
  })

type Offer = {
  readonly version: string
  readonly executable: Effect.Effect<
    Uint8Array,
    ReleaseUnreachable | ReleaseLacksAsset | ChecksumMismatch | UnpackFailed
  >
}

const publicOffer: Effect.Effect<Offer, ReleaseUnreachable> = latestRelease.pipe(
  Effect.map((release): Offer => ({
    version: release.tag_name.replace(/^v/, ''),
    executable: Effect.gen(function* () {
      const archive = yield* assetUrl(release, assetName).pipe(Effect.flatMap(bytesAt))
      const sums = yield* assetUrl(release, 'SHA256SUMS').pipe(
        Effect.flatMap(bytesAt),
        Effect.map((bytes) => new TextDecoder().decode(bytes)),
      )
      const checked = yield* verified(archive, listedChecksum(sums, assetName), sha256Of, assetName)
      return yield* unpacked(checked)
    }),
  })),
)

const executablePackage = `@athrio/loom-${process.platform}-${process.arch}`

const DevPackageSchema = Schema.Struct({
  'dist-tags': Schema.Struct({ dev: Schema.String }),
  versions: Schema.Record(
    Schema.String,
    Schema.Struct({ dist: Schema.Struct({ tarball: Schema.String, integrity: Schema.String }) }),
  ),
})

type DevRelease = {
  readonly version: string
  readonly tarball: string
  readonly integrity: string
}

const latestDev: Effect.Effect<DevRelease, ReleaseUnreachable | ReleaseLacksAsset> = decodedAt(
  `${devRegistry}/${executablePackage.replace('/', '%2f')}`,
  Schema.decodeUnknownEffect(DevPackageSchema),
).pipe(
  Effect.flatMap((held) => {
    const version = held['dist-tags'].dev
    return Option.match(Option.fromNullishOr(held.versions[version]), {
      onNone: () => Effect.fail(new ReleaseLacksAsset({ version, asset: executablePackage })),
      onSome: ({ dist }) =>
        Effect.succeed<DevRelease>({ version, tarball: dist.tarball, integrity: dist.integrity }),
    })
  }),
)

const integrityOf = (bytes: Uint8Array): string =>
  `sha512-${createHash('sha512').update(bytes).digest('base64')}`

const unpackedFromPackage = (tarball: Uint8Array): Effect.Effect<Uint8Array, UnpackFailed> =>
  Effect.tryPromise({
    try: () => new Bun.Archive(tarball).files(),
    catch: (cause) => new UnpackFailed({ asset: executablePackage, cause }),
  }).pipe(
    Effect.flatMap((files) =>
      Option.match(Option.fromNullishOr(files.get('package/loom')), {
        onNone: () =>
          Effect.fail(
            new UnpackFailed({
              asset: executablePackage,
              cause: 'the package holds no package/loom',
            }),
          ),
        onSome: (file) =>
          Effect.tryPromise({
            try: () => file.bytes(),
            catch: (cause) => new UnpackFailed({ asset: executablePackage, cause }),
          }),
      }),
    ),
  )

const devOffer: Effect.Effect<Offer, ReleaseUnreachable | ReleaseLacksAsset> = latestDev.pipe(
  Effect.map((release): Offer => ({
    version: release.version,
    executable: bytesAt(release.tarball).pipe(
      Effect.flatMap((tarball) =>
        verified(tarball, Option.some(release.integrity), integrityOf, executablePackage),
      ),
      Effect.flatMap(unpackedFromPackage),
    ),
  })),
)

const offerOf: (channel: Channel) => Effect.Effect<Offer, ReleaseUnreachable | ReleaseLacksAsset> =
  Channel.$match({ Public: () => publicOffer, Dev: () => devOffer })

class ReplaceFailed extends Data.TaggedError('ReplaceFailed')<{
  readonly path: string
  readonly cause: unknown
}> {}

const moveAside = (target: string): void => {
  if (process.platform !== 'win32') return
  rmSync(`${target}.old`, { force: true })
  renameSync(target, `${target}.old`)
}

const replaceExecutable = (bytes: Uint8Array): Effect.Effect<void, ReplaceFailed> => {
  const target = process.execPath
  const partial = `${target}.${process.pid}`
  return Effect.try({
    try: () => {
      writeFileSync(partial, bytes, { mode: 0o755 })
      moveAside(target)
      renameSync(partial, target)
    },
    catch: (cause) => new ReplaceFailed({ path: target, cause }),
  }).pipe(Effect.tapError(() => Effect.sync(() => rmSync(partial, { force: true }))))
}

const releaseKind = Channel.$match({ Public: () => 'release', Dev: () => 'dev release' })

const upgradeStandalone = (channel: Channel) =>
  Effect.gen(function* () {
    const offer = yield* offerOf(channel)
    if (!isNewer(offer.version))
      return yield* Console.log(
        `\n   ${teal('✓')} Loom ${loomVersion} is up to date; the latest ${releaseKind(channel)} is ${offer.version}\n`,
      )
    yield* offer.executable.pipe(Effect.flatMap(replaceExecutable))
    yield* Console.log(
      `\n   ${teal('✓')} upgraded Loom from ${loomVersion} to ${offer.version}\n` +
        `   ${dim('run `loom update --all` in each workspace to bring its services along')}\n`,
    )
  })

const upgrade = (dev: boolean) =>
  Effect.gen(function* () {
    const channel = channelOf(dev)
    const command = installerUpgrade(thisInstallation, channel)
    if (Option.isNone(command)) return yield* upgradeStandalone(channel)
    yield* Console.log(
      `\n   Loom was ${describedInstallation(thisInstallation)}. Upgrade it with:\n\n` +
        `   ${command.value}\n\n` +
        `   ${dim('then run `loom update --all` in each workspace to bring its services along')}\n`,
    )
  })

const noticeWait = '300 millis'

const newerDevRelease: Effect.Effect<Option.Option<string>> = latestDev.pipe(
  Effect.map(({ version }) => Option.filter(Option.some(version), isNewer)),
  Effect.orElseSucceed(() => Option.none<string>()),
  Effect.timeoutOption(noticeWait),
  Effect.map(Option.flatten),
)

const noticed = devBuild && !['upgrade', 'doctor'].includes(process.argv[2] ?? '')

const devCheck: Effect.Effect<Option.Option<string>> = noticed
  ? newerDevRelease
  : Effect.succeedNone

const devNotice = (newer: Option.Option<string>): Effect.Effect<void> =>
  Option.match(newer, {
    onNone: () => Effect.void,
    onSome: (version) =>
      Console.error(
        `\n   ${amber('↑')} dev release ${version} is out, newer than this loom's ${loomVersion}; run \`loom upgrade\`\n`,
      ),
  })

const status = Effect.gen(function* () {
  const config = yield* LoomConfig
  const dir = process.cwd()
  const manifest = yield* config.manifest(workspaceRoot(dir))
  const primary = manifest?.primary
  const languages = Object.keys(manifest?.languages ?? {})
  const mark = (id: string): string =>
    Option.match(installedVersion(id, dir), {
      onNone: () => `   ${dim('○')} ${id}${dim(`  — run \`loom update ${id}\``)}`,
      onSome: (version) =>
        version === serviceVersion
          ? `   ${teal('●')} ${id}`
          : `   ${dim('◐')} ${id}${dim(`  — ${version} is installed; run \`loom update ${id}\` for ${serviceVersion}`)}`,
    })
  yield* Console.log(
    `\n   ${dim('store')}      ${storeDir(dir)}\n` +
      `   ${dim('primary')}    ${primary ?? dim('(none)')}\n` +
      `   ${dim('activated')}  ${languages.length === 0 ? dim('(none)') : languages.join(', ')}\n`,
  )
  if (languages.length > 0) yield* Console.log(`${languages.map(mark).join('\n')}\n`)
})

type Finding = Data.TaggedEnum<{
  Fine: { readonly note: string }
  Problem: { readonly note: string; readonly fix: string }
}>
const Finding = Data.taggedEnum<Finding>()

const commandNames = (command: string): ReadonlyArray<string> =>
  process.platform === 'win32' ? [`${command}.exe`, `${command}.cmd`] : [command]

const isProgram = (file: string): boolean =>
  pipe(
    Option.liftThrowable(() => statSync(file))(),
    Option.exists(
      (stats) => stats.isFile() && (process.platform === 'win32' || (stats.mode & 0o111) !== 0),
    ),
  )

const programsOnPath = (command: string): ReadonlyArray<string> =>
  Array.dedupeWith(
    (process.env.PATH ?? '')
      .split(delimiter)
      .filter((folder) => folder !== '')
      .flatMap((folder) => commandNames(command).map((name) => resolvePath(folder, name)))
      .filter(isProgram),
    (one, other) => realOf(one) === realOf(other),
  )

const loomsOnPath = (): ReadonlyArray<string> => programsOnPath('loom')

const installationOf = (file: string): Installation =>
  installationAt(realOf(file), Installation.Unowned())

const isThisLoom = (file: string): boolean =>
  realOf(file) === realOf(thisFile) || Equal.equals(installationOf(file), thisInstallation)

const installLine =
  'curl -fsSL https://github.com/athrio-com/loom/releases/latest/download/install.sh | sh'

const installerRemoval = (installation: Installation, file: string): string =>
  Installation.$match(installation, {
    Executable: () => `rm ${quoted(file)}`,
    Unowned: () => `rm ${quoted(file)}`,
    Homebrew: () => 'brew uninstall loom',
    Npm: () => 'npm uninstall -g @athrio/loom',
    Bun: () => 'bun remove -g @athrio/loom',
    Pnpm: () => 'pnpm remove -g @athrio/loom',
    Project: ({ root, manager }) =>
      `cd ${quoted(root)} && ${projectCommands[manager].remove} @athrio/loom`,
  })

const otherLoom = (file: string, note: string): Finding =>
  Finding.Problem({
    note: `${note}, ${describedInstallation(installationOf(file))}`,
    fix: installerRemoval(installationOf(file), file),
  })

const thisLoomFinding = Finding.Fine({
  note: `loom v${loomVersion} runs from ${thisFile}, ${describedInstallation(thisInstallation)}`,
})

const pathFindings = (looms: ReadonlyArray<string>): ReadonlyArray<Finding> =>
  Array.match(looms, {
    onEmpty: () => [
      Finding.Problem({
        note: 'no loom is on PATH, so a terminal finds none to run',
        fix: installLine,
      }),
    ],
    onNonEmpty: ([first, ...rest]) => [
      isThisLoom(first)
        ? Finding.Fine({ note: `a terminal runs this loom, at ${first}` })
        : otherLoom(first, `a terminal runs ${first} instead`),
      ...rest
        .filter((file) => !isThisLoom(file))
        .map((file) => otherLoom(file, `${file} is on PATH too`)),
    ],
  })

const devReleaseFinding: Effect.Effect<Finding> = latestDev.pipe(
  Effect.map(({ version }) =>
    isNewer(version)
      ? Finding.Problem({
          note: `dev release ${version} is out, newer than this loom's ${loomVersion}`,
          fix: 'loom upgrade',
        })
      : Finding.Fine({
          note: `the registry at ${devRegistry} holds no dev release newer than this loom`,
        }),
  ),
  Effect.catchTags({
    ReleaseUnreachable: () =>
      Effect.succeed(
        Finding.Problem({
          note: `no dev registry answers at ${devRegistry}, so whether a newer dev release is out cannot be told; start the registry from Loom's repository`,
          fix: 'bun run registry',
        }),
      ),
    ReleaseLacksAsset: ({ version }) =>
      Effect.succeed(
        Finding.Problem({
          note: `the registry at ${devRegistry} tags dev release ${version} but holds no executable for it; release again from Loom's repository`,
          fix: 'bun run release-local',
        }),
      ),
  }),
)

const devFindings: Effect.Effect<ReadonlyArray<Finding>> = devBuild
  ? devReleaseFinding.pipe(Effect.map((finding) => [finding]))
  : Effect.succeed([])

const serviceFinding = (id: string, root: string): Finding =>
  Option.match(installedVersion(id, root), {
    onNone: () =>
      Finding.Problem({ note: `the store holds no service for ${id}`, fix: `loom update ${id}` }),
    onSome: (version) =>
      version === serviceVersion
        ? Finding.Fine({ note: `the store holds ${id}'s service at this Loom's ${serviceVersion}` })
        : Finding.Problem({
            note: `the store holds ${id}'s service at ${version}, and this Loom needs ${serviceVersion}`,
            fix: `loom update ${id}`,
          }),
  })

const serviceFindings = (languages: ReadonlyArray<string>, root: string): ReadonlyArray<Finding> =>
  Array.match(languages, {
    onEmpty: () => [
      Finding.Fine({ note: 'no language is activated, so the store needs no service' }),
    ],
    onNonEmpty: (ids) => ids.map((id) => serviceFinding(id, root)),
  })

const fetchFinding = Match.fn(
  (
    _within: {
      readonly fetchInto: string
    },
    has: { readonly standalone: boolean; readonly npm: boolean },
  ) => has,
).pipe(
  Match.withReturnType<Finding>(),
  Match.when({ standalone: true }, (_has, { fetchInto }) =>
    Finding.Fine({
      note: `the language server fetches ${fetchInto} the first time a project with no TypeScript asks`,
    }),
  ),
  Match.when({ npm: true }, (_has, { fetchInto }) =>
    Finding.Fine({
      note: `the language server fetches ${fetchInto} with npm the first time a project with no TypeScript asks`,
    }),
  ),
  Match.orElse((_has, { fetchInto }) =>
    Finding.Problem({
      note: `the language server has no npm to fetch ${fetchInto} with, for a project with no TypeScript`,
      fix: installLine,
    }),
  ),
)

const unfetchedTypeScript = (): Finding => {
  const fetchInto = `TypeScript ${typeScriptVersion} into ${fetchedTypeScriptDir(typeScriptVersion)}`
  return fetchFinding({ fetchInto }, { standalone, npm: programsOnPath('npm').length > 0 })
}

const typeScriptFinding = (): Finding =>
  existsSync(fetchedExecutable(typeScriptVersion))
    ? Finding.Fine({
        note: `TypeScript ${typeScriptVersion} is fetched into ${fetchedTypeScriptDir(typeScriptVersion)}`,
      })
    : unfetchedTypeScript()

const workspaceFindings = (
  root: string,
): Effect.Effect<ReadonlyArray<Finding>, never, LoomConfig> =>
  Effect.gen(function* () {
    const config = yield* LoomConfig
    const manifest = yield* config.manifest(root)
    const languages = Object.keys(manifest?.languages ?? {})
    return [
      ...serviceFindings(languages, root),
      ...(Array.contains(languages, 'typescript') ? [typeScriptFinding()] : []),
    ]
  })

const amber = (s: string): string => `\x1b[38;5;214m${s}${reset}`

const findingLines = (findings: ReadonlyArray<Finding>): string =>
  findings
    .map(
      Finding.$match({
        Fine: ({ note }) => `   ${teal('✓')} ${note}`,
        Problem: ({ note, fix }) => `   ${amber('✗')} ${note}\n       ${fix}`,
      }),
    )
    .join('\n')

const doctor = Effect.gen(function* () {
  const dir = process.cwd()
  const dev = yield* devFindings
  const machine = [thisLoomFinding, ...dev, ...pathFindings(loomsOnPath())]
  const workspace = workspaceOf(dir)
  const inWorkspace = yield* Option.match(workspace, {
    onNone: () => Effect.succeed([] as ReadonlyArray<Finding>),
    onSome: workspaceFindings,
  })
  const problems = [...machine, ...inWorkspace].filter(Finding.$is('Problem')).length
  yield* Console.log(
    `\n   ${dim('this machine')}\n${findingLines(machine)}\n\n` +
      Option.match(workspace, {
        onNone: () => `   ${dim(`no workspace holds ${dir}, so no services to check`)}\n`,
        onSome: (root) => `   ${dim(`the workspace at ${root}`)}\n${findingLines(inWorkspace)}\n`,
      }),
  )
  if (problems === 0) return yield* Console.log(`   ${teal('✓')} no problems found\n`)
  yield* Console.log(`   ${problems === 1 ? '1 problem' : `${problems} problems`} found\n`)
  yield* exitNonZero
})

class ValueOpensOnEquals extends Data.TaggedError('ValueOpensOnEquals')<{}> {}

const set = (name: string, value: string) =>
  Effect.gen(function* () {
    const config = yield* LoomConfig
    const tangler = yield* LoomTangler
    const workspace = workspaceRoot(process.cwd())
    if (!isVariableName(name)) return yield* Effect.fail(new NotAVariableName({ name }))
    if (value.startsWith('=')) return yield* Effect.fail(new ValueOpensOnEquals())
    const current = yield* config.manifest(workspace)
    yield* config.edit(workspace, ['variables', name], value)
    const corpus = resolvePath(workspace, current?.corpus ?? 'corpus')
    const written = yield* tangler.tangle(corpus)
    yield* Console.log(`loom: set ${name} = ${value} (re-tangled ${written.length} files)`)
  })

const embeddedGrammar: Effect.Effect<Option.Option<Readonly<Record<string, string>>>> =
  Effect.tryPromise(() => import('virtual:tree-sitter-loom')).pipe(
    Effect.map((module) => Option.some(module.default)),
    Effect.orElseSucceed(() => Option.none()),
  )

const unpackedGrammar = (
  files: Readonly<Record<string, string>>,
): Effect.Effect<string, NotWritten, Scope.Scope> =>
  Effect.acquireRelease(
    writing(tmpdir(), (temporary) => mkdtempSync(resolvePath(temporary, 'loom-grammar-'))),
    (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
  ).pipe(
    Effect.tap((dir) =>
      Effect.forEach(
        Object.entries(files),
        ([path, text]) =>
          writing(resolvePath(dir, path), (file) => {
            mkdirSync(dirname(file), { recursive: true })
            writeFileSync(file, text)
          }),
        { discard: true },
      ),
    ),
  )

class GrammarMissing extends Data.TaggedError('GrammarMissing')<{}> {}

const grammarIn = (dir: string): Option.Option<string> =>
  existsSync(resolvePath(dir, 'src', 'parser.c')) ? Option.some(dir) : Option.none()

const workspaceGrammar = (): Option.Option<string> =>
  Option.flatMap(
    Option.liftThrowable(() =>
      createRequire(import.meta.url).resolve('tree-sitter-loom/package.json'),
    )(),
    (manifest) => grammarIn(dirname(manifest)),
  )

const shippedGrammar: Effect.Effect<string, GrammarMissing | NotWritten, Scope.Scope> =
  embeddedGrammar.pipe(
    Effect.flatMap(
      Option.match({
        onSome: (files): Effect.Effect<string, GrammarMissing | NotWritten, Scope.Scope> =>
          unpackedGrammar(files),
        onNone: () =>
          Option.match(workspaceGrammar(), {
            onNone: () => Effect.fail(new GrammarMissing()),
            onSome: (dir) => Effect.succeed(dir),
          }),
      }),
    ),
  )

class GrammarCompileFailed extends Data.TaggedError('GrammarCompileFailed')<{
  readonly compiler: string
}> {}

const compileGrammar = (grammar: string, library: string) =>
  Effect.gen(function* () {
    const compiler = process.env.CC ?? 'cc'
    const partial = `${library}.${process.pid}`
    const source = resolvePath(grammar, 'src')
    const code = yield* Effect.scoped(
      Effect.flatMap(
        ChildProcess.make(
          compiler,
          [
            '-shared',
            '-fPIC',
            '-O2',
            '-I',
            source,
            resolvePath(source, 'parser.c'),
            resolvePath(source, 'scanner.c'),
            '-o',
            partial,
          ],
          { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' },
        ),
        (running) => running.exitCode,
      ),
    ).pipe(Effect.catchCause(() => Effect.succeed(-1)))
    if (code !== 0) return yield* Effect.fail(new GrammarCompileFailed({ compiler }))
    yield* writing(library, (file) => renameSync(partial, file))
  })

const grammarLibrary = process.platform === 'win32' ? 'loom.dll' : 'loom.so'

const writeLibrary = (prebuilt: Blob, library: string): Effect.Effect<void, NotWritten> =>
  Effect.promise(() => prebuilt.arrayBuffer()).pipe(
    Effect.flatMap((bytes) =>
      writing(library, (file) => {
        const partial = `${file}.${process.pid}`
        writeFileSync(partial, new Uint8Array(bytes), { mode: 0o755 })
        renameSync(partial, file)
      }),
    ),
  )

const buildGrammar = (grammar: string, library: string) =>
  Option.match(embeddedFile(grammarLibrary), {
    onSome: (prebuilt) => writeLibrary(prebuilt, library),
    onNone: () => compileGrammar(grammar, library),
  })

const helixConfigDir = (): string =>
  process.platform === 'win32'
    ? resolvePath(process.env.APPDATA ?? homedir(), 'helix')
    : resolvePath(process.env.XDG_CONFIG_HOME ?? resolvePath(homedir(), '.config'), 'helix')

const helixBlock: ManagedBlock = {
  begin: '# Loom: written by `loom helix`, which replaces this block on every run',
  end: '# Loom: end',
  lines: [
    '[[language]]',
    'name = "loom"',
    'scope = "source.loom"',
    'file-types = ["loom"]',
    'roots = [".loom/config.yaml"]',
    'injection-regex = "^loom$"',
    'language-servers = ["loom"]',
    'soft-wrap = { enable = true, wrap-at-text-width = true }',
    `text-width = ${defaultWidth}`,
    '',
    '[language-server.loom]',
    'command = "loom"',
    'args = ["lsp", "--stdio"]',
  ],
  owned: /^\s*name\s*=\s*"loom"/m,
}

class HelixConfigClash extends Data.TaggedError('HelixConfigClash')<{
  readonly file: string
}> {}

const withLoomLanguages = (file: string, text: string): Effect.Effect<string, HelixConfigClash> =>
  Option.match(withManagedBlock(text, helixBlock), {
    onNone: () => Effect.fail(new HelixConfigClash({ file })),
    onSome: Effect.succeed,
  })

const helix = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const config = helixConfigDir()
  const languagesFile = resolvePath(config, 'languages.toml')
  const grammar = yield* shippedGrammar
  const current = Option.getOrElse(yield* readIfThere(fs, languagesFile), () => '')
  const languages = yield* withLoomLanguages(languagesFile, current)

  const library = resolvePath(config, 'runtime', 'grammars', grammarLibrary)
  yield* writing(dirname(library), (dir) => mkdirSync(dir, { recursive: true }))
  yield* buildGrammar(grammar, library)
  yield* Console.log(`\n   ${teal('✓')} built the grammar into ${library}`)

  const queries = resolvePath(config, 'runtime', 'queries', 'loom')
  yield* writing(queries, (dir) =>
    cpSync(resolvePath(grammar, 'editors', 'helix', 'queries', 'loom'), dir, { recursive: true }),
  )
  yield* Console.log(`   ${teal('✓')} copied the queries into ${queries}`)

  yield* writing(languagesFile, (file) => writeFileSync(file, languages))
  yield* Console.log(
    `   ${teal('✓')} added Loom to ${languagesFile}\n` +
      `   ${dim('check it with `hx --health loom`')}\n`,
  )
}).pipe(Effect.scoped)

const nvimSiteDir = (): string => {
  const name = process.env.NVIM_APPNAME ?? 'nvim'
  return process.platform === 'win32'
    ? resolvePath(process.env.LOCALAPPDATA ?? homedir(), `${name}-data`, 'site')
    : resolvePath(
        process.env.XDG_DATA_HOME ?? resolvePath(homedir(), '.local', 'share'),
        name,
        'site',
      )
}

const nvimHeader = '-- Loom: written by `loom nvim`, which replaces this file on every run'

const nvimPlugin = [
  nvimHeader,
  "vim.filetype.add({ extension = { loom = 'loom' } })",
  '',
  "vim.lsp.config('loom', {",
  "  cmd = { 'loom', 'lsp', '--stdio' },",
  "  filetypes = { 'loom' },",
  '  root_dir = function(bufnr, on_dir)',
  '    local workspace = function(name, path)',
  "      local config = vim.fs.joinpath(path, name, 'config.yaml')",
  "      return name == '.loom' and vim.uv.fs_stat(config) ~= nil",
  '    end',
  "    on_dir(vim.fs.root(bufnr, workspace) or vim.fs.root(bufnr, '.git'))",
  '  end,',
  '})',
  "vim.lsp.enable('loom')",
  '',
  "vim.api.nvim_create_autocmd('FileType', {",
  "  pattern = 'loom',",
  '  callback = function()',
  '    vim.treesitter.start()',
  "    vim.opt_local.formatoptions:remove({ 't', 'c' })",
  '  end,',
  '})',
  '',
].join('\n')

class NvimConfigClash extends Data.TaggedError('NvimConfigClash')<{
  readonly file: string
}> {}

const nvim = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const site = nvimSiteDir()
  const pluginFile = resolvePath(site, 'plugin', 'loom.lua')
  const grammar = yield* shippedGrammar
  const current = yield* readIfThere(fs, pluginFile)
  if (Option.exists(current, (text) => !text.startsWith(nvimHeader)))
    return yield* Effect.fail(new NvimConfigClash({ file: pluginFile }))

  const parser = resolvePath(site, 'parser', 'loom.so')
  yield* writing(dirname(parser), (dir) => mkdirSync(dir, { recursive: true }))
  yield* buildGrammar(grammar, parser)
  yield* Console.log(`\n   ${teal('✓')} built the grammar into ${parser}`)

  const queries = resolvePath(site, 'queries', 'loom')
  yield* writing(queries, (dir) =>
    cpSync(resolvePath(grammar, 'queries'), dir, { recursive: true }),
  )
  yield* Console.log(`   ${teal('✓')} copied the queries into ${queries}`)

  yield* writing(pluginFile, (file) => {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, nvimPlugin)
  })
  yield* Console.log(
    `   ${teal('✓')} added Loom to ${pluginFile}\n` +
      `   ${dim('check it with `:checkhealth vim.treesitter` in Neovim')}\n`,
  )
}).pipe(Effect.scoped)

type CommandFailure =
  | LoomFailure
  | NothingToUpdate
  | NamesWithAll
  | NotActivated
  | ReleaseUnreachable
  | ReleaseLacksAsset
  | ChecksumMismatch
  | UnpackFailed
  | ReplaceFailed
  | ValueOpensOnEquals
  | GrammarMissing
  | GrammarCompileFailed
  | HelixConfigClash
  | NvimConfigClash

const startTheRegistry =
  "The dev registry answers while `bun run registry` runs in Loom's repository."

const inWords = new Intl.ListFormat('en', { type: 'conjunction' })

const commandWording: Wording<CommandFailure> = {
  ...failureWording,
  NothingToUpdate: () =>
    problem(
      '`loom update` names no language or trope to update.',
      'Name them, as in `loom update <language or trope>…`, or use `loom update --all`. To upgrade Loom itself, run `loom upgrade`.',
    ),
  NamesWithAll: () =>
    problem(
      '`loom update` takes names or `--all`, not both.',
      'Name them, as in `loom update <language or trope>…`, or use `loom update --all` alone.',
    ),
  NotActivated: ({ names }) => {
    const one = names.length === 1
    return problem(
      `${inWords.format(names)} ${one ? 'is' : 'are'} not activated.`,
      `${inWords.format(names.map((name) => `\`loom add ${name}\``))} ${one ? 'turns it on' : 'turn them on'}.`,
    )
  },
  ReleaseUnreachable: ({ url, cause }) =>
    problem(
      `Loom could not reach ${url}.`,
      url.startsWith(devRegistry) ? `${reasonOf(cause)} ${startTheRegistry}` : reasonOf(cause),
    ),
  ReleaseLacksAsset: ({ version, asset }) => problem(`Release ${version} carries no ${asset}.`),
  ChecksumMismatch: ({ asset }) =>
    problem(
      `The downloaded ${asset} does not match the checksum its release lists.`,
      'Loom was left as it was.',
    ),
  UnpackFailed: ({ asset, cause }) => problem(`Loom could not unpack ${asset}.`, reasonOf(cause)),
  ReplaceFailed: ({ path, cause }) =>
    problem(
      `Loom could not replace ${path}.`,
      `${reasonOf(cause)} Run the install script again, or move Loom somewhere you can write to.`,
    ),
  ValueOpensOnEquals: () =>
    problem(
      'A value cannot begin with `=`.',
      'Give the name and the value with a space between them, as in `loom set version 0.0.4`.',
    ),
  GrammarMissing: () => problem('This installation of Loom carries no grammar.'),
  GrammarCompileFailed: ({ compiler }) =>
    problem(
      `Loom could not compile the grammar with \`${compiler}\`.`,
      'Install a C compiler, or name one in the CC variable, then run this again.',
    ),
  HelixConfigClash: ({ file }) =>
    problem(
      `${file} already sets up Loom.`,
      'Remove its Loom entries, then run this again to replace them with the managed block.',
    ),
  NvimConfigClash: ({ file }) =>
    problem(`${file} was not written by \`loom nvim\`.`, 'Move it aside, then run this again.'),
}

const describe: (failure: CommandFailure) => Problem = Match.type<CommandFailure>().pipe(
  Match.tagsExhaustive(commandWording),
)

const listedUnder: (failure: CommandFailure) => ReadonlyArray<string> =
  Match.type<CommandFailure>().pipe(
    Match.withReturnType<ReadonlyArray<string>>(),
    Match.tag('TangleError', (refused) => refusedBy(refused).map((line) => `  ${line}`)),
    Match.orElse(() => []),
  )

const shown = (failure: CommandFailure): string => {
  const { summary, detail } = describe(failure)
  return [
    `loom: ${summary}`,
    ...(detail === '' ? [] : [`      ${detail}`]),
    ...listedUnder(failure),
  ].join('\n')
}

const tell = (failure: CommandFailure): Effect.Effect<void> => Console.error(shown(failure))

const exitNonZero = Effect.sync(() => void (process.exitCode = 1))

const ended = <A, R>(command: Effect.Effect<A, CommandFailure, R>): Effect.Effect<void, never, R> =>
  command.pipe(
    Effect.asVoid,
    Effect.catch((failure) => tell(failure).pipe(Effect.andThen(exitNonZero))),
  )

const loggedFailure = failureIn(commandWording)

const commandLogger = Logger.make((logged: Logger.Options<unknown>) =>
  Option.match(loggedFailure(logged.message), {
    onNone: () => Logger.defaultLogger.log(logged),
    onSome: (failure) => console.error(shown(failure)),
  }),
)

const crashed = <E>(cause: Cause.Cause<E>): Effect.Effect<void> =>
  tell(broke('command', '', cause)).pipe(
    Effect.andThen(Console.error(dim(Cause.pretty(cause)))),
    Effect.andThen(exitNonZero),
  )

const tangleCommand = Command.make(
  'tangle',
  { path: Argument.String('path'), watch: Flag.Boolean('watch').pipe(Flag.withDefault(false)) },
  ({ path, watch }) => ended(tangle(path, watch)),
)

const orphansCommand = Command.make(
  'orphans',
  { prune: Flag.Boolean('prune').pipe(Flag.withDefault(false)) },
  ({ prune }) => ended(orphans(prune)),
)

const weaveCommand = Command.make(
  'weave',
  { path: Argument.String('path'), out: Argument.String('out') },
  ({ path, out }) => ended(weave(path, out)),
)

const formatCommand = Command.make(
  'format',
  { path: Argument.String('path'), check: Flag.Boolean('check').pipe(Flag.withDefault(false)) },
  ({ path, check }) => ended(format(path, check)),
)

const refreshCommand = Command.make('refresh', { path: Argument.String('path') }, ({ path }) =>
  ended(refresh(path)),
)

const approveCommand = Command.make('approve', { path: Argument.String('path') }, ({ path }) =>
  ended(approve(path)),
)

const reviewCommand = Command.make(
  'review',
  {
    path: Argument.optional(Argument.String('path')),
    json: Flag.Boolean('json').pipe(Flag.withDefault(false)),
    check: Flag.Boolean('check').pipe(Flag.withDefault(false)),
  },
  ({ path, json, check }) => ended(review(path, json, check)),
)

const initCommand = Command.make(
  'init',
  { dir: Argument.optional(Argument.Directory('dir')) },
  ({ dir }) => ended(init(dir)),
)

const addCommand = Command.make('add', { name: Argument.String('name') }, ({ name }) =>
  ended(add(name)),
)

const removeCommand = Command.make('remove', { name: Argument.String('name') }, ({ name }) =>
  ended(remove(name)),
)

const updateCommand = Command.make(
  'update',
  {
    names: Argument.String('name').pipe(Argument.variadic()),
    all: Flag.Boolean('all').pipe(Flag.withDefault(false)),
  },
  ({ names, all }) => ended(update(names, all)),
)

const upgradeCommand = Command.make(
  'upgrade',
  { dev: Flag.Boolean('dev').pipe(Flag.withDefault(false)) },
  ({ dev }) => ended(upgrade(dev)),
)

const statusCommand = Command.make('status', {}, () => ended(status))

const doctorCommand = Command.make('doctor', {}, () => ended(doctor))

const setCommand = Command.make(
  'set',
  { name: Argument.String('name'), value: Argument.String('value') },
  ({ name, value }) => ended(set(name, value)),
)

const helixCommand = Command.make('helix', {}, () => ended(helix))

const nvimCommand = Command.make('nvim', {}, () => ended(nvim))

const loom = Command.make('loom').pipe(
  Command.withSubcommands([
    tangleCommand,
    orphansCommand,
    weaveCommand,
    refreshCommand,
    approveCommand,
    reviewCommand,
    formatCommand,
    initCommand,
    addCommand,
    removeCommand,
    updateCommand,
    upgradeCommand,
    statusCommand,
    doctorCommand,
    setCommand,
    helixCommand,
    nvimCommand,
  ]),
)

const program: Effect.Effect<void, CliError.CliError> = Effect.zip(
  Command.run(loom, { version: loomVersion }),
  devCheck,
  { concurrent: true },
).pipe(
  Effect.flatMap(([, newer]) => devNotice(newer)),
  Effect.provide(LoomTangler.layer),
  Effect.provide(LoomWeaver.layer),
  Effect.provide(LoomSummaries.layer),
  Effect.provide(LoomCompiler.layer),
  Effect.provide(LoomFormatter.layer),
  Effect.provide(DocumentSource.layer),
  Effect.provide(LanguagePackages.layer),
  Effect.provide(TropePackages.layer),
  Effect.provide(FileSystemEnvironment),
  Effect.provide(LoomConfig.layer),
  Effect.provide(NodeServices.layer),
  Effect.provide(Logger.layer([commandLogger])),
  Effect.catchCauseIf(Cause.hasDies, crashed),
)

if (process.argv[2] === 'lsp') {
  ;(globalThis as { require?: unknown }).require = createRequire(import.meta.url)
  const { startLanguageServer } = await import('@athrio/loom-lang/LoomServer')
  startLanguageServer()
} else {
  NodeRuntime.runMain(program)
}
