import { Cause, Console, Data, Effect, Option, Result, Stream, pipe } from 'effect'
import { Argument, Command, Flag, Prompt } from 'effect/cli'
import { ChildProcess } from 'effect/process'
import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DocumentSource,
  type TangledFile,
  type TangleError,
} from '@athrio/loom-lang/LoomCompiler'
import { LoomTangler } from '@athrio/loom-lang/LoomTangler'
import { LoomWeaver } from '@athrio/loom-lang/weave/LoomWeaver'
import { LoomContents } from '@athrio/loom-lang/weave/LoomContents'
import { PackageConfig } from '@athrio/loom-lang/PackageConfig'
import { LoomConfig } from '@athrio/loom-config/LoomConfig'
import {
  addService,
  installedVersion,
  removeService,
  ServiceInstall,
  servicePackage,
  serviceVersion,
  storeDir,
  workspaceRoot,
} from '@athrio/loom-lang-services/LoomStore'

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

const banner = Console.log(
  `\n${teal(wordmark)}\n   ${dim('a literate framework')}\n`,
)

const reportWritten = (
  written: ReadonlyArray<TangledFile>,
): Effect.Effect<void> =>
  written.length === 0
    ? Console.log('loom: no {path} sinks to tangle')
    : Effect.forEach(
        written,
        (f) => Console.log(`loom: tangled ${f.section} → ${f.path}`),
        { discard: true },
      )

const tangleOnce = (file: string) =>
  Effect.gen(function* () {
    const tangler = yield* LoomTangler
    const written = yield* tangler.tangle(resolvePath(process.cwd(), file))
    yield* reportWritten(written)
  }).pipe(
    Effect.catchTag('TangleError', (e) =>
      Console.error(e.message).pipe(
        Effect.andThen(Effect.sync(() => void (process.exitCode = 1))),
      ),
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

const tangle = (file: string, watch: boolean) =>
  watch ? tangleWatch(file) : tangleOnce(file)

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
      Console.error(e.message).pipe(
        Effect.andThen(Effect.sync(() => void (process.exitCode = 1))),
      ),
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

const init = (dir: Option.Option<string>) =>
  Effect.gen(function* () {
    const root = resolvePath(process.cwd(), Option.getOrElse(dir, () => '.'))
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

    const corpusDir = yield* config
      .manifest(root)
      .pipe(Effect.map((manifest) => resolvePath(root, manifest?.corpus ?? 'corpus')))
    yield* Effect.sync(() => mkdirSync(corpusDir, { recursive: true }))
    yield* Console.log(`   ${teal('✓')} corpus at ${corpusDir}\n`)

    yield* Effect.sync(() => mergeMcpConfig(root))
    yield* Console.log(`   ${teal('✓')} wrote ${resolvePath(root, '.mcp.json')}\n`)
  }).pipe(
    Effect.catchTag('QuitError', () => Console.log(dim('\n   Cancelled.\n'))),
  )

const updateLanguages = (
  config: LoomConfig['Service'],
  dir: string,
  change: (ids: ReadonlyArray<string>) => ReadonlyArray<string>,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const workspace = workspaceRoot(dir)
    const current = yield* config.manifest(workspace)
    const ids = change(Object.keys(current?.languages ?? {}))
    const languages = Object.fromEntries(
      ids.map((id) => [id, current?.languages?.[id] ?? {}]),
    )
    yield* config.materialize(workspace, { ...(current ?? {}), languages })
  })

const add = (language: string) =>
  Effect.gen(function* () {
    const config = yield* LoomConfig
    const dir = process.cwd()
    const change = yield* addService(language, dir)
    yield* updateLanguages(config, dir, (ids) => [
      ...new Set([...ids, language]),
    ])
    const service = `${servicePackage(language)} ${serviceVersion}`
    const done = ServiceInstall.$match(change, {
      Current: () => `${service} is already in the store`,
      Installed: () => `installed ${service}`,
      Updated: ({ from }) => `updated ${servicePackage(language)} from ${from} to ${serviceVersion}`,
    })
    yield* Console.log(
      `\n   ${teal('✓')} activated ${language}\n` +
        `   ${dim(done)}\n` +
        `   ${dim(`store: ${storeDir(dir)}`)}\n`,
    )
  }).pipe(
    Effect.catchTag('StoreError', (error) =>
      Console.error(
        `loom: could not install ${servicePackage(error.id)} — ${String(error.cause)}`,
      ).pipe(Effect.andThen(Effect.sync(() => void (process.exitCode = 1)))),
    ),
  )

const remove = (language: string) =>
  Effect.gen(function* () {
    const config = yield* LoomConfig
    const dir = process.cwd()
    yield* removeService(language, dir)
    yield* updateLanguages(config, dir, (ids) =>
      ids.filter((id) => id !== language),
    )
    yield* Console.log(`\n   ${teal('✓')} removed ${language}\n`)
  })

const status = Effect.gen(function* () {
  const config = yield* LoomConfig
  const dir = process.cwd()
  const manifest = yield* config.manifest(workspaceRoot(dir))
  const primary = manifest?.primary
  const languages = Object.keys(manifest?.languages ?? {})
  const mark = (id: string): string =>
    Option.match(installedVersion(id, dir), {
      onNone: () => `   ${dim('○')} ${id}${dim(`  — run \`loom add ${id}\``)}`,
      onSome: (version) =>
        version === serviceVersion
          ? `   ${teal('●')} ${id}`
          : `   ${dim('◐')} ${id}${dim(`  — ${version} is installed; run \`loom add ${id}\` for ${serviceVersion}`)}`,
    })
  yield* Console.log(
    `\n   ${dim('store')}      ${storeDir(dir)}\n` +
      `   ${dim('primary')}    ${primary ?? dim('(none)')}\n` +
      `   ${dim('activated')}  ${
        languages.length === 0 ? dim('(none)') : languages.join(', ')
      }\n`,
  )
  if (languages.length > 0) yield* Console.log(`${languages.map(mark).join('\n')}\n`)
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
      yield* Console.error(`loom: a value cannot begin with \`=\`; give the name and value with a space, no \`=\` — ${usage}`)
      yield* Effect.sync(() => void (process.exitCode = 1))
      return
    }
    const current = yield* config.manifest(workspace)
    yield* config.materialize(workspace, {
      ...(current ?? {}),
      variables: { ...(current?.variables ?? {}), [name]: value },
    })
    const corpus = resolvePath(workspace, current?.corpus ?? 'corpus')
    const written = yield* tangler.tangle(corpus)
    yield* Console.log(`loom: set ${name} = ${value} (re-tangled ${written.length} files)`)
  }).pipe(
    Effect.catchTag('TangleError', (e) =>
      Console.error(e.message).pipe(
        Effect.andThen(Effect.sync(() => void (process.exitCode = 1))),
      ),
    ),
  )

class DesignMissing extends Data.TaggedError('DesignMissing')<{
  readonly directory: string
}> {}

const manifestOf = (base: string) =>
  Effect.try(() =>
    createRequire(base).resolve('@athrio/loom-design/package.json'),
  )

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
        ChildProcess.make(
          binary,
          [project, application, '--port', String(port)],
          { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' },
        ),
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
      Console.error(
        `loom: Loom Design could not start\n${Cause.pretty(cause)}`,
      ).pipe(Effect.andThen(Effect.sync(() => void (process.exitCode = 1)))),
    ),
  )

class GrammarMissing extends Data.TaggedError('GrammarMissing')<{}> {}

const grammarIn = (dir: string): Option.Option<string> =>
  existsSync(resolvePath(dir, 'src', 'parser.c')) ? Option.some(dir) : Option.none()

const shippedGrammar: Effect.Effect<string, GrammarMissing> = pipe(
  grammarIn(resolvePath(dirname(fileURLToPath(import.meta.url)), 'tree-sitter-loom')),
  Option.orElse(() =>
    Option.flatMap(
      Option.liftThrowable(() =>
        createRequire(import.meta.url).resolve('tree-sitter-loom/package.json'),
      )(),
      (manifest) => grammarIn(dirname(manifest)),
    ),
  ),
  Option.match({
    onNone: () => Effect.fail(new GrammarMissing()),
    onSome: (dir) => Effect.succeed(dir),
  }),
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

const refuse = (message: string) =>
  Console.error(message).pipe(
    Effect.andThen(Effect.sync(() => void (process.exitCode = 1))),
  )

const cannotCompile = (error: GrammarCompileFailed) =>
  refuse(
    `loom: could not compile the grammar with \`${error.compiler}\`.\n` +
      '      Install a C compiler, or name one in the CC variable, then run this again.',
  )

const helixConfigDir = (): string =>
  process.platform === 'win32'
    ? resolvePath(process.env.APPDATA ?? homedir(), 'helix')
    : resolvePath(process.env.XDG_CONFIG_HOME ?? resolvePath(homedir(), '.config'), 'helix')

const grammarLibrary = process.platform === 'win32' ? 'loom.dll' : 'loom.so'

const helixBegin = '# Loom: written by `loom helix`, which replaces this block on every run'
const helixEnd = '# Loom: end'

const helixLanguages = [
  helixBegin,
  '[[language]]',
  'name = "loom"',
  'scope = "source.loom"',
  'file-types = ["loom"]',
  'roots = [".loom"]',
  'injection-regex = "^loom$"',
  'language-servers = ["loom"]',
  '',
  '[language-server.loom]',
  'command = "loom"',
  'args = ["lsp", "--stdio"]',
  helixEnd,
].join('\n')

class HelixConfigClash extends Data.TaggedError('HelixConfigClash')<{
  readonly file: string
}> {}

const withLoomLanguages = (
  file: string,
  text: string,
): Effect.Effect<string, HelixConfigClash> => {
  const start = text.indexOf(helixBegin)
  const end = text.indexOf(helixEnd)
  if (start >= 0 && end > start)
    return Effect.succeed(
      text.slice(0, start) + helixLanguages + text.slice(end + helixEnd.length),
    )
  if (/^\s*name\s*=\s*"loom"/m.test(text))
    return Effect.fail(new HelixConfigClash({ file }))
  const kept = text.replace(/\s*$/, '')
  return Effect.succeed(
    kept === '' ? `${helixLanguages}\n` : `${kept}\n\n${helixLanguages}\n`,
  )
}

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
  yield* compileGrammar(grammar, library)
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
  Effect.catchTags({
    GrammarMissing: () =>
      refuse('loom: this installation of Loom carries no grammar for Helix.'),
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
  "  root_markers = { '.loom', '.git' },",
  '})',
  "vim.lsp.enable('loom')",
  '',
  "vim.api.nvim_create_autocmd('FileType', {",
  "  pattern = 'loom',",
  '  callback = function()',
  '    vim.treesitter.start()',
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
  yield* compileGrammar(grammar, parser)
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
  Effect.catchTags({
    GrammarMissing: () =>
      refuse('loom: this installation of Loom carries no grammar for Neovim.'),
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

const tocCommand = Command.make(
  'toc',
  { path: Argument.String('path') },
  ({ path }) => toc(path),
)

const initCommand = Command.make(
  'init',
  { dir: Argument.optional(Argument.Directory('dir')) },
  ({ dir }) => init(dir),
)

const addCommand = Command.make(
  'add',
  { language: Argument.String('language') },
  ({ language }) => add(language),
)

const removeCommand = Command.make(
  'remove',
  { language: Argument.String('language') },
  ({ language }) => remove(language),
)

const statusCommand = Command.make('status', {}, () => status)

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
    initCommand,
    addCommand,
    removeCommand,
    statusCommand,
    setCommand,
    designCommand,
    helixCommand,
    nvimCommand,
  ]),
)

const program = Command.run(loom, {
  version: '0.0.11',
}).pipe(
  Effect.provide(LoomTangler.layer),
  Effect.provide(LoomWeaver.layer),
  Effect.provide(LoomContents.layer),
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
