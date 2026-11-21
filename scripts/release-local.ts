import { Array, Console, Data, Effect, FileSystem, Option, Schema, pipe } from 'effect'
import { BunRuntime, BunServices } from '@effect/platform-bun'
import { LoomConfig } from '@athrio/loom-config/LoomConfig'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const devPackages: ReadonlyArray<string> = [
  'loom-ast',
  'loom-config',
  'loom-lang-services',
  'loom-lang',
  'loom-service-typescript',
  'loom-tropes',
  'loom',
]

const registry = 'http://localhost:4873'

class CommandFailed extends Data.TaggedError('CommandFailed')<{
  readonly command: string
}> {}

class CannotRelease extends Data.TaggedError('CannotRelease')<{
  readonly reason: string
}> {}

const spawned = (
  command: ReadonlyArray<string>,
  folder: string,
  stdout: 'pipe' | 'inherit',
): Effect.Effect<string, CommandFailed> => {
  const failed = new CommandFailed({ command: command.join(' ') })
  return Effect.tryPromise({
    try: async (signal) => {
      const child = Bun.spawn([...command], { cwd: folder, stdout, stderr: 'inherit', signal })
      const text = stdout === 'pipe' ? await new Response(child.stdout).text() : ''
      return { code: await child.exited, text: text.trim() }
    },
    catch: () => failed,
  }).pipe(
    Effect.flatMap(({ code, text }) => (code === 0 ? Effect.succeed(text) : Effect.fail(failed))),
  )
}

const capture = (command: ReadonlyArray<string>, folder: string): Effect.Effect<string, CommandFailed> =>
  spawned(command, folder, 'pipe')

const run = (command: ReadonlyArray<string>, folder: string): Effect.Effect<void, CommandFailed> =>
  Effect.asVoid(spawned(command, folder, 'inherit'))

const named = Option.filter(Option.fromNullishOr(process.argv[2]), (name) => name !== '')

const commitOf = (name: string): Effect.Effect<string, CommandFailed> =>
  capture(['git', 'rev-parse', '--verify', `${name}^{commit}`], workspace)

const committed: Effect.Effect<void, CommandFailed | CannotRelease> = capture(
  ['git', 'status', '--porcelain', '--untracked-files=no'],
  workspace,
).pipe(
  Effect.flatMap((changes) =>
    Option.isNone(named) && changes !== ''
      ? Effect.fail(
          new CannotRelease({
            reason:
              'the working tree has uncommitted changes, and a release of HEAD would leave them out; commit them, or name the commit to release, as in `bun run release-local HEAD`',
          }),
        )
      : Effect.void,
  ),
)

const nextPatch = (version: Option.Option<string>): Effect.Effect<string, CannotRelease> =>
  pipe(
    version,
    Option.flatMap((text) => Option.fromNullishOr(/^(\d+)\.(\d+)\.(\d+)$/.exec(text))),
    Option.map(([, major, minor, patch]) => `${major}.${minor}.${Number(patch) + 1}`),
    Option.match({
      onNone: () =>
        Effect.fail(
          new CannotRelease({ reason: 'the version variable is not a version of three numbers' }),
        ),
      onSome: Effect.succeed,
    }),
  )

const HeldPackageSchema = Schema.Struct({
  versions: Schema.Record(Schema.String, Schema.Unknown),
})

const heldPackage = Schema.decodeUnknownOption(HeldPackageSchema)

type RegistryAnswer = {
  readonly status: number
  readonly body: unknown
}

const registryAnswer = (
  path: string,
  request?: RequestInit,
): Effect.Effect<RegistryAnswer, CannotRelease> =>
  Effect.tryPromise({
    try: async (signal): Promise<RegistryAnswer> => {
      const answer = await fetch(`${registry}${path}`, { ...request, signal })
      const body: unknown = await answer.json().catch(() => undefined)
      return { status: answer.status, body }
    },
    catch: () =>
      new CannotRelease({
        reason: `no registry answers at ${registry}; start it with \`bun run registry\``,
      }),
  })

const heldVersions = (folder: string): Effect.Effect<ReadonlyArray<string>, CannotRelease> =>
  registryAnswer(`/@athrio%2f${folder}`).pipe(
    Effect.flatMap(({ status, body }) =>
      status === 404
        ? Effect.succeed<ReadonlyArray<string>>([])
        : Option.match(heldPackage(body), {
            onNone: () =>
              Effect.fail(
                new CannotRelease({
                  reason: `the registry answered ${status} when asked which versions of @athrio/${folder} it holds; its own output says why`,
                }),
              ),
            onSome: ({ versions }) => Effect.succeed<ReadonlyArray<string>>(Object.keys(versions)),
          }),
    ),
  )

const devNumber = (base: string, version: string): Option.Option<number> =>
  pipe(
    Option.fromNullishOr(/^(.+)-dev\.(\d+)$/.exec(version)),
    Option.filter(([, of]) => of === base),
    Option.map(([, , number]) => Number(number)),
  )

const devVersion = (base: string, held: ReadonlyArray<string>): string => {
  const numbers = Array.getSomes(held.map((version) => devNumber(base, version)))
  return `${base}-dev.${Math.max(0, ...numbers) + 1}`
}

type Beside = {
  readonly folder: string
  readonly checkout: string
  readonly packs: string
  readonly settings: string
}

const besideMade: Effect.Effect<Beside, CannotRelease, FileSystem.FileSystem> =
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.makeTempDirectory({ prefix: 'loom-dev-release-' })),
    Effect.mapError(
      () =>
        new CannotRelease({ reason: "no folder could be made under the system's temporary folder" }),
    ),
    Effect.map((folder) => ({
      folder,
      checkout: join(folder, 'loom'),
      packs: join(folder, 'packs'),
      settings: join(folder, 'npmrc'),
    })),
  )

const checkedOut = (beside: Beside, commit: string): Effect.Effect<void, CommandFailed> =>
  run(['git', 'worktree', 'add', '--detach', beside.checkout, commit], workspace).pipe(
    Effect.andThen(run(['bun', 'install', '--frozen-lockfile'], beside.checkout)),
  )

const besideRemoved = (beside: Beside): Effect.Effect<void, never, FileSystem.FileSystem> =>
  Effect.ignore(run(['git', 'worktree', 'remove', '--force', beside.checkout], workspace)).pipe(
    Effect.andThen(FileSystem.FileSystem),
    Effect.flatMap((fs) =>
      Effect.ignore(fs.remove(beside.folder, { recursive: true, force: true })),
    ),
    Effect.andThen(Effect.ignore(run(['git', 'worktree', 'prune'], workspace))),
  )

const versioned = (beside: Beside, version: string): Effect.Effect<void, CommandFailed> =>
  run(['loom', 'set', 'version', version], beside.checkout).pipe(
    Effect.andThen(run(['bun', 'install'], beside.checkout)),
  )

const account = { name: 'loom-dev', password: 'loom-dev' }

const SignedInSchema = Schema.Struct({ token: Schema.String })

const signedInAnswer = Schema.decodeUnknownOption(SignedInSchema)

const signedIn: Effect.Effect<string, CannotRelease> = registryAnswer(
  `/-/user/org.couchdb.user:${account.name}`,
  {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      authorization: `Basic ${btoa(`${account.name}:${account.password}`)}`,
    },
    body: JSON.stringify(account),
  },
).pipe(
  Effect.flatMap(({ body }) =>
    Option.match(signedInAnswer(body), {
      onNone: () =>
        Effect.fail(
          new CannotRelease({
            reason: `the registry refused to sign in as ${account.name}; delete the htpasswd file in the registry's folder, start the registry again, and release again`,
          }),
        ),
      onSome: ({ token }) => Effect.succeed(token),
    }),
  ),
)

const settingsWritten = (
  beside: Beside,
  token: string,
): Effect.Effect<void, CannotRelease, FileSystem.FileSystem> =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) =>
      fs.writeFileString(
        beside.settings,
        `${registry.replace('http:', '')}/:_authToken=${token}\n`,
      ),
    ),
    Effect.mapError(
      () => new CannotRelease({ reason: `npm's settings could not be written to ${beside.settings}` }),
    ),
  )

const packed = (beside: Beside, folder: string): Effect.Effect<void, CommandFailed> =>
  run(
    ['bun', 'pm', 'pack', '--destination', beside.packs],
    join(beside.checkout, 'packages', folder),
  )

const published = (
  beside: Beside,
  folder: string,
  version: string,
): Effect.Effect<void, CommandFailed> =>
  run(
    [
      'npm',
      'publish',
      join(beside.packs, `athrio-${folder}-${version}.tgz`),
      '--tag=dev',
      `--registry=${registry}`,
      `--@athrio:registry=${registry}`,
      `--userconfig=${beside.settings}`,
      '--ignore-scripts',
    ],
    beside.folder,
  )

const release = Effect.gen(function* () {
  const config = yield* LoomConfig
  yield* committed
  const commit = yield* commitOf(Option.getOrElse(named, () => 'HEAD'))
  const held = yield* Effect.forEach(devPackages, heldVersions)
  const token = yield* signedIn
  return yield* Effect.acquireUseRelease(
    besideMade,
    (beside) =>
      Effect.gen(function* () {
        yield* checkedOut(beside, commit)
        const { variables } = yield* config.resolve(beside.checkout)
        const base = yield* nextPatch(Option.fromNullishOr(variables.version))
        const version = devVersion(base, held.flat())
        yield* Console.log(`releasing ${version} from ${commit}`)
        yield* versioned(beside, version)
        yield* Effect.forEach(devPackages, (folder) => packed(beside, folder))
        yield* settingsWritten(beside, token)
        yield* Effect.forEach(devPackages, (folder) => published(beside, folder, version))
        yield* Console.log(`published ${version} to ${registry}`)
      }),
    besideRemoved,
  )
}).pipe(Effect.provide(LoomConfig.layer), Effect.provide(BunServices.layer))

const failWith = (message: string): Effect.Effect<void> =>
  Console.error(`release-local: ${message}`).pipe(
    Effect.andThen(
      Effect.sync(() => {
        process.exitCode = 1
      }),
    ),
  )

BunRuntime.runMain(
  release.pipe(
    Effect.catchTags({
      CommandFailed: (error) => failWith(`command failed — ${error.command}`),
      CannotRelease: (error) => failWith(error.reason),
    }),
  ),
)
