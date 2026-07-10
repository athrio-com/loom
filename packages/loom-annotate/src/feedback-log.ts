import { Option } from 'effect'
import { dirname, resolve } from 'node:path'

const logPath = (): string =>
  Option.match(Option.fromNullishOr(process.env.LOOM_ANNOTATE_LOG), {
    onSome: (path) => path,
    onNone: () => resolve(process.cwd(), '.loom', 'feedback.jsonl'),
  })

import { Effect, FileSystem, Schema } from 'effect'
import { EntrySchema, type Entry } from './entry'

const decodeLine = (line: string): Effect.Effect<Entry, unknown> =>
  Effect.try(() => JSON.parse(line) as unknown).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(EntrySchema)),
  )

export const readEntries = (
  fs: FileSystem.FileSystem,
  path: string,
): Effect.Effect<ReadonlyArray<Entry>, unknown> =>
  Effect.gen(function* () {
    const there = yield* fs.exists(path)
    if (!there) return []
    const raw = yield* fs.readFileString(path)
    const lines = raw.split('\n').filter((line) => line.trim().length > 0)
    return yield* Effect.forEach(lines, decodeLine)
  })

import { Array, pipe } from 'effect'

const writeEntries = (
  fs: FileSystem.FileSystem,
  path: string,
  entries: ReadonlyArray<Entry>,
): Effect.Effect<void, unknown> =>
  Effect.gen(function* () {
    yield* fs.makeDirectory(dirname(path), { recursive: true })
    const body = pipe(
      entries,
      Array.map((entry) => JSON.stringify(entry)),
      Array.join('\n'),
    )
    yield* fs.writeFileString(path, body === '' ? '' : body + '\n')
  })

import { Clock } from 'effect'
import { stampDraft, type Draft } from './entry'

const recordDraft = (
  fs: FileSystem.FileSystem,
  path: string,
  draft: Draft,
): Effect.Effect<Entry, unknown> =>
  Effect.gen(function* () {
    const entries = yield* readEntries(fs, path)
    const millis = yield* Clock.currentTimeMillis
    const nextSeq = Array.reduce(entries, 0, (max, entry) => (entry.seq > max ? entry.seq : max)) + 1
    const entry = stampDraft(draft, nextSeq, new Date(millis).toISOString())
    yield* writeEntries(fs, path, [...entries, entry])
    return entry
  })

export const resolveEntry = (
  fs: FileSystem.FileSystem,
  path: string,
  seq: number,
): Effect.Effect<void, unknown> =>
  Effect.gen(function* () {
    const entries = yield* readEntries(fs, path)
    const updated = Array.map(entries, (entry) =>
      entry.seq === seq ? { ...entry, addressed: true } : entry,
    )
    yield* writeEntries(fs, path, updated)
  })

export const discardEntry = (
  fs: FileSystem.FileSystem,
  path: string,
  seq: number,
): Effect.Effect<void, unknown> =>
  Effect.gen(function* () {
    const entries = yield* readEntries(fs, path)
    yield* writeEntries(
      fs,
      path,
      Array.filter(entries, (entry) => entry.seq !== seq),
    )
  })

const editEntry = (
  fs: FileSystem.FileSystem,
  path: string,
  seq: number,
  text: string,
): Effect.Effect<void, unknown> =>
  Effect.gen(function* () {
    const entries = yield* readEntries(fs, path)
    const updated = Array.map(entries, (entry) =>
      entry.seq === seq ? { ...entry, text } : entry,
    )
    yield* writeEntries(fs, path, updated)
  })

import { Context, Layer } from 'effect'

export class FeedbackLog extends Context.Service<FeedbackLog>()('FeedbackLog', {
  make: Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Effect.sync(logPath)
    return {
      list: readEntries(fs, path),
      record: (draft: Draft) => recordDraft(fs, path, draft),
      resolve: (seq: number) => resolveEntry(fs, path, seq),
      discard: (seq: number) => discardEntry(fs, path, seq),
      edit: (seq: number, text: string) => editEntry(fs, path, seq, text),
    }
  }),
}) {
  static readonly layer = Layer.effect(this, this.make)
}
