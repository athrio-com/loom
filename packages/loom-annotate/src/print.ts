import { Array, Console, Effect, FileSystem, Match } from 'effect'
import { BunRuntime, BunServices } from '@effect/platform-bun'
import { discardEntry, readEntries, resolveEntry } from './feedback-log'
import type { Entry } from './entry'

const logPaths = Effect.sync((): ReadonlyArray<string> =>
  Array.fromIterable(new Bun.Glob('**/.loom/feedback.jsonl').scanSync({ dot: true })).filter(
    (path) => !path.includes('node_modules'),
  ),
)

const formatEntry = (entry: Entry): string => {
  const status = (entry.addressed ? 'resolved' : 'open').padEnd(8)
  const lines = [`  #${entry.seq}  ${status}  ${entry.kind}  ·  ${entry.route}`]
  if (entry.kind === 'annotation') {
    lines.push(`      element:  ${entry.label}`)
    lines.push(`      selector: ${entry.selector}`)
  }
  lines.push(`      ${entry.text}`)
  return lines.join('\n')
}

const listProgram = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const paths = yield* logPaths
  const logs = yield* Effect.forEach(paths, (path) =>
    readEntries(fs, path).pipe(Effect.map((entries) => ({ path, entries }))),
  )
  const all = Array.flatMap(logs, (log) => log.entries)
  const open = Array.filter(all, (entry) => !entry.addressed).length

  if (all.length === 0) {
    yield* Console.log('No annotations yet.')
    return
  }

  yield* Console.log(`Loom annotations — ${all.length} total, ${open} open`)
  yield* Effect.forEach(logs, (log) =>
    Effect.gen(function* () {
      yield* Console.log(`\n${log.path}`)
      yield* Effect.forEach(log.entries, (entry) => Console.log(formatEntry(entry)))
    }),
  )
})

const changeLog = (
  op: (fs: FileSystem.FileSystem, path: string, seq: number) => Effect.Effect<void, unknown>,
  done: (seq: number, path: string) => string,
  usage: string,
  rest: ReadonlyArray<string>,
): Effect.Effect<void, unknown, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const seq = Number(rest[0])
    if (!Number.isInteger(seq)) {
      yield* Console.error(usage)
      return
    }
    const found = rest[1] ? [rest[1]] : yield* logPaths
    if (found.length !== 1) {
      yield* Console.error(
        found.length === 0
          ? 'No .loom/feedback.jsonl found.'
          : `Several logs — name one:\n  ${found.join('\n  ')}`,
      )
      return
    }
    const path = found[0]!
    yield* op(fs, path, seq)
    yield* Console.log(done(seq, path))
  })

const [command, ...rest] = process.argv.slice(2)

const program = Match.value(command ?? 'list').pipe(
  Match.withReturnType<Effect.Effect<void, unknown, FileSystem.FileSystem>>(),
  Match.when('list', () => listProgram),
  Match.when('resolve', () =>
    changeLog(
      resolveEntry,
      (seq, path) => `Resolved #${seq} in ${path}`,
      'Usage: loom-annotate resolve <seq> [log]',
      rest,
    ),
  ),
  Match.when('discard', () =>
    changeLog(
      discardEntry,
      (seq, path) => `Discarded #${seq} in ${path}`,
      'Usage: loom-annotate discard <seq> [log]',
      rest,
    ),
  ),
  Match.orElse(() =>
    Console.error('Usage: loom-annotate [list | resolve <seq> [log] | discard <seq> [log]]'),
  ),
)

program.pipe(Effect.provide(BunServices.layer), BunRuntime.runMain)
