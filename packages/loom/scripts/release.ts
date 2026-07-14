import { Console, Data, Effect, FileSystem } from 'effect'
import { BunRuntime, BunServices } from '@effect/platform-bun'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

interface Package {
  readonly name: string
  readonly dir: string
}

const published: ReadonlyArray<Package> = [
  { name: '@athrio/loom', dir: join(workspace, 'packages', 'loom') },
  {
    name: '@athrio/loom-service-typescript',
    dir: join(workspace, 'packages', 'loom-service-typescript'),
  },
]

class ReleaseError extends Data.TaggedError('ReleaseError')<{
  readonly command: string
}> {}

const run = (command: ReadonlyArray<string>, cwd: string): Effect.Effect<void, ReleaseError> =>
  Effect.promise(() =>
    Bun.spawn([...command], { cwd, stdout: 'inherit', stderr: 'inherit' }).exited,
  ).pipe(
    Effect.flatMap((code) =>
      code === 0 ? Effect.void : Effect.fail(new ReleaseError({ command: command.join(' ') })),
    ),
  )

const capture = (command: ReadonlyArray<string>): Effect.Effect<string> =>
  Effect.promise(async () => {
    const child = Bun.spawn([...command], { cwd: workspace, stdout: 'pipe', stderr: 'ignore' })
    const text = await new Response(child.stdout).text()
    await child.exited
    return text.trim()
  })

const isPublished = (name: string, version: string): Effect.Effect<boolean> =>
  capture(['npm', 'view', `${name}@${version}`, 'version']).pipe(
    Effect.map((reported) => reported === version),
  )

const publish = (pkg: Package, version: string): Effect.Effect<void, ReleaseError> =>
  isPublished(pkg.name, version).pipe(
    Effect.flatMap((already) =>
      already
        ? Console.log(`${pkg.name}@${version} is already published — skipping`)
        : run(['bun', 'publish'], pkg.dir).pipe(
            Effect.andThen(Console.log(`published ${pkg.name}@${version}`)),
          ),
    ),
  )

const release = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const manifest = yield* fs.readFileString(join(workspace, 'packages', 'loom', 'package.json'))
  const version = (JSON.parse(manifest) as { version: string }).version
  yield* Console.log(`releasing ${version}`)
  yield* Effect.forEach(published, (pkg) => publish(pkg, version))
}).pipe(Effect.provide(BunServices.layer))

BunRuntime.runMain(release)
