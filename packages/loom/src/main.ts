import {
  Array,
  Cause,
  Console,
  Data,
  Effect,
  Equal,
  Match,
  Option,
  Order,
  Result,
  Schema,
  type Scope,
  Stream,
  pipe,
} from 'effect'
import { Argument, Command, Flag, Prompt } from 'effect/cli'
import { ChildProcess } from 'effect/process'
import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { delimiter, dirname, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { DocumentSource, type TangledFile, type TangleError } from '@athrio/loom-lang/LoomCompiler'
import { LoomTangler } from '@athrio/loom-lang/LoomTangler'
import { LoomWeaver } from '@athrio/loom-lang/weave/LoomWeaver'
import { LoomContents } from '@athrio/loom-lang/weave/LoomContents'
import { LoomFormatter } from '@athrio/loom-lang/LoomFormatter'
import { PackageConfig } from '@athrio/loom-lang/PackageConfig'
import { defaultWidth, LoomConfig } from '@athrio/loom-config/LoomConfig'
import {
  installedVersion,
  installService,
  embeddedFile,
  fetchedExecutable,
  fetchedTypeScriptDir,
  removeService,
  ServiceInstall,
  type StoreError,
  servicePackage,
  serviceVersion,
  standalone,
  storeDir,
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
  }).pipe(
    Effect.catchTag('TangleError', (e) =>
      Console.error(e.message).pipe(Effect.andThen(Effect.sync(() => void (process.exitCode = 1)))),
    ),
  )

const tangleWatch = (file: string) =>
  Effect.gen(function* () {
    const tangler = yield* LoomTangler
    yield* Console.log(`loom: watching ${file} — re-tangling on change`)
    yield* Stream.runForEach(
      tangler.watch(resolvePath(process.cwd(), file)),
      Result.match({
        onSuccess: reportWritten,
        onFailure: (error: TangleError) => Console.error(error.message),
      }),
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
  }).pipe(
    Effect.catchTag('TangleError', (e) =>
      Console.error(e.message).pipe(Effect.andThen(Effect.sync(() => void (process.exitCode = 1)))),
    ),
  )

const weave = (file: string, out: string) =>
  Effect.gen(function* () {
    const weaver = yield* LoomWeaver
    const written = yield* weaver.weave(
      resolvePath(process.cwd(), file),
      resolvePath(process.cwd(), out),
    )
    yield* Console.log(`loom: wove ${file} → ${written}`)
  })

const toc = (file: string) =>
  Effect.gen(function* () {
    const contents = yield* LoomContents
    const written = yield* contents.write(resolvePath(process.cwd(), file))
    yield* Console.log(`loom: wrote the table of contents into ${written}`)
  })

const format = (path: string, check: boolean) =>
  Effect.gen(function* () {
    const formatter = yield* LoomFormatter
    const target = resolvePath(process.cwd(), path)
    const languages = yield* formatLanguages(target)
    const looms = yield* formatter.looms(target)
    const changed = yield* Effect.filter(looms, (loom) =>
      Effect.gen(function* () {
        const text = yield* Effect.sync(() => readFileSync(loom, 'utf8'))
        const formatted = yield* formatter.format(loom, text, languages)
        if (formatted === text) return false
        if (!check) yield* Effect.sync(() => writeFileSync(loom, formatted))
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
    if (check && changed.length > 0) yield* Effect.sync(() => void (process.exitCode = 1))
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

const mergeMcpConfig = (root: string): void => {
  const path = resolvePath(root, '.mcp.json')
  const existing = existsSync(path)
    ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>)
    : {}
  const servers = (existing.mcpServers as Record<string, unknown> | undefined) ?? {}
  const merged = {
    ...existing,
    mcpServers: {
      ...servers,
      loom: { type: 'http', url: 'http://localhost:5710/mcp' },
    },
  }
  writeFileSync(path, JSON.stringify(merged, null, 2) + '\n')
}

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
      yield* Effect.sync(() =>
        writeFileSync(resolvePath(root, '.loom', '.gitignore'), 'services/\n'),
      )
      yield* Console.log(
        `\n   ${teal('✓')} wrote ${configFile}\n` +
          `   ${dim(`primary language: ${language}`)}\n` +
          `   ${dim(`activated: ${ids.join(', ') || 'none'}`)}\n`,
      )
    }

    const manifest = yield* config.manifest(root)
    const corpusDir = resolvePath(root, manifest?.corpus ?? 'corpus')
    yield* Effect.sync(() => mkdirSync(corpusDir, { recursive: true }))
    yield* Console.log(`   ${teal('✓')} corpus at ${corpusDir}\n`)

    yield* Effect.sync(() => mergeMcpConfig(root))
    yield* Console.log(`   ${teal('✓')} wrote ${resolvePath(root, '.mcp.json')}\n`)

    const editorconfig = resolvePath(root, '.editorconfig')
    const current = yield* Effect.sync(() =>
      existsSync(editorconfig) ? readFileSync(editorconfig, 'utf8') : '',
    )
    const block = editorconfigBlock(manifest?.width ?? defaultWidth)
    yield* Option.match(withManagedBlock(current, block), {
      onNone: () => Console.log(`   ${dim(`✓ kept the [*.loom] section in ${editorconfig}`)}\n`),
      onSome: (text) =>
        Effect.sync(() => writeFileSync(editorconfig, text)).pipe(
          Effect.andThen(Console.log(`   ${teal('✓')} wrote ${editorconfig}\n`)),
        ),
    })
  }).pipe(Effect.catchTag('QuitError', () => Console.log(dim('\n   Cancelled.\n'))))

const updateLanguages = (
  config: LoomConfig['Service'],
  dir: string,
  change: (ids: ReadonlyArray<string>) => ReadonlyArray<string>,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const workspace = workspaceRoot(dir)
    const current = yield* config.manifest(workspace)
    const ids = change(Object.keys(current?.languages ?? {}))
    const languages = Object.fromEntries(ids.map((id) => [id, current?.languages?.[id] ?? {}]))
    yield* config.edit(workspace, ['languages'], languages)
  })

const activatedLanguages = (
  config: LoomConfig['Service'],
  dir: string,
): Effect.Effect<ReadonlyArray<string>> =>
  config
    .manifest(workspaceRoot(dir))
    .pipe(Effect.map((manifest) => Object.keys(manifest?.languages ?? {})))

const installNote = (language: string, change: ServiceInstall): string =>
  ServiceInstall.$match(change, {
    Current: () => `${servicePackage(language)} ${serviceVersion} is already in the store`,
    Installed: () => `installed ${servicePackage(language)} ${serviceVersion}`,
    Updated: ({ from }) => `updated ${servicePackage(language)} from ${from} to ${serviceVersion}`,
  })

const failedInstall = (error: StoreError) =>
  refuse(`loom: could not install ${error.packageName} — ${String(error.cause)}`)

const alreadyActive = (language: string, dir: string) =>
  Console.log(
    `\n   ${teal('✓')} ${language} is already activated\n` +
      Option.match(installedVersion(language, dir), {
        onNone: () =>
          `   ${dim(`its service is not in the store; \`loom update ${language}\` installs it`)}\n`,
        onSome: (version) =>
          version === serviceVersion
            ? ''
            : `   ${dim(`the store holds its service at ${version}; \`loom update ${language}\` brings it to ${serviceVersion}`)}\n`,
      }),
  )

const add = (language: string) =>
  Effect.gen(function* () {
    const config = yield* LoomConfig
    const dir = process.cwd()
    const activated = yield* activatedLanguages(config, dir)
    if (activated.includes(language)) return yield* alreadyActive(language, dir)
    const change = yield* installService(language, dir)
    yield* updateLanguages(config, dir, (ids) => [...ids, language])
    yield* Console.log(
      `\n   ${teal('✓')} activated ${language}\n` +
        `   ${dim(installNote(language, change))}\n` +
        `   ${dim(`store: ${storeDir(dir)}`)}\n`,
    )
  }).pipe(Effect.catchTag('StoreError', failedInstall))

const remove = (language: string) =>
  Effect.gen(function* () {
    const config = yield* LoomConfig
    const dir = process.cwd()
    yield* removeService(language, dir)
    yield* updateLanguages(config, dir, (ids) => ids.filter((id) => id !== language))
    yield* Console.log(`\n   ${teal('✓')} removed ${language}\n`)
  })

const updateUsage = 'usage: loom update <language>… | loom update --all'

const update = (languages: ReadonlyArray<string>, all: boolean) =>
  Effect.gen(function* () {
    if (languages.length === 0 && !all)
      return yield* refuse(
        `loom: name the languages to update, or use --all — ${updateUsage}\n` +
          '      To upgrade Loom itself, run `loom upgrade`.',
      )
    if (languages.length > 0 && all)
      return yield* refuse(`loom: name languages or use --all, not both — ${updateUsage}`)
    const config = yield* LoomConfig
    const dir = process.cwd()
    const activated = yield* activatedLanguages(config, dir)
    const inactive = languages.filter((id) => !activated.includes(id))
    if (inactive.length > 0)
      return yield* Effect.forEach(
        inactive,
        (id) => refuse(`loom: ${id} is not activated; \`loom add ${id}\` turns it on`),
        { discard: true },
      )
    const ids = all ? activated : languages
    if (ids.length === 0) return yield* Console.log(`\n   ${dim('no languages are activated')}\n`)
    yield* Console.log('')
    yield* Effect.forEach(ids, (id) =>
      installService(id, dir).pipe(
        Effect.flatMap((change) => Console.log(`   ${teal('✓')} ${dim(installNote(id, change))}`)),
      ),
    )
    yield* Console.log(`   ${dim(`store: ${storeDir(dir)}`)}\n`)
  }).pipe(Effect.catchTag('StoreError', failedInstall))

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

const installationAt = (path: string, otherwise: Installation): Installation =>
  Match.value(path).pipe(
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
    Match.orElse(() => otherwise),
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

const projectCommands: Record<ProjectManager, { readonly add: string; readonly remove: string }> = {
  npm: { add: 'npm install', remove: 'npm uninstall' },
  bun: { add: 'bun add', remove: 'bun remove' },
  pnpm: { add: 'pnpm add', remove: 'pnpm remove' },
  yarn: { add: 'yarn add', remove: 'yarn remove' },
}

const installerUpgrade = Installation.$match({
  Executable: () => Option.none<string>(),
  Unowned: () => Option.none<string>(),
  Homebrew: () => Option.some('brew upgrade loom'),
  Npm: () => Option.some('npm install -g @athrio/loom@latest'),
  Bun: () => Option.some('bun add -g @athrio/loom@latest'),
  Pnpm: () => Option.some('pnpm add -g @athrio/loom@latest'),
  Project: ({ root, manager }) =>
    Option.some(`cd ${quoted(root)} && ${projectCommands[manager].add} @athrio/loom@latest`),
})

const loomVersion = '0.0.16'

const releases = process.env.LOOM_RELEASES ?? 'https://api.github.com/repos/athrio-com/loom/releases'

const ReleaseSchema = Schema.Struct({
  tag_name: Schema.String,
  assets: Schema.Array(Schema.Struct({ name: Schema.String, browser_download_url: Schema.String })),
})

type Release = typeof ReleaseSchema.Type

const versionOrder: Order.Order<string> = Order.mapInput(
  Order.Array(Order.Number),
  (version: string) => version.split('.').map(Number),
)

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

const latestRelease: Effect.Effect<Release, ReleaseUnreachable> = Effect.gen(function* () {
  const url = `${releases}/latest`
  const response = yield* fetched(url)
  const body = yield* Effect.tryPromise({
    try: () => response.json(),
    catch: (cause) => new ReleaseUnreachable({ url, cause }),
  })
  return yield* Schema.decodeUnknownEffect(ReleaseSchema)(body).pipe(
    Effect.mapError((cause) => new ReleaseUnreachable({ url, cause })),
  )
})

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
    sums.split('\n'),
    Array.map((line) => line.trim().split(/\s+/)),
    Array.findFirst((fields) => fields[1] === asset || fields[1] === `*${asset}`),
    Option.flatMap((fields) => Option.fromNullishOr(fields[0])),
  )

const verified = (
  bytes: Uint8Array,
  sums: string,
  asset: string,
): Effect.Effect<Uint8Array, ChecksumMismatch> =>
  Option.contains(listedChecksum(sums, asset), createHash('sha256').update(bytes).digest('hex'))
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

const upgradeStandalone = Effect.gen(function* () {
  const release = yield* latestRelease
  const latest = release.tag_name.replace(/^v/, '')
  if (!Order.isGreaterThan(versionOrder)(latest, loomVersion))
    return yield* Console.log(
      `\n   ${teal('✓')} Loom ${loomVersion} is up to date; the latest release is ${latest}\n`,
    )
  const archive = yield* assetUrl(release, assetName).pipe(Effect.flatMap(bytesAt))
  const sums = yield* assetUrl(release, 'SHA256SUMS').pipe(
    Effect.flatMap(bytesAt),
    Effect.map((bytes) => new TextDecoder().decode(bytes)),
  )
  yield* verified(archive, sums, assetName).pipe(
    Effect.flatMap(unpacked),
    Effect.flatMap(replaceExecutable),
  )
  yield* Console.log(
    `\n   ${teal('✓')} upgraded Loom from ${loomVersion} to ${latest}\n` +
      `   ${dim('run `loom update --all` in each workspace to bring its services along')}\n`,
  )
})

const upgrade = Effect.gen(function* () {
  const command = installerUpgrade(thisInstallation)
  if (Option.isNone(command)) return yield* upgradeStandalone
  yield* Console.log(
    `\n   Loom was ${describedInstallation(thisInstallation)}. Upgrade it with:\n\n` +
      `   ${command.value}\n\n` +
      `   ${dim('then run `loom update --all` in each workspace to bring its services along')}\n`,
  )
}).pipe(
  Effect.catchTags({
    ReleaseUnreachable: (error) =>
      refuse(`loom: could not reach the latest release at ${error.url} — ${String(error.cause)}`),
    ReleaseLacksAsset: (error) =>
      refuse(`loom: release ${error.version} carries no ${error.asset}`),
    ChecksumMismatch: (error) =>
      refuse(
        `loom: the checksum of the downloaded ${error.asset} does not match the release's list, so Loom was left as it was`,
      ),
    UnpackFailed: (error) =>
      refuse(`loom: could not unpack ${error.asset} — ${String(error.cause)}`),
    ReplaceFailed: (error) =>
      refuse(
        `loom: could not replace ${error.path} — ${String(error.cause)}\n` +
          '      Run the install script again, or move Loom somewhere you can write to.',
      ),
  }),
)

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
  pipe(
    (process.env.PATH ?? '').split(delimiter),
    Array.filter((folder) => folder !== ''),
    Array.flatMap((folder) =>
      Array.map(commandNames(command), (name) => resolvePath(folder, name)),
    ),
    Array.filter(isProgram),
    Array.dedupeWith((one, other) => realOf(one) === realOf(other)),
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
      ...pipe(
        rest,
        Array.filter((file) => !isThisLoom(file)),
        Array.map((file) => otherLoom(file, `${file} is on PATH too`)),
      ),
    ],
  })

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
    onNonEmpty: (ids) => Array.map(ids, (id) => serviceFinding(id, root)),
  })

const unfetchedTypeScript = (): Finding => {
  const fetchInto = `TypeScript ${typeScriptVersion} into ${fetchedTypeScriptDir(typeScriptVersion)}`
  return Match.value({ standalone, npm: programsOnPath('npm').length > 0 }).pipe(
    Match.when({ standalone: true }, () =>
      Finding.Fine({
        note: `the language server fetches ${fetchInto} the first time a project with no TypeScript asks`,
      }),
    ),
    Match.when({ npm: true }, () =>
      Finding.Fine({
        note: `the language server fetches ${fetchInto} with npm the first time a project with no TypeScript asks`,
      }),
    ),
    Match.orElse(() =>
      Finding.Problem({
        note: `the language server has no npm to fetch ${fetchInto} with, for a project with no TypeScript`,
        fix: installLine,
      }),
    ),
  )
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
  Array.map(
    findings,
    Finding.$match({
      Fine: ({ note }) => `   ${teal('✓')} ${note}`,
      Problem: ({ note, fix }) => `   ${amber('✗')} ${note}\n       ${fix}`,
    }),
  ).join('\n')

const doctor = Effect.gen(function* () {
  const dir = process.cwd()
  const machine = [thisLoomFinding, ...pathFindings(loomsOnPath())]
  const workspace = workspaceOf(dir)
  const inWorkspace = yield* Option.match(workspace, {
    onNone: () => Effect.succeed([] as ReadonlyArray<Finding>),
    onSome: workspaceFindings,
  })
  const problems = Array.filter([...machine, ...inWorkspace], Finding.$is('Problem')).length
  yield* Console.log(
    `\n   ${dim('this machine')}\n${findingLines(machine)}\n\n` +
      Option.match(workspace, {
        onNone: () => `   ${dim(`no workspace holds ${dir}, so no services to check`)}\n`,
        onSome: (root) => `   ${dim(`the workspace at ${root}`)}\n${findingLines(inWorkspace)}\n`,
      }),
  )
  if (problems === 0) return yield* Console.log(`   ${teal('✓')} no problems found\n`)
  yield* Console.log(`   ${problems === 1 ? '1 problem' : `${problems} problems`} found\n`)
  yield* Effect.sync(() => void (process.exitCode = 1))
})

const set = (name: string, value: string) =>
  Effect.gen(function* () {
    const config = yield* LoomConfig
    const tangler = yield* LoomTangler
    const workspace = workspaceRoot(process.cwd())
    const usage = 'usage: loom set <name> <value>'
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      yield* Console.error(`loom: \`${name}\` is not a variable name — ${usage}`)
      yield* Effect.sync(() => void (process.exitCode = 1))
      return
    }
    if (value.startsWith('=')) {
      yield* Console.error(
        `loom: a value cannot begin with \`=\`; give the name and value with a space, no \`=\` — ${usage}`,
      )
      yield* Effect.sync(() => void (process.exitCode = 1))
      return
    }
    const current = yield* config.manifest(workspace)
    yield* config.edit(workspace, ['variables', name], value)
    const corpus = resolvePath(workspace, current?.corpus ?? 'corpus')
    const written = yield* tangler.tangle(corpus)
    yield* Console.log(`loom: set ${name} = ${value} (re-tangled ${written.length} files)`)
  }).pipe(
    Effect.catchTag('TangleError', (e) =>
      Console.error(e.message).pipe(Effect.andThen(Effect.sync(() => void (process.exitCode = 1)))),
    ),
  )

class DesignMissing extends Data.TaggedError('DesignMissing')<{
  readonly directory: string
}> {}

const manifestOf = (base: string) =>
  Effect.try(() => createRequire(base).resolve('@athrio/loom-design/package.json'))

const designBinary = Effect.gen(function* () {
  const directory = process.cwd()
  const manifest = yield* manifestOf(resolvePath(directory, 'index.js')).pipe(
    Effect.catch(() => manifestOf(import.meta.url)),
    Effect.mapError(() => new DesignMissing({ directory })),
  )
  return resolvePath(dirname(manifest), 'dist', 'loom-design.js')
})

const design = (project: string, application: string, port: number) =>
  Effect.gen(function* () {
    const binary = yield* designBinary
    const code = yield* Effect.scoped(
      Effect.flatMap(
        ChildProcess.make(binary, [project, application, '--port', String(port)], {
          stdin: 'inherit',
          stdout: 'inherit',
          stderr: 'inherit',
        }),
        (running) => running.exitCode,
      ),
    )
    yield* Effect.sync(() => void (process.exitCode = code))
  }).pipe(
    Effect.catchTag('DesignMissing', () =>
      Console.error(
        'loom: Loom Design is not installed.\n' +
          '      Add it with `bun add -d @athrio/loom-design`, then run this again.',
      ).pipe(Effect.andThen(Effect.sync(() => void (process.exitCode = 1)))),
    ),
    Effect.catchCause((cause) =>
      Console.error(`loom: Loom Design could not start\n${Cause.pretty(cause)}`).pipe(
        Effect.andThen(Effect.sync(() => void (process.exitCode = 1))),
      ),
    ),
  )

const embeddedGrammar: Effect.Effect<Option.Option<Readonly<Record<string, string>>>> =
  Effect.tryPromise(() => import('virtual:tree-sitter-loom')).pipe(
    Effect.map((module) => Option.some(module.default)),
    Effect.orElseSucceed(() => Option.none()),
  )

const unpackedGrammar = (
  files: Readonly<Record<string, string>>,
): Effect.Effect<string, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => mkdtempSync(resolvePath(tmpdir(), 'loom-grammar-'))),
    (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
  ).pipe(
    Effect.tap((dir) =>
      Effect.forEach(
        Object.entries(files),
        ([path, text]) =>
          Effect.sync(() => {
            mkdirSync(dirname(resolvePath(dir, path)), { recursive: true })
            writeFileSync(resolvePath(dir, path), text)
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

const shippedGrammar: Effect.Effect<string, GrammarMissing, Scope.Scope> = embeddedGrammar.pipe(
  Effect.flatMap(
    Option.match({
      onSome: unpackedGrammar,
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
    yield* Effect.sync(() => renameSync(partial, library))
  })

const grammarLibrary = process.platform === 'win32' ? 'loom.dll' : 'loom.so'

const writeLibrary = (prebuilt: Blob, library: string): Effect.Effect<void> =>
  Effect.promise(() => prebuilt.arrayBuffer()).pipe(
    Effect.flatMap((bytes) =>
      Effect.sync(() => {
        const partial = `${library}.${process.pid}`
        writeFileSync(partial, new Uint8Array(bytes), { mode: 0o755 })
        renameSync(partial, library)
      }),
    ),
  )

const buildGrammar = (grammar: string, library: string) =>
  Option.match(embeddedFile(grammarLibrary), {
    onSome: (prebuilt) => writeLibrary(prebuilt, library),
    onNone: () => compileGrammar(grammar, library),
  })

const refuse = (message: string) =>
  Console.error(message).pipe(Effect.andThen(Effect.sync(() => void (process.exitCode = 1))))

const cannotCompile = (error: GrammarCompileFailed) =>
  refuse(
    `loom: could not compile the grammar with \`${error.compiler}\`.\n` +
      '      Install a C compiler, or name one in the CC variable, then run this again.',
  )

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
  const config = helixConfigDir()
  const languagesFile = resolvePath(config, 'languages.toml')
  const grammar = yield* shippedGrammar
  const current = yield* Effect.sync(() =>
    existsSync(languagesFile) ? readFileSync(languagesFile, 'utf8') : '',
  )
  const languages = yield* withLoomLanguages(languagesFile, current)

  const library = resolvePath(config, 'runtime', 'grammars', grammarLibrary)
  yield* Effect.sync(() => mkdirSync(dirname(library), { recursive: true }))
  yield* buildGrammar(grammar, library)
  yield* Console.log(`\n   ${teal('✓')} built the grammar into ${library}`)

  const queries = resolvePath(config, 'runtime', 'queries', 'loom')
  yield* Effect.sync(() =>
    cpSync(resolvePath(grammar, 'editors', 'helix', 'queries', 'loom'), queries, {
      recursive: true,
    }),
  )
  yield* Console.log(`   ${teal('✓')} copied the queries into ${queries}`)

  yield* Effect.sync(() => writeFileSync(languagesFile, languages))
  yield* Console.log(
    `   ${teal('✓')} added Loom to ${languagesFile}\n` +
      `   ${dim('check it with `hx --health loom`')}\n`,
  )
}).pipe(
  Effect.scoped,
  Effect.catchTags({
    GrammarMissing: () => refuse('loom: this installation of Loom carries no grammar for Helix.'),
    GrammarCompileFailed: cannotCompile,
    HelixConfigClash: (error) =>
      refuse(
        `loom: ${error.file} already sets up Loom.\n` +
          '      Remove its Loom entries, then run this again to replace them with the managed block.',
      ),
  }),
)

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
  const site = nvimSiteDir()
  const pluginFile = resolvePath(site, 'plugin', 'loom.lua')
  const grammar = yield* shippedGrammar
  const current = yield* Effect.sync(() =>
    existsSync(pluginFile) ? Option.some(readFileSync(pluginFile, 'utf8')) : Option.none<string>(),
  )
  if (Option.exists(current, (text) => !text.startsWith(nvimHeader)))
    return yield* Effect.fail(new NvimConfigClash({ file: pluginFile }))

  const parser = resolvePath(site, 'parser', 'loom.so')
  yield* Effect.sync(() => mkdirSync(dirname(parser), { recursive: true }))
  yield* buildGrammar(grammar, parser)
  yield* Console.log(`\n   ${teal('✓')} built the grammar into ${parser}`)

  const queries = resolvePath(site, 'queries', 'loom')
  yield* Effect.sync(() => cpSync(resolvePath(grammar, 'queries'), queries, { recursive: true }))
  yield* Console.log(`   ${teal('✓')} copied the queries into ${queries}`)

  yield* Effect.sync(() => {
    mkdirSync(dirname(pluginFile), { recursive: true })
    writeFileSync(pluginFile, nvimPlugin)
  })
  yield* Console.log(
    `   ${teal('✓')} added Loom to ${pluginFile}\n` +
      `   ${dim('check it with `:checkhealth vim.treesitter` in Neovim')}\n`,
  )
}).pipe(
  Effect.scoped,
  Effect.catchTags({
    GrammarMissing: () => refuse('loom: this installation of Loom carries no grammar for Neovim.'),
    GrammarCompileFailed: cannotCompile,
    NvimConfigClash: (error) =>
      refuse(
        `loom: ${error.file} was not written by \`loom nvim\`.\n` +
          '      Move it aside, then run this again.',
      ),
  }),
)

const tangleCommand = Command.make(
  'tangle',
  { path: Argument.String('path'), watch: Flag.Boolean('watch').pipe(Flag.withDefault(false)) },
  ({ path, watch }) => tangle(path, watch),
)

const orphansCommand = Command.make(
  'orphans',
  { prune: Flag.Boolean('prune').pipe(Flag.withDefault(false)) },
  ({ prune }) => orphans(prune),
)

const weaveCommand = Command.make(
  'weave',
  { path: Argument.String('path'), out: Argument.String('out') },
  ({ path, out }) => weave(path, out),
)

const formatCommand = Command.make(
  'format',
  { path: Argument.String('path'), check: Flag.Boolean('check').pipe(Flag.withDefault(false)) },
  ({ path, check }) => format(path, check),
)

const tocCommand = Command.make('toc', { path: Argument.String('path') }, ({ path }) => toc(path))

const initCommand = Command.make(
  'init',
  { dir: Argument.optional(Argument.Directory('dir')) },
  ({ dir }) => init(dir),
)

const addCommand = Command.make('add', { language: Argument.String('language') }, ({ language }) =>
  add(language),
)

const removeCommand = Command.make(
  'remove',
  { language: Argument.String('language') },
  ({ language }) => remove(language),
)

const updateCommand = Command.make(
  'update',
  {
    languages: Argument.String('language').pipe(Argument.variadic()),
    all: Flag.Boolean('all').pipe(Flag.withDefault(false)),
  },
  ({ languages, all }) => update(languages, all),
)

const upgradeCommand = Command.make('upgrade', {}, () => upgrade)

const statusCommand = Command.make('status', {}, () => status)

const doctorCommand = Command.make('doctor', {}, () => doctor)

const setCommand = Command.make(
  'set',
  { name: Argument.String('name'), value: Argument.String('value') },
  ({ name, value }) => set(name, value),
)

const designCommand = Command.make(
  'design',
  {
    project: Argument.String('name'),
    application: Argument.String('address'),
    port: Flag.Int('port').pipe(Flag.withDefault(5710)),
  },
  ({ project, application, port }) => design(project, application, port),
)

const helixCommand = Command.make('helix', {}, () => helix)

const nvimCommand = Command.make('nvim', {}, () => nvim)

const loom = Command.make('loom').pipe(
  Command.withSubcommands([
    tangleCommand,
    orphansCommand,
    weaveCommand,
    tocCommand,
    formatCommand,
    initCommand,
    addCommand,
    removeCommand,
    updateCommand,
    upgradeCommand,
    statusCommand,
    doctorCommand,
    setCommand,
    designCommand,
    helixCommand,
    nvimCommand,
  ]),
)

const program = Command.run(loom, { version: loomVersion }).pipe(
  Effect.provide(LoomTangler.layer),
  Effect.provide(LoomWeaver.layer),
  Effect.provide(LoomContents.layer),
  Effect.provide(LoomFormatter.layer),
  Effect.provide(DocumentSource.layer),
  Effect.provide(PackageConfig.layer),
  Effect.provide(LoomConfig.layer),
  Effect.provide(NodeServices.layer),
)

if (process.argv[2] === 'lsp') {
  ;(globalThis as { require?: unknown }).require = createRequire(import.meta.url)
  const { startLanguageServer } = await import('@athrio/loom-lang/LoomServer')
  startLanguageServer()
} else {
  NodeRuntime.runMain(program)
}
