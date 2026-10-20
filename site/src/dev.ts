import { Effect, FileSystem } from 'effect'
import { ChildProcess } from 'effect/process'
import { BunRuntime, BunServices } from '@effect/platform-bun'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const siteDir = join(dirname(fileURLToPath(import.meta.url)), '..')

const watcher = (command: string, args: ReadonlyArray<string>) =>
  Effect.scoped(
    Effect.flatMap(
      ChildProcess.make(command, args, {
        cwd: siteDir,
        detached: false,
        stdin: 'inherit',
        stdout: 'inherit',
        stderr: 'inherit',
      }),
      (running) => running.exitCode,
    ),
  )

const clientBuild = watcher('bunx', ['--bun', 'vite', 'build', '--watch', '--emptyOutDir', 'false'])

const server = watcher('bun', ['--watch', 'src/server.ts'])

const development = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  yield* fs.remove(join(siteDir, 'dist'), { recursive: true, force: true })
  const code = yield* Effect.raceFirst(clientBuild, server)
  yield* Effect.sync(() => void (process.exitCode = code))
})

BunRuntime.runMain(development.pipe(Effect.provide(BunServices.layer)))
