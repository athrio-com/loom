import { Console, Data, Effect } from 'effect'
import { NodeRuntime } from '@effect/platform-node'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const build = join(here, 'build')

class CompileError extends Data.TaggedError('CompileError')<{
  readonly command: string
}> {}

const run = (command: ReadonlyArray<string>): Effect.Effect<void, CompileError> =>
  Effect.tryPromise({
    try: () => Bun.spawn([...command], { cwd: here, stdout: 'inherit', stderr: 'inherit' }).exited,
    catch: () => new CompileError({ command: command.join(' ') }),
  }).pipe(
    Effect.flatMap((code) =>
      code === 0 ? Effect.void : Effect.fail(new CompileError({ command: command.join(' ') })),
    ),
  )

const grammarLibrary = process.platform === 'win32' ? 'loom.dll' : 'loom.so'

const grammarSource = join(here, '..', 'tree-sitter-loom', 'src')

const compiledGrammar = run([
  process.env.CC ?? 'cc',
  '-shared',
  '-fPIC',
  '-O2',
  '-I',
  grammarSource,
  join(grammarSource, 'parser.c'),
  join(grammarSource, 'scanner.c'),
  '-o',
  join(build, grammarLibrary),
])

const compiledExecutable = run([
  process.execPath,
  'build',
  join(here, 'dist', 'main.js'),
  join(build, grammarLibrary),
  '--compile',
  '--asset-naming=[name].[ext]',
  '--outfile',
  join(build, 'loom'),
])

const signedExecutable =
  process.platform === 'darwin'
    ? run(['codesign', '--force', '--sign', '-', '--identifier', 'loom', join(build, 'loom')])
    : Effect.void

const compile = Effect.gen(function* () {
  yield* Effect.sync(() => mkdirSync(build, { recursive: true }))
  yield* compiledGrammar
  yield* compiledExecutable
  yield* signedExecutable
  yield* Console.log(`compile: wrote ${join(build, 'loom')} with ${grammarLibrary}`)
})

NodeRuntime.runMain(
  compile.pipe(
    Effect.catchTag('CompileError', (error) =>
      Console.error(`compile: command failed — ${error.command}`).pipe(
        Effect.andThen(
          Effect.sync(() => {
            process.exitCode = 1
          }),
        ),
      ),
    ),
  ),
)
