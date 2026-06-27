import { Schema } from 'effect'

export const PointSchema = Schema.Struct({
  line: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(1)),
  column: Schema.optional(
    Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(1)),
  ),
  offset: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)),
})
export type Point = typeof PointSchema.Type

export const PositionSchema = Schema.Struct({
  start: PointSchema,
  end: PointSchema,
})
export type Position = typeof PositionSchema.Type

export const SeveritySchema = Schema.Literal('error', 'warning', 'info')
export type Severity = typeof SeveritySchema.Type

export const DiagnosticSchema = Schema.Struct({
  message: Schema.String,
  position: PositionSchema,
  severity: SeveritySchema,
})
export type Diagnostic = typeof DiagnosticSchema.Type

export const HealthStatusSchema = Schema.Literal(
  'ok',
  'error',
  'warning',
  'incomplete',
)
export type HealthStatus = typeof HealthStatusSchema.Type

export const HealthSchema = Schema.Struct({
  status: HealthStatusSchema,
  diagnostics: Schema.Array(DiagnosticSchema),
})
export type Health = typeof HealthSchema.Type

export const okHealth: Health = { status: 'ok', diagnostics: [] }

export const incompleteHealth: Health = {
  status: 'incomplete',
  diagnostics: [],
}

export const UnexpectedTokenSchema = Schema.Struct({
  type: Schema.Literal('UnexpectedToken').pipe(
    Schema.propertySignature,
    Schema.withConstructorDefault(() => 'UnexpectedToken' as const),
  ),
  position: PositionSchema,
  value: Schema.String,
})
export type UnexpectedToken = typeof UnexpectedTokenSchema.Type

export const loomNode = <
  Tag extends string,
  Fields extends Schema.Struct.Fields,
>(
  tag: Tag,
  fields: Fields,
) =>
  Schema.Struct({
    type: Schema.Literal(tag).pipe(
      Schema.propertySignature,
      Schema.withConstructorDefault(() => tag),
    ),
    position: PositionSchema,
    source: Schema.String,
    health: HealthSchema,
    unexpected: Schema.optional(Schema.Array(UnexpectedTokenSchema)),
    ...fields,
  })
