import { Effect, Option } from 'effect'
import { Database } from 'bun:sqlite'
import { homedir } from 'node:os'
import { join } from 'node:path'

const storeDirectory = (): string =>
  Option.match(Option.fromNullishOr(process.env.LOOM_NOTES_DIR), {
    onSome: (directory) => directory,
    onNone: () => join(homedir(), '.loom'),
  })

const openDatabase = (path: string) =>
  Effect.acquireRelease(
    Effect.sync(() => new Database(path)),
    (database) => Effect.sync(() => database.close()),
  )

const createTable = `CREATE TABLE IF NOT EXISTS notes (
  project TEXT NOT NULL,
  seq INTEGER NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (project, seq)
)`

import { Schema } from 'effect'
import { NoteSchema, type Note } from '@athrio/loom-notes/note'

const decodeNote = (data: string): Effect.Effect<Note, unknown> =>
  Effect.try(() => JSON.parse(data) as unknown).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(NoteSchema)),
  )

const readNotes = (
  database: Database,
  project: string,
): Effect.Effect<ReadonlyArray<Note>, unknown> =>
  Effect.sync(
    () =>
      database
        .query('SELECT data FROM notes WHERE project = ? ORDER BY seq')
        .all(project) as ReadonlyArray<{ readonly data: string }>,
  ).pipe(Effect.flatMap((rows) => Effect.forEach(rows, (row) => decodeNote(row.data))))

import { Clock } from 'effect'
import { stampDraft, type Draft } from '@athrio/loom-notes/note'

const recordDraft = (
  database: Database,
  draft: Draft,
): Effect.Effect<Note, unknown> =>
  Effect.gen(function* () {
    const millis = yield* Clock.currentTimeMillis
    const highest = yield* Effect.sync(
      () =>
        database
          .query('SELECT MAX(seq) AS seq FROM notes WHERE project = ?')
          .get(draft.project) as { readonly seq: number | null },
    )
    const note = stampDraft(draft, (highest.seq ?? 0) + 1, new Date(millis).toISOString())
    yield* Effect.sync(() =>
      database
        .query('INSERT INTO notes (project, seq, data) VALUES (?, ?, ?)')
        .run(note.project, note.seq, JSON.stringify(note)),
    )
    return note
  })

const modifyNote = (
  database: Database,
  project: string,
  seq: number,
  change: (note: Note) => Note,
): Effect.Effect<void, unknown> =>
  Effect.gen(function* () {
    const row = yield* Effect.sync(
      () =>
        database
          .query('SELECT data FROM notes WHERE project = ? AND seq = ?')
          .get(project, seq) as { readonly data: string } | null,
    )
    yield* Option.match(Option.fromNullishOr(row), {
      onNone: () => Effect.void,
      onSome: (found) =>
        decodeNote(found.data).pipe(
          Effect.map(change),
          Effect.flatMap((updated) =>
            Effect.sync(() =>
              database
                .query('UPDATE notes SET data = ? WHERE project = ? AND seq = ?')
                .run(JSON.stringify(updated), project, seq),
            ),
          ),
        ),
    })
  })

const resolveNote = (database: Database, project: string, seq: number) =>
  modifyNote(database, project, seq, (note) => ({ ...note, addressed: true }))

const editNote = (database: Database, project: string, seq: number, text: string) =>
  modifyNote(database, project, seq, (note) => ({ ...note, text }))

const discardNote = (database: Database, project: string, seq: number): Effect.Effect<void> =>
  Effect.sync(() => {
    database.query('DELETE FROM notes WHERE project = ? AND seq = ?').run(project, seq)
  })

import { Array } from 'effect'

const listProjects = (database: Database): Effect.Effect<ReadonlyArray<string>> =>
  Effect.sync(
    () =>
      database
        .query('SELECT DISTINCT project FROM notes ORDER BY project')
        .all() as ReadonlyArray<{ readonly project: string }>,
  ).pipe(Effect.map((rows) => Array.map(rows, (row) => row.project)))

import { Context, FileSystem, Layer } from 'effect'

export class NoteStore extends Context.Service<NoteStore>()('NoteStore', {
  make: Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const directory = storeDirectory()
    yield* fs.makeDirectory(directory, { recursive: true })
    const database = yield* openDatabase(join(directory, 'notes.db'))
    yield* Effect.sync(() => database.run(createTable))
    return {
      list: (project: string) => readNotes(database, project),
      record: (draft: Draft) => recordDraft(database, draft),
      resolve: (project: string, seq: number) => resolveNote(database, project, seq),
      edit: (project: string, seq: number, text: string) => editNote(database, project, seq, text),
      discard: (project: string, seq: number) => discardNote(database, project, seq),
      projects: listProjects(database),
    } as const
  }),
}) {
  static readonly layer = Layer.effect(this, this.make)
}
