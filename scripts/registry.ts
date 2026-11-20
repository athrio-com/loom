import { Console, Effect, FileSystem } from 'effect'
import { BunRuntime, BunServices } from '@effect/platform-bun'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const registry = 'http://localhost:4873'

const verdaccio = 'verdaccio@7.1.2'

const home = join(homedir(), '.loom-dev', 'registry')

const configured = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const config = join(home, 'config.yaml')
  yield* fs.makeDirectory(home, { recursive: true })
  yield* fs.copyFile(join(dirname(fileURLToPath(import.meta.url)), 'registry.yaml'), config)
  return config
})

const serving = (config: string): Effect.Effect<void> =>
  Effect.promise(
    () =>
      Bun.spawn(['bunx', verdaccio, '--config', config, '--listen', registry], {
        cwd: home,
        stdout: 'inherit',
        stderr: 'inherit',
      }).exited,
  ).pipe(
    Effect.flatMap((code) =>
      Effect.sync(() => {
        process.exitCode = code
      }),
    ),
  )

BunRuntime.runMain(
  configured.pipe(
    Effect.tap(() =>
      Console.log(`the registry answers at ${registry} and keeps its packages in ${home}`),
    ),
    Effect.flatMap(serving),
    Effect.provide(BunServices.layer),
  ),
)
