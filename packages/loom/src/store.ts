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

const createNotes = `CREATE TABLE IF NOT EXISTS notes (
  project TEXT NOT NULL,
  seq INTEGER NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (project, seq)
)`

const createProjects = `CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT
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

type Project = { readonly id: string; readonly name: string }

const listProjects = (database: Database): Effect.Effect<ReadonlyArray<Project>> =>
  Effect.sync(
    () => database.query('SELECT id, name FROM projects ORDER BY name').all() as ReadonlyArray<Project>,
  )

const ensureProject = (database: Database, id: string): Effect.Effect<void> =>
  Effect.sync(() => {
    database.query('INSERT OR IGNORE INTO projects (id, name) VALUES (?, ?)').run(id, id)
  })

const backfillProjects = (database: Database): Effect.Effect<void> =>
  Effect.sync(() => {
    database.run('INSERT OR IGNORE INTO projects (id, name) SELECT DISTINCT project, project FROM notes')
  })

const renameProject = (database: Database, id: string, name: string): Effect.Effect<void> =>
  Effect.sync(() => {
    database.query('UPDATE projects SET name = ? WHERE id = ?').run(name, id)
  })

const registerProject = (database: Database, id: string, path: string): Effect.Effect<void> =>
  Effect.sync(() => {
    database
      .query(
        'INSERT INTO projects (id, name, path) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET path = excluded.path',
      )
      .run(id, id, path)
  })

import { Context, FileSystem, Layer } from 'effect'

export class NoteStore extends Context.Service<NoteStore>()('NoteStore', {
  make: Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const directory = storeDirectory()
    yield* fs.makeDirectory(directory, { recursive: true })
    const database = yield* openDatabase(join(directory, 'notes.db'))
    yield* Effect.sync(() => database.run('PRAGMA journal_mode = WAL'))
    yield* Effect.sync(() => database.run(createNotes))
    yield* Effect.sync(() => database.run(createProjects))
    yield* backfillProjects(database)
    return {
      list: (project: string) => readNotes(database, project),
      record: (draft: Draft) =>
        ensureProject(database, draft.project).pipe(Effect.andThen(recordDraft(database, draft))),
      resolve: (project: string, seq: number) => resolveNote(database, project, seq),
      edit: (project: string, seq: number, text: string) => editNote(database, project, seq, text),
      discard: (project: string, seq: number) => discardNote(database, project, seq),
      projects: listProjects(database),
      rename: (id: string, name: string) => renameProject(database, id, name),
      register: (id: string, path: string) => registerProject(database, id, path),
    } as const
  }),
}) {
  static readonly layer = Layer.effect(this, this.make)
}
