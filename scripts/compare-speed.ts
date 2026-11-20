import { Array, Console, Data, Effect, Option, Order, Record, Schema } from 'effect'
import { BunRuntime } from '@effect/platform-bun'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..')

class CommandFailed extends Data.TaggedError('CommandFailed')<{
  readonly command: string
}> {}

class Unrecorded extends Data.TaggedError('Unrecorded')<{}> {}

class Slower extends Data.TaggedError('Slower')<{
  readonly behind: ReadonlyArray<Compared>
}> {}

const ran = (
  command: ReadonlyArray<string>,
  folder: string,
  shown: 'inherit' | 'ignore',
  env: Readonly<Record<string, string>> = {},
): Effect.Effect<void, CommandFailed> => {
  const failed = new CommandFailed({ command: command.join(' ') })
  return Effect.tryPromise({
    try: () =>
      Bun.spawn([...command], {
        cwd: folder,
        stdout: shown,
        stderr: shown,
        env: { ...process.env, ...env },
      }).exited,
    catch: () => failed,
  }).pipe(Effect.flatMap((code) => (code === 0 ? Effect.void : Effect.fail(failed))))
}

type Beside = {
  readonly folder: string
  readonly base: string
  readonly baseRecord: string
  readonly changeRecord: string
}

const besideMade: Effect.Effect<Beside> = Effect.sync(() => {
  const folder = mkdtempSync(join(tmpdir(), 'loom-speed-'))
  return {
    folder,
    base: join(folder, 'base'),
    baseRecord: join(folder, 'base.jsonl'),
    changeRecord: join(folder, 'change.jsonl'),
  }
})

const baseCheckedOut = (beside: Beside, commit: string): Effect.Effect<void, CommandFailed> =>
  ran(['git', 'worktree', 'add', '--detach', beside.base, commit], workspace, 'inherit').pipe(
    Effect.andThen(ran(['bun', 'install', '--frozen-lockfile'], beside.base, 'ignore')),
  )

const besideRemoved = (beside: Beside): Effect.Effect<void> =>
  Effect.ignore(
    ran(['git', 'worktree', 'remove', '--force', beside.base], workspace, 'ignore'),
  ).pipe(
    Effect.andThen(Effect.sync(() => rmSync(beside.folder, { recursive: true, force: true }))),
  )

const speedTests = ['bun', 'test', 'packages/loom-lang/test/Speed.test.ts']

const rounds = 3

const speedsRecorded = (checkout: string, record: string): Effect.Effect<void> =>
  Effect.ignore(ran(speedTests, checkout, 'ignore', { LOOM_SPEED: record }))

const allRecorded = (beside: Beside): Effect.Effect<void> =>
  Effect.asVoid(
    Effect.forEach(Array.range(1, rounds), () =>
      speedsRecorded(beside.base, beside.baseRecord).pipe(
        Effect.andThen(speedsRecorded(workspace, beside.changeRecord)),
      ),
    ),
  )

const SpeedSchema = Schema.Struct({ measure: Schema.String, value: Schema.Number })

type Speed = typeof SpeedSchema.Type

const speedOf = Schema.decodeUnknownOption(Schema.fromJsonString(SpeedSchema))

const speedsIn = (record: string): ReadonlyArray<Speed> =>
  Array.getSomes(
    Option.getOrElse(Option.liftThrowable(() => readFileSync(record, 'utf8'))(), () => '')
      .split('\n')
      .map((line) => speedOf(line)),
  )

const middleOf = (values: Array.NonEmptyReadonlyArray<number>): number => {
  const sorted = Array.sort(values, Order.Number)
  return Option.getOrElse(Array.get(sorted, Math.floor(sorted.length / 2)), () =>
    Array.headNonEmpty(sorted),
  )
}

const middles = (speeds: ReadonlyArray<Speed>): ReadonlyMap<string, number> =>
  new Map(
    Record.toEntries(Array.groupBy(speeds, (speed) => speed.measure)).map(
      ([measure, taken]) => [measure, middleOf(Array.map(taken, (speed) => speed.value))] as const,
    ),
  )

type Compared = { readonly measure: string; readonly base: number; readonly change: number }

const limit = 1.5

const compared = (
  base: ReadonlyMap<string, number>,
  change: ReadonlyMap<string, number>,
): ReadonlyArray<Compared> =>
  Array.getSomes(
    Array.fromIterable(base).map(([measure, was]) =>
      Option.map(
        Option.fromNullishOr(change.get(measure)),
        (now): Compared => ({ measure, base: was, change: now }),
      ),
    ),
  )

const worded = ({ measure, base, change }: Compared): string =>
  `${measure}: ${base.toFixed(1)} at the base, ${change.toFixed(1)} now, ${(change / base).toFixed(2)} times as long`

const judged = (
  base: ReadonlyMap<string, number>,
  change: ReadonlyMap<string, number>,
): Effect.Effect<void, Unrecorded | Slower> => {
  if (base.size === 0)
    return Console.log('compare-speed: the base records no speeds, so there is nothing to compare')
  if (change.size === 0) return Effect.fail(new Unrecorded())
  const pairs = compared(base, change)
  const behind = pairs.filter((pair) => pair.change > pair.base * limit)
  return Console.log(pairs.map(worded).join('\n')).pipe(
    Effect.andThen(behind.length === 0 ? Effect.void : Effect.fail(new Slower({ behind }))),
  )
}

const namedBy = (place: string | undefined): Option.Option<string> =>
  Option.filter(Option.fromNullishOr(place), (commit) => commit !== '')

const baseCommit = Option.getOrElse(
  Option.orElse(namedBy(process.argv[2]), () => namedBy(process.env.MOON_BASE)),
  () => 'main',
)

const comparison = Effect.acquireUseRelease(
  besideMade,
  (beside) =>
    baseCheckedOut(beside, baseCommit).pipe(
      Effect.andThen(allRecorded(beside)),
      Effect.andThen(
        Effect.sync(
          () =>
            [
              middles(speedsIn(beside.baseRecord)),
              middles(speedsIn(beside.changeRecord)),
            ] as const,
        ),
      ),
    ),
  besideRemoved,
).pipe(Effect.flatMap(([base, change]) => judged(base, change)))

const failWith = (message: string): Effect.Effect<void> =>
  Console.error(`compare-speed: ${message}`).pipe(
    Effect.andThen(
      Effect.sync(() => {
        process.exitCode = 1
      }),
    ),
  )

BunRuntime.runMain(
  comparison.pipe(
    Effect.catchTags({
      CommandFailed: (error) => failWith(`command failed — ${error.command}`),
      Unrecorded: () => failWith(`the change recorded no speeds, though ${baseCommit} did`),
      Slower: (error) =>
        failWith(`slower than ${baseCommit}\n${error.behind.map(worded).join('\n')}`),
    }),
  ),
)
