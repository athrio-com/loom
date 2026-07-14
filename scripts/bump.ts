import { Array, Console, Data, Effect, FileSystem, Option } from 'effect'
import { BunRuntime, BunServices } from '@effect/platform-bun'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const corpus = join(workspace, 'corpus')
const cli = join(workspace, 'packages', 'loom', 'dist', 'main.js')

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

const replaceVersion = (text: string, from: string, to: string): string =>
  text
    .replaceAll(`"version": "${from}"`, `"version": "${to}"`)
    .replaceAll(`version: '${from}'`, `version: '${to}'`)

const looms: Effect.Effect<ReadonlyArray<string>> = Effect.sync(() => [
  ...new Bun.Glob('**/*.loom').scanSync({ cwd: corpus, absolute: true }),
])

const bump = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const to = yield* Option.match(Option.fromNullishOr(process.argv[2]), {
    onNone: () => Effect.fail(new BumpError({ command: 'bump <version>' })),
    onSome: (version) => Effect.succeed(version),
  })

  const manifest = yield* fs.readFileString(join(workspace, 'packages', 'loom', 'package.json'))
  const from = (JSON.parse(manifest) as { version: string }).version

  const paths = yield* looms
  const changed = yield* Effect.forEach(paths, (path) =>
    fs.readFileString(path).pipe(
      Effect.flatMap((text) => {
        const next = replaceVersion(text, from, to)
        return next === text
          ? Effect.succeed(Option.none<string>())
          : fs.writeFileString(path, next).pipe(Effect.as(Option.some(path)))
      }),
    ),
  ).pipe(Effect.map(Array.getSomes))

  yield* Effect.forEach(changed, (path) => run(['bun', cli, 'tangle', path]))
  yield* Console.log(`bumped ${from} → ${to} across ${changed.length} looms`)
}).pipe(Effect.provide(BunServices.layer))

BunRuntime.runMain(bump)
