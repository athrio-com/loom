import { Config, Effect, Layer, Option } from 'effect'
import { SqlClient, SqlError } from 'effect/unstable/sql'
import { PgClient } from '@effect/sql-pg'

export const PgLive = PgClient.layerConfig({
  url: Config.redacted('DATABASE_URL'),
}).pipe(Layer.orDie)

import { Data } from 'effect'

class DecodeError extends Data.TaggedError('DecodeError')<{
  readonly data: string
  readonly cause: unknown
}> {}

const migrations: ReadonlyArray<{
  readonly id: number
  readonly name: string
  readonly run: (sql: SqlClient.SqlClient) => Effect.Effect<void, SqlError.SqlError>
}> = [
  {
    id: 1,
    name: 'initial',
    run: (sql) =>
      Effect.gen(function* () {
        yield* sql`CREATE TABLE IF NOT EXISTS notes (
          project TEXT NOT NULL,
          seq INTEGER NOT NULL,
          data TEXT NOT NULL,
          PRIMARY KEY (project, seq)
        )`
        yield* sql`CREATE TABLE IF NOT EXISTS projects (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL
        )`
      }),
  },
]

const migrate = (sql: SqlClient.SqlClient): Effect.Effect<void, SqlError.SqlError> =>
  Effect.gen(function* () {
    yield* sql`CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`
    const applied = yield* sql<{ readonly id: number }>`SELECT id FROM _migrations`
    const done = new Set(applied.map((row) => row.id))
    const pending = migrations.filter((migration) => !done.has(migration.id))
    yield* Effect.forEach(
      pending,
      (migration) =>
        sql.withTransaction(
          migration
            .run(sql)
            .pipe(
              Effect.andThen(
                sql`INSERT INTO _migrations (id, name) VALUES (${migration.id}, ${migration.name})`,
              ),
            ),
        ),
      { discard: true },
    )
  })

import { Array, Schema } from 'effect'
import { NoteSchema, type Note } from './note'

const decodeNote = (data: string): Effect.Effect<Note, DecodeError> =>
  Effect.try({
    try: () => JSON.parse(data) as unknown,
    catch: (cause) => new DecodeError({ data, cause }),
  }).pipe(
    Effect.flatMap((json) =>
      Schema.decodeUnknownEffect(NoteSchema)(json).pipe(
        Effect.mapError((cause) => new DecodeError({ data, cause })),
      ),
    ),
  )

const readNotes = (
  sql: SqlClient.SqlClient,
  project: string,
): Effect.Effect<ReadonlyArray<Note>, SqlError.SqlError> =>
  sql<{ readonly data: string }>`
    SELECT data FROM notes WHERE project = ${project} ORDER BY seq
  `.pipe(
    Effect.flatMap((rows) =>
      Effect.forEach(rows, (row) =>
        decodeNote(row.data).pipe(
          Effect.tapError((error) =>
            Effect.logWarning('skipping a note that no longer decodes', error),
          ),
          Effect.map(Option.some),
          Effect.catchTag('DecodeError', () => Effect.succeed(Option.none<Note>())),
        ),
      ),
    ),
    Effect.map(Array.getSomes),
  )

import { Clock } from 'effect'
import { stampDraft, type Draft } from './note'

const recordDraft = (
  sql: SqlClient.SqlClient,
  draft: Draft,
): Effect.Effect<Note, SqlError.SqlError> =>
  sql.withTransaction(
    Effect.gen(function* () {
      const millis = yield* Clock.currentTimeMillis
      const rows = yield* sql<{ readonly max: number | null }>`
        SELECT MAX(seq) AS max FROM notes WHERE project = ${draft.project}
      `
      const highest = Option.match(Option.fromNullishOr(rows[0]?.max), {
        onSome: (seq) => seq,
        onNone: () => 0,
      })
      const note = stampDraft(draft, highest + 1, new Date(millis).toISOString())
      yield* sql`
        INSERT INTO notes (project, seq, data)
        VALUES (${note.project}, ${note.seq}, ${JSON.stringify(note)})
      `
      return note
    }),
  )

const modifyNote = (
  sql: SqlClient.SqlClient,
  project: string,
  seq: number,
  change: (note: Note) => Note,
): Effect.Effect<void, SqlError.SqlError | DecodeError> =>
  Effect.gen(function* () {
    const rows = yield* sql<{ readonly data: string }>`
      SELECT data FROM notes WHERE project = ${project} AND seq = ${seq}
    `
    yield* Option.match(Option.fromNullishOr(rows[0]), {
      onNone: () => Effect.void,
      onSome: (row) =>
        decodeNote(row.data).pipe(
          Effect.map(change),
          Effect.flatMap((updated) =>
            sql`
              UPDATE notes SET data = ${JSON.stringify(updated)}
              WHERE project = ${project} AND seq = ${seq}
            `,
          ),
        ),
    })
  })

const resolveNote = (sql: SqlClient.SqlClient, project: string, seq: number) =>
  modifyNote(sql, project, seq, (note) => ({ ...note, addressed: true }))

const editNote = (sql: SqlClient.SqlClient, project: string, seq: number, text: string) =>
  modifyNote(sql, project, seq, (note) => ({ ...note, text }))

const discardNote = (
  sql: SqlClient.SqlClient,
  project: string,
  seq: number,
): Effect.Effect<void, SqlError.SqlError> =>
  sql`DELETE FROM notes WHERE project = ${project} AND seq = ${seq}`.pipe(Effect.asVoid)

type Project = { readonly id: string; readonly name: string }

const listProjects = (
  sql: SqlClient.SqlClient,
): Effect.Effect<ReadonlyArray<Project>, SqlError.SqlError> =>
  sql<Project>`SELECT id, name FROM projects ORDER BY name`

const ensureProject = (
  sql: SqlClient.SqlClient,
  id: string,
): Effect.Effect<void, SqlError.SqlError> =>
  sql`
    INSERT INTO projects (id, name) VALUES (${id}, ${id})
    ON CONFLICT (id) DO NOTHING
  `.pipe(Effect.asVoid)

const backfillProjects = (sql: SqlClient.SqlClient): Effect.Effect<void, SqlError.SqlError> =>
  sql`
    INSERT INTO projects (id, name)
    SELECT DISTINCT project, project FROM notes
    ON CONFLICT (id) DO NOTHING
  `.pipe(Effect.asVoid)

import { Context } from 'effect'

export class NoteStore extends Context.Service<NoteStore>()('NoteStore', {
  make: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* migrate(sql)
    yield* backfillProjects(sql)
    return {
      list: (project: string) => readNotes(sql, project),
      record: (draft: Draft) =>
        ensureProject(sql, draft.project).pipe(Effect.andThen(recordDraft(sql, draft))),
      resolve: (project: string, seq: number) => resolveNote(sql, project, seq),
      edit: (project: string, seq: number, text: string) => editNote(sql, project, seq, text),
      discard: (project: string, seq: number) => discardNote(sql, project, seq),
      projects: listProjects(sql),
    } as const
  }).pipe(Effect.orDie),
}) {
  static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(PgLive))
}
