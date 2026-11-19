// Hello! This is the beginning of the Loom language.

import { Option, Schema } from 'effect'

const intAtLeast = (min: number) =>
  Schema.makeFilter<number>((n) =>
    Number.isInteger(n) && n >= min ? undefined : `must be an integer >= ${min}`,
  )

export const PointSchema = Schema.Struct({
  line: Schema.Number.check(intAtLeast(1)),
  column: Schema.optional(Schema.Number.check(intAtLeast(1))),
  offset: Schema.Number.check(intAtLeast(0)),
})
export type Point = typeof PointSchema.Type

export const PositionSchema = Schema.Struct({
  start: PointSchema,
  end: PointSchema,
})
export type Position = typeof PositionSchema.Type

export const shifted = (point: Point, by: number): Point =>
  Option.match(Option.fromNullishOr(point.column), {
    onNone: () => ({ ...point, offset: point.offset + by }),
    onSome: (column) => ({ ...point, offset: point.offset + by, column: column + by }),
  })

export const SeveritySchema = Schema.Literals(['error', 'warning', 'info'])
export type Severity = typeof SeveritySchema.Type

export const FixSchema = Schema.Struct({
  title: Schema.String,
  text: Schema.String,
  at: Schema.optional(PositionSchema),
  file: Schema.optional(Schema.String),
})
export type Fix = typeof FixSchema.Type

export const DiagnosticSchema = Schema.Struct({
  message: Schema.String,
  position: PositionSchema,
  severity: SeveritySchema,
  fixes: Schema.optional(Schema.Array(FixSchema)),
})
export type Diagnostic = typeof DiagnosticSchema.Type

export const HealthStatusSchema = Schema.Literals(['ok', 'error', 'warning', 'incomplete'])
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
  type: Schema.tag('UnexpectedToken'),
  position: PositionSchema,
  value: Schema.String,
})
export type UnexpectedToken = typeof UnexpectedTokenSchema.Type

export const loomNode = <Tag extends string, Fields extends Schema.Struct.Fields>(
  tag: Tag,
  fields: Fields,
) =>
  Schema.Struct({
    type: Schema.tag(tag),
    position: PositionSchema,
    source: Schema.String,
    health: HealthSchema,
    unexpected: Schema.optional(Schema.Array(UnexpectedTokenSchema)),
    ...fields,
  })

type Tagged = { readonly type: string }

export type NodeSchema<Node extends Tagged> = {
  readonly Type: Node
  readonly fields: { readonly type: { readonly schema: { readonly literal: Node['type'] } } }
}

export const nodeOf = <Node extends Tagged>(
  schema: NodeSchema<Node>,
  fields: Omit<Node, 'type'>,
): Node => ({ ...fields, type: schema.fields.type.schema.literal }) as Node

export type Cases<Node extends Tagged, Args extends ReadonlyArray<unknown>, Result> = {
  readonly [Tag in Node['type']]: (
    node: Extract<Node, { readonly type: Tag }>,
    ...args: Args
  ) => Result
}

export const byType =
  <Node extends Tagged, Args extends ReadonlyArray<unknown> = []>() =>
  <Result>(cases: Cases<Node, Args, Result>) =>
  (node: Node, ...args: Args): Result =>
    (cases[node.type as Node['type']] as (node: Node, ...args: Args) => Result)(node, ...args)

export const byTypeOr =
  <Node extends Tagged, Args extends ReadonlyArray<unknown> = []>() =>
  <Result>(
    cases: Partial<Cases<Node, Args, Result>>,
    otherwise: (node: Node, ...args: Args) => Result,
  ) =>
  (node: Node, ...args: Args): Result =>
    (Object.prototype.hasOwnProperty.call(cases, node.type)
      ? (cases[node.type as Node['type']] as (node: Node, ...args: Args) => Result)
      : otherwise)(node, ...args)
