import { Console, Data, Effect, FileSystem, Option } from 'effect'
import { BunRuntime, BunServices } from '@effect/platform-bun'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const corpus = join(workspace, 'corpus')
const cli = join(workspace, 'packages', 'loom', 'dist', 'main.js')
const configFile = join(workspace, '.loom', 'config.yaml')

class BumpError extends Data.TaggedError('BumpError')<{
  readonly command: string
}> {}

const run = (command: ReadonlyArray<string>): Effect.Effect<void, BumpError> =>
  Effect.promise(() =>
    Bun.spawn([...command], { cwd: workspace, stdout: 'inherit', stderr: 'inherit' }).exited,
  ).pipe(
    Effect.flatMap((code) =>
      code === 0 ? Effect.void : Effect.fail(new BumpError({ command: command.join(' ') })),
    ),
  )

const bump = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const target = Option.fromNullishOr(process.argv[2])
  if (Option.isNone(target)) {
    yield* Console.error('usage: bun run bump <version>')
    yield* Effect.sync(() => {
      process.exitCode = 1
    })
    return
  }
  const to = target.value

  const current = yield* fs.readFileString(configFile)
  const config = parseYaml(current) as {
    readonly variables?: Record<string, string>
  }
  const from = config.variables?.version ?? 'unset'
  yield* fs.writeFileString(
    configFile,
    stringifyYaml({ ...config, variables: { ...config.variables, version: to } }),
  )

  yield* run(['bun', cli, 'tangle', corpus])
  yield* Console.log(`bumped ${from} → ${to}`)
}).pipe(Effect.provide(BunServices.layer))

BunRuntime.runMain(
  bump.pipe(
    Effect.catchTag('BumpError', (error) =>
      Console.error(`bump: command failed — ${error.command}`).pipe(
        Effect.andThen(Effect.sync(() => {
          process.exitCode = 1
        })),
      ),
    ),
  ),
)
