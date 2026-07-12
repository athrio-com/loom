import { Console, Effect, FileSystem, Layer, Option, Schema } from 'effect'
import { Argument, Command, Prompt } from 'effect/unstable/cli'
import { BunRuntime, BunServices } from '@effect/platform-bun'
import { existsSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import { DocumentSource } from '@athrio/loom-lang/LoomCompiler'
import { LoomTangler } from '@athrio/loom-lang/LoomTangler'
import { LoomWeaver } from '@athrio/loom-lang/weave/LoomWeaver'
import { PackageConfig } from '@athrio/loom-lang/PackageConfig'
import { LoomConfig } from '@athrio/loom-config/LoomConfig'
import {
  addService,
  installedServices,
  removeService,
  servicePackage,
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

const tangle = (file: string) =>
  Effect.gen(function* () {
    const tangler = yield* LoomTangler
    const written = yield* tangler.tangle(resolvePath(process.cwd(), file))
    if (written.length === 0) {
      yield* Console.log('loom: no {path} sinks to tangle')
    } else {
      yield* Effect.forEach(written, (f) =>
        Console.log(`loom: tangled ${f.section} → ${f.path}`),
      )
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

const init = (dir: Option.Option<string>) =>
  Effect.gen(function* () {
    const root = resolvePath(process.cwd(), Option.getOrElse(dir, () => '.'))
    const config = yield* LoomConfig
    yield* banner

    const exists = yield* Effect.sync(() =>
      existsSync(resolvePath(root, '.loom', 'config.yaml')),
    )
    if (exists) {
      const overwrite = yield* Prompt.run(
        Prompt.confirm({
          message: `.loom/config.yaml already exists in ${root} — overwrite it?`,
          initial: false,
        }),
      )
      if (!overwrite) {
        return yield* Console.log(
          dim('   Left the existing configuration untouched.\n'),
        )
      }
    }

    const language = yield* Prompt.run(
      Prompt.text({
        message: 'Primary language for specifier-less sections',
        default: 'typescript',
      }),
    )
    const activation = yield* Prompt.run(
      Prompt.text({
        message: 'Activate editor services for (space-separated language ids)',
        default: language,
      }),
    )
    const ids = activation.split(/\s+/).filter((id) => id.length > 0)

    yield* config.materialize(root, {
      corpus: 'corpus',
      languages: Object.fromEntries(ids.map((id) => [id, {}])),
      primary: language,
    })
    yield* Effect.sync(() =>
      writeFileSync(resolvePath(root, '.loom', '.gitignore'), 'services/\n'),
    )
    yield* Console.log(
      `\n   ${teal('✓')} wrote ${resolvePath(root, '.loom', 'config.yaml')}\n` +
        `   ${dim(`primary language: ${language}`)}\n` +
        `   ${dim(`activated: ${ids.join(', ') || 'none'}`)}\n`,
    )
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
    yield* addService(language, dir)
    yield* updateLanguages(config, dir, (ids) => [
      ...new Set([...ids, language]),
    ])
    yield* Console.log(
      `\n   ${teal('✓')} activated ${language}\n` +
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

const defaultPort = 5710

const loomDir = process.env.LOOM_NOTES_DIR ?? join(homedir(), '.loom')
const recordFile = join(loomDir, 'api.json')

const ServerRecord = Schema.Struct({ pid: Schema.Number, port: Schema.Number })

const readRecord = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  return yield* fs.readFileString(recordFile).pipe(
    Effect.flatMap((text) => Effect.try(() => JSON.parse(text) as unknown)),
    Effect.flatMap(Schema.decodeUnknownEffect(ServerRecord)),
    Effect.map(Option.some),
    Effect.orElseSucceed(() => Option.none<typeof ServerRecord.Type>()),
  )
})

const alive = (pid: number): Effect.Effect<boolean> =>
  Effect.try(() => process.kill(pid, 0)).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  )

const runningServer = readRecord.pipe(
  Effect.flatMap(
    Option.match({
      onNone: () => Effect.succeed(Option.none<typeof ServerRecord.Type>()),
      onSome: (record) =>
        alive(record.pid).pipe(
          Effect.map((up) => (up ? Option.some(record) : Option.none())),
        ),
    }),
  ),
)

const spawnServer = (port: number): Effect.Effect<number> =>
  Effect.sync(() => {
    const child = Bun.spawn([process.execPath, process.argv[1], 'serve', String(port)], {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore'],
    })
    child.unref()
    return child.pid
  })

const start = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  yield* Option.match(yield* runningServer, {
    onSome: (record) =>
      Console.log(
        `\n   ${teal('●')} notes server already running on http://localhost:${record.port}\n`,
      ),
    onNone: () =>
      Effect.gen(function* () {
        const pid = yield* spawnServer(defaultPort)
        yield* fs.makeDirectory(loomDir, { recursive: true })
        yield* fs.writeFileString(recordFile, JSON.stringify({ pid, port: defaultPort }))
        yield* Console.log(
          `\n   ${teal('✓')} notes server on http://localhost:${defaultPort}\n` +
            `   ${dim('stop it with `loom stop`')}\n`,
        )
      }),
  })
})

const stop = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  yield* Option.match(yield* runningServer, {
    onSome: (record) =>
      Effect.try(() => process.kill(record.pid)).pipe(
        Effect.ignore,
        Effect.andThen(fs.remove(recordFile, { force: true })),
        Effect.andThen(Console.log(`\n   ${teal('✓')} stopped the notes server\n`)),
      ),
    onNone: () =>
      fs.remove(recordFile, { force: true }).pipe(
        Effect.andThen(Console.log(dim('\n   The notes server is not running.\n'))),
      ),
  })
})

const status = Effect.gen(function* () {
  const config = yield* LoomConfig
  const dir = process.cwd()
  const manifest = yield* config.manifest(workspaceRoot(dir))
  const primary = manifest?.primary
  const languages = Object.keys(manifest?.languages ?? {})
  const installed = new Set(yield* installedServices(dir))
  const server = Option.match(yield* runningServer, {
    onSome: (record) => `${teal('●')} running on http://localhost:${record.port}`,
    onNone: () => dim('○ stopped'),
  })
  const mark = (id: string): string =>
    installed.has(id)
      ? `   ${teal('●')} ${id}`
      : `   ${dim('○')} ${id}${dim(`  — run \`loom add ${id}\``)}`
  yield* Console.log(
    `\n   ${dim('store')}      ${storeDir(dir)}\n` +
      `   ${dim('primary')}    ${primary ?? dim('(none)')}\n` +
      `   ${dim('activated')}  ${
        languages.length === 0 ? dim('(none)') : languages.join(', ')
      }\n` +
      `   ${dim('server')}     ${server}\n`,
  )
  if (languages.length > 0) yield* Console.log(`${languages.map(mark).join('\n')}\n`)
})

const tangleCommand = Command.make(
  'tangle',
  { path: Argument.string('path') },
  ({ path }) => tangle(path),
)

const weaveCommand = Command.make(
  'weave',
  { path: Argument.string('path'), out: Argument.string('out') },
  ({ path, out }) => weave(path, out),
)

const initCommand = Command.make(
  'init',
  { dir: Argument.optional(Argument.directory('dir')) },
  ({ dir }) => init(dir),
)

const addCommand = Command.make(
  'add',
  { language: Argument.string('language') },
  ({ language }) => add(language),
)

const removeCommand = Command.make(
  'remove',
  { language: Argument.string('language') },
  ({ language }) => remove(language),
)

const statusCommand = Command.make('status', {}, () => status)

const startCommand = Command.make('start', {}, () => start)

const stopCommand = Command.make('stop', {}, () => stop)

const loom = Command.make('loom').pipe(
  Command.withSubcommands([
    tangleCommand,
    weaveCommand,
    initCommand,
    addCommand,
    removeCommand,
    statusCommand,
    startCommand,
    stopCommand,
  ]),
)

const program = Command.run(loom, {
  version: '0.9.0',
}).pipe(
  Effect.provide(LoomTangler.layer),
  Effect.provide(LoomWeaver.layer),
  Effect.provide(DocumentSource.layer),
  Effect.provide(PackageConfig.layer),
  Effect.provide(LoomConfig.layer),
  Effect.provide(BunServices.layer),
)

if (process.argv[2] === 'lsp') {
  const { createRequire } = await import('node:module')
  ;(globalThis as { require?: unknown }).require = createRequire(import.meta.url)
  const { startLanguageServer } = await import('@athrio/loom-lang/LoomServer')
  startLanguageServer()
} else if (process.argv[2] === 'serve') {
  const { notesServer } = await import('./api')
  const port = Number(process.argv[3] ?? defaultPort)
  BunRuntime.runMain(
    Layer.launch(notesServer(port)).pipe(Effect.provide(BunServices.layer)),
  )
} else {
  BunRuntime.runMain(program)
}
