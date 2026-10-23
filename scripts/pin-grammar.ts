import { Console, Data, Effect, Option, pipe } from 'effect'
import { BunRuntime } from '@effect/platform-bun'
import { LoomConfig } from '@athrio/loom-config/LoomConfig'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..')

class CommandFailed extends Data.TaggedError('CommandFailed')<{
  readonly command: string
}> {}

class CannotPin extends Data.TaggedError('CannotPin')<{
  readonly reason: string
}> {}

const spawned = (
  command: ReadonlyArray<string>,
  stdout: 'pipe' | 'inherit',
): Effect.Effect<string, CommandFailed> => {
  const failed = new CommandFailed({ command: command.join(' ') })
  return Effect.tryPromise({
    try: async () => {
      const child = Bun.spawn([...command], { cwd: workspace, stdout, stderr: 'inherit' })
      const text = stdout === 'pipe' ? await new Response(child.stdout).text() : ''
      return { code: await child.exited, text: text.trim() }
    },
    catch: () => failed,
  }).pipe(
    Effect.flatMap(({ code, text }) => (code === 0 ? Effect.succeed(text) : Effect.fail(failed))),
  )
}

const capture = (command: ReadonlyArray<string>): Effect.Effect<string, CommandFailed> =>
  spawned(command, 'pipe')

const run = (command: ReadonlyArray<string>): Effect.Effect<void, CommandFailed> =>
  Effect.asVoid(spawned(command, 'inherit'))

const grammarSources = 'packages/tree-sitter-loom/src'

const lastGrammarCommit: Effect.Effect<string, CommandFailed> = capture([
  'git',
  'log',
  '-1',
  '--format=%H',
  '--',
  grammarSources,
])

const committedSources = (reason: string): Effect.Effect<void, CommandFailed | CannotPin> =>
  Effect.flatMap(capture(['git', 'status', '--porcelain', '--', grammarSources]), (changes) =>
    changes === '' ? Effect.void : Effect.fail(new CannotPin({ reason })),
  )

const nextPatch = (version: Option.Option<string>): Effect.Effect<string, CannotPin> =>
  pipe(
    version,
    Option.flatMap((text) => Option.fromNullishOr(/^(\d+)\.(\d+)\.(\d+)$/.exec(text))),
    Option.map(([, major, minor, patch]) => `${major}.${minor}.${Number(patch) + 1}`),
    Option.match({
      onNone: () =>
        Effect.fail(
          new CannotPin({ reason: 'the zed variable is not a version of three numbers' }),
        ),
      onSome: Effect.succeed,
    }),
  )

const pin = Effect.gen(function* () {
  const config = yield* LoomConfig
  const { variables } = yield* config.resolve(workspace)
  yield* committedSources(`${grammarSources} has uncommitted changes; commit them, then pin`)
  const commit = yield* lastGrammarCommit
  if (variables.grammarRevision === commit) {
    yield* Console.log(`the grammar is pinned to ${commit}, the commit that last changed it`)
    return
  }
  const version = yield* nextPatch(Option.fromNullishOr(variables.zed))
  yield* run(['loom', 'set', 'grammarRevision', commit])
  yield* run(['loom', 'set', 'zed', version])
  yield* committedSources(
    `the re-tangle changed ${grammarSources}; commit that change, then pin again`,
  )
  yield* Console.log(`pinned the grammar to ${commit} and raised the Zed extension to ${version}`)
}).pipe(Effect.provide(LoomConfig.layer))

const failWith = (message: string): Effect.Effect<void> =>
  Console.error(`pin-grammar: ${message}`).pipe(
    Effect.andThen(
      Effect.sync(() => {
        process.exitCode = 1
      }),
    ),
  )

BunRuntime.runMain(
  pin.pipe(
    Effect.catchTags({
      CommandFailed: (error) => failWith(`command failed — ${error.command}`),
      CannotPin: (error) => failWith(error.reason),
    }),
  ),
)
