import { Console, Effect, Option } from 'effect'
import { Args, Command, Prompt } from '@effect/cli'
import { NodeContext, NodeRuntime } from '@effect/platform-node'
import { existsSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { DocumentSource } from '@athrio/loom-lang/LoomCompiler'
import { LoomTangler } from '@athrio/loom-lang/LoomTangler'
import { PackageConfig } from '@athrio/loom-lang/PackageConfig'
import {
  LoomConfig,
  configFileName,
  type LoomConfigFile,
} from '@athrio/loom-config/LoomConfig'
import {
  addService,
  installedServices,
  removeService,
  servicePackage,
  storeDir,
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
        Effect.zipRight(Effect.sync(() => void (process.exitCode = 1))),
      ),
    ),
  )

const init = (dir: Option.Option<string>) =>
  Effect.gen(function* () {
    const root = resolvePath(process.cwd(), Option.getOrElse(dir, () => '.'))
    const config = yield* LoomConfig
    yield* banner

    const exists = yield* Effect.sync(() =>
      existsSync(resolvePath(root, 'loom.json')),
    )
    if (exists) {
      const overwrite = yield* Prompt.run(
        Prompt.confirm({
          message: `loom.json already exists in ${root} — overwrite it?`,
          initial: false,
        }),
      )
      if (!overwrite) {
        return yield* Console.log(dim('   Left the existing loom.json untouched.\n'))
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
    const languages = activation.split(/\s+/).filter((id) => id.length > 0)

    yield* config.write(root, { primary: language, languages })
    yield* Console.log(
      `\n   ${teal('✓')} wrote ${resolvePath(root, 'loom.json')}\n` +
        `   ${dim(`primary language: ${language}`)}\n` +
        `   ${dim(`activated: ${languages.join(', ') || 'none'}`)}\n`,
    )
  }).pipe(
    Effect.catchTag('QuitException', () => Console.log(dim('\n   Cancelled.\n'))),
  )

const updateLanguages = (
  config: LoomConfig,
  dir: string,
  change: (ids: ReadonlyArray<string>) => ReadonlyArray<string>,
): Effect.Effect<void> =>
  config.resolve(resolvePath(dir, configFileName)).pipe(
    Effect.flatMap((current) => {
      const file: LoomConfigFile = {
        languages: change(current.languages),
        ...(current.primary !== undefined ? { primary: current.primary } : {}),
        ...(current.anchor ? { anchor: current.anchor } : {}),
        ...(Object.keys(current.settings).length > 0
          ? { settings: current.settings }
          : {}),
      }
      return config.write(dir, file)
    }),
  )

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
      ).pipe(Effect.zipRight(Effect.sync(() => void (process.exitCode = 1)))),
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
  const { primary, languages } = yield* config.resolve(
    resolvePath(dir, configFileName),
  )
  const installed = new Set(yield* installedServices(dir))
  const mark = (id: string): string =>
    installed.has(id)
      ? `   ${teal('●')} ${id}`
      : `   ${dim('○')} ${id}${dim(`  — run \`loom add ${id}\``)}`
  yield* Console.log(
    `\n   ${dim('store')}      ${storeDir(dir)}\n` +
      `   ${dim('primary')}    ${primary ?? dim('(none)')}\n` +
      `   ${dim('activated')}  ${
        languages.length === 0 ? dim('(none)') : languages.join(', ')
      }\n`,
  )
  if (languages.length > 0) yield* Console.log(`${languages.map(mark).join('\n')}\n`)
})

const tangleCommand = Command.make(
  'tangle',
  { path: Args.text({ name: 'path' }) },
  ({ path }) => tangle(path),
)

const initCommand = Command.make(
  'init',
  { dir: Args.optional(Args.directory({ name: 'dir' })) },
  ({ dir }) => init(dir),
)

const addCommand = Command.make(
  'add',
  { language: Args.text({ name: 'language' }) },
  ({ language }) => add(language),
)

const removeCommand = Command.make(
  'remove',
  { language: Args.text({ name: 'language' }) },
  ({ language }) => remove(language),
)

const statusCommand = Command.make('status', {}, () => status)

const loom = Command.make('loom').pipe(
  Command.withSubcommands([
    tangleCommand,
    initCommand,
    addCommand,
    removeCommand,
    statusCommand,
  ]),
)

const program = Command.run(loom, {
  name: 'Loom — a literate framework',
  version: '0.5.0',
})(process.argv).pipe(
  Effect.provide(LoomTangler.Default),
  Effect.provide(DocumentSource.Default),
  Effect.provide(PackageConfig.Default),
  Effect.provide(LoomConfig.Default),
  Effect.provide(NodeContext.layer),
)

if (process.argv[2] === 'lsp') {
  const { createRequire } = await import('node:module')
  ;(globalThis as { require?: unknown }).require = createRequire(import.meta.url)
  const { startLanguageServer } = await import('@athrio/loom-lang/LoomServer')
  startLanguageServer()
} else {
  NodeRuntime.runMain(program)
}
