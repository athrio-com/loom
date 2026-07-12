import { Array, Effect, Schema as S } from 'effect'
import { Tool, Toolkit } from 'effect/unstable/ai'
import { NoteSchema } from '@athrio/loom-notes/note'
import { NoteStore } from './store'

const listProjects = Tool.make('list_projects', {
  description: 'List the projects that have notes.',
  success: S.Array(S.String),
})

const listOpenNotes = Tool.make('list_open_notes', {
  description: "List a project's open, unaddressed notes, in the order they were made.",
  parameters: S.Struct({ project: S.String }),
  success: S.Array(NoteSchema),
})

const resolve = Tool.make('resolve', {
  description: 'Mark a note addressed, once you have dealt with it.',
  parameters: S.Struct({ project: S.String, seq: S.Number }),
})

const discard = Tool.make('discard', {
  description: 'Discard a note that no longer applies.',
  parameters: S.Struct({ project: S.String, seq: S.Number }),
})

export const toolkit = Toolkit.make(listProjects, listOpenNotes, resolve, discard)

export const handlers = toolkit.toLayer(
  Effect.gen(function* () {
    const store = yield* NoteStore
    return {
      list_projects: () => store.projects,
      list_open_notes: ({ project }) =>
        store.list(project).pipe(
          Effect.map((notes) => Array.filter(notes, (note) => !note.addressed)),
          Effect.orDie,
        ),
      resolve: ({ project, seq }) => store.resolve(project, seq).pipe(Effect.orDie),
      discard: ({ project, seq }) => store.discard(project, seq),
    }
  }),
)
