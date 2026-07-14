import { Array, Effect, Schema as S } from 'effect'
import { AiError, Tool, Toolkit } from 'effect/unstable/ai'
import { NoteSchema } from './note'
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

const surface = <A, E>(tool: string, work: Effect.Effect<A, E>): Effect.Effect<A, AiError.UnknownError> =>
  work.pipe(
    Effect.tapError((error) => Effect.logError(`the ${tool} tool could not reach the store`, error)),
    Effect.mapError(() => new AiError.UnknownError({ description: `the ${tool} tool could not reach the store` })),
  )

export const handlers = toolkit.toLayer(
  Effect.gen(function* () {
    const store = yield* NoteStore
    return {
      projects: () => surface('projects', store.projects).pipe(Effect.map((list) => ({ projects: list }))),
      notes: ({ project }) =>
        surface('notes', store.list(project)).pipe(
          Effect.map((list) => ({ notes: Array.filter(list, (note) => !note.addressed) })),
        ),
      resolve: ({ project, seq }) =>
        surface('resolve', store.resolve(project, seq)).pipe(Effect.as({ ok: true })),
      discard: ({ project, seq }) =>
        surface('discard', store.discard(project, seq)).pipe(Effect.as({ ok: true })),
    }
  }),
)
