import { Array, Console, Data, Effect, pipe } from 'effect'
import { NodeRuntime } from '@effect/platform-node'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

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

const typeScriptDir = dirname(createRequire(import.meta.url).resolve('typescript/package.json'))

const typeScriptFiles = (): ReadonlyArray<string> => [
  'package.json',
  'lib/typescript.js',
  ...pipe(
    readdirSync(join(typeScriptDir, 'lib')),
    Array.filter((name) => name.startsWith('lib.') && name.endsWith('.d.ts')),
    Array.map((name) => `lib/${name}`),
  ),
]

const packedTypeScript = Effect.sync(() =>
  writeFileSync(
    join(build, 'typescript.json.gz'),
    gzipSync(
      JSON.stringify({
        files: Object.fromEntries(
          Array.map(typeScriptFiles(), (file) => [
            file,
            readFileSync(join(typeScriptDir, file), 'utf8'),
          ]),
        ),
      }),
      { level: 9 },
    ),
  ),
)

const compiledExecutable = run([
  process.execPath,
  'build',
  join(here, 'dist', 'main.js'),
  join(build, grammarLibrary),
  join(build, 'typescript.json.gz'),
  '--compile',
  '--asset-naming=[name].[ext]',
  '--outfile',
  join(build, 'loom'),
])

const compile = Effect.gen(function* () {
  yield* Effect.sync(() => mkdirSync(build, { recursive: true }))
  yield* compiledGrammar
  yield* packedTypeScript
  yield* compiledExecutable
  yield* Console.log(`compile: wrote ${join(build, 'loom')} with ${grammarLibrary} and TypeScript`)
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
