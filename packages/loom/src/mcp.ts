import { Array, Effect, Schema as S } from 'effect'
import { Tool, Toolkit } from 'effect/unstable/ai'
import { NoteSchema } from '@athrio/loom-notes/note'
import { NoteStore } from './store'

const projects = Tool.make('projects', {
  description: 'List the projects the store holds, each with its id and name.',
  success: S.Struct({ projects: S.Array(S.Struct({ id: S.String, name: S.String })) }),
})

const notes = Tool.make('notes', {
  description: "List a project's open, unaddressed notes, in the order they were made.",
  parameters: S.Struct({ project: S.String }),
  success: S.Struct({ notes: S.Array(NoteSchema) }),
})

const acknowledgement = S.Struct({ ok: S.Boolean })

const resolve = Tool.make('resolve', {
  description: 'Mark a note addressed, once you have dealt with it.',
  parameters: S.Struct({ project: S.String, seq: S.Number }),
  success: acknowledgement,
})

const discard = Tool.make('discard', {
  description: 'Discard a note that no longer applies.',
  parameters: S.Struct({ project: S.String, seq: S.Number }),
  success: acknowledgement,
})

export const toolkit = Toolkit.make(projects, notes, resolve, discard)

export const handlers = toolkit.toLayer(
  Effect.gen(function* () {
    const store = yield* NoteStore
    return {
      projects: () => store.projects.pipe(Effect.map((list) => ({ projects: list }))),
      notes: ({ project }) =>
        store.list(project).pipe(
          Effect.map((list) => ({ notes: Array.filter(list, (note) => !note.addressed) })),
          Effect.orDie,
        ),
      resolve: ({ project, seq }) => store.resolve(project, seq).pipe(Effect.orDie, Effect.as({ ok: true })),
      discard: ({ project, seq }) => store.discard(project, seq).pipe(Effect.as({ ok: true })),
    }
  }),
)
