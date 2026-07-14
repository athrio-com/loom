import { Schema } from 'effect'

const noteFields = {
  project: Schema.String,
  route: Schema.String,
  text: Schema.String,
}

export const RectSchema = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
  width: Schema.Number,
  height: Schema.Number,
})
export type Rect = typeof RectSchema.Type

const elementFields = {
  ...noteFields,
  label: Schema.String,
  rect: RectSchema,
}

const domFields = {
  kind: Schema.tag('dom'),
  ...elementFields,
  selector: Schema.String,
}

export const LoomSourceSchema = Schema.Struct({
  chapter: Schema.String,
  section: Schema.String,
})
export type LoomSource = typeof LoomSourceSchema.Type

const loomFields = {
  kind: Schema.tag('loom'),
  ...elementFields,
  source: LoomSourceSchema,
}

const chatFields = {
  kind: Schema.tag('chat'),
  ...noteFields,
}

export const DomDraftSchema = Schema.Struct(domFields)
export const LoomDraftSchema = Schema.Struct(loomFields)
export const ChatDraftSchema = Schema.Struct(chatFields)
export const DraftSchema = Schema.Union([DomDraftSchema, LoomDraftSchema, ChatDraftSchema])
export type Draft = typeof DraftSchema.Type

const stamp = {
  seq: Schema.Number,
  at: Schema.String,
  addressed: Schema.Boolean,
}

export const DomNoteSchema = Schema.Struct({ ...domFields, ...stamp })
export const LoomNoteSchema = Schema.Struct({ ...loomFields, ...stamp })
export const ChatNoteSchema = Schema.Struct({ ...chatFields, ...stamp })
export const NoteSchema = Schema.Union([DomNoteSchema, LoomNoteSchema, ChatNoteSchema])
export type Note = typeof NoteSchema.Type

import { Match } from 'effect'

export const stampDraft = (draft: Draft, seq: number, at: string): Note =>
  Match.value(draft).pipe(
    Match.when({ kind: 'dom' }, (annotation) =>
      DomNoteSchema.make({ ...annotation, seq, at, addressed: false }),
    ),
    Match.when({ kind: 'loom' }, (annotation) =>
      LoomNoteSchema.make({ ...annotation, seq, at, addressed: false }),
    ),
    Match.when({ kind: 'chat' }, (message) =>
      ChatNoteSchema.make({ ...message, seq, at, addressed: false }),
    ),
    Match.exhaustive,
  )
