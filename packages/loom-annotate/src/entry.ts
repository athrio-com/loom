import { Match, Schema } from 'effect'

export const RectSchema = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
  width: Schema.Number,
  height: Schema.Number,
})
export type Rect = typeof RectSchema.Type

const annotationFields = {
  kind: Schema.tag('annotation'),
  route: Schema.String,
  text: Schema.String,
  selector: Schema.String,
  label: Schema.String,
  rect: RectSchema,
}

const messageFields = {
  kind: Schema.tag('message'),
  route: Schema.String,
  text: Schema.String,
}

export const AnnotationDraftSchema = Schema.Struct(annotationFields)
export const MessageDraftSchema = Schema.Struct(messageFields)
export const DraftSchema = Schema.Union([AnnotationDraftSchema, MessageDraftSchema])
export type Draft = typeof DraftSchema.Type

const stamp = {
  seq: Schema.Number,
  at: Schema.String,
  addressed: Schema.Boolean,
}

export const AnnotationSchema = Schema.Struct({ ...annotationFields, ...stamp })
export const MessageSchema = Schema.Struct({ ...messageFields, ...stamp })
export const EntrySchema = Schema.Union([AnnotationSchema, MessageSchema])
export type Entry = typeof EntrySchema.Type

export const stampDraft = (
  draft: Draft,
  seq: number,
  at: string,
): Entry =>
  Match.value(draft).pipe(
    Match.when({ kind: 'annotation' }, (a) =>
      AnnotationSchema.make({ ...a, seq, at, addressed: false }),
    ),
    Match.when({ kind: 'message' }, (m) =>
      MessageSchema.make({ ...m, seq, at, addressed: false }),
    ),
    Match.exhaustive,
  )
